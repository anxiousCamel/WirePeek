/* eslint-env browser */
/**
 * Preload do <webview> (convidado)
 * --------------------------------
 * - Roda dentro do processo do webview, antes do site.
 * - Instrumenta fetch / XHR / WebSocket para emitir eventos de captura.
 * - Envia os eventos para o host (renderer pai) via ipcRenderer.sendToHost.
 * - Usa wrappers com try/catch para NUNCA quebrar o convidado se algo falhar.
 *
 * Eventos emitidos (todos via sendToHost):
 *  - "cap:rest:request"  { ts, url, method, reqHeaders, reqBody? }
 *  - "cap:rest:response" { ts, url, method, status, statusText, resHeaders, bodySize, timingMs }
 *  - "cap:rest:error"    { ts, url, method, reqHeaders }
 *  - "cap:ws:open"       { ts, id, url, protocols? }
 *  - "cap:ws:msg"        { ts, id, dir: "in"|"out", data }
 *  - "cap:ws:close"      { ts, id, code, reason }
 *  - "cap:ws:error"      { ts, id }
 */

import { ipcRenderer, contextBridge } from "electron";

/* ============================================================================
 * Utilidades
 * ========================================================================== */

/** Envia para o host sem jamais lançar exceção (evita crash do guest). */
function safeSend(channel: string, payload: unknown): void {
    try {
        ipcRenderer.sendToHost(channel, payload);
    } catch (err) {
        // Isso aparece no host se você ouvir "console-message" no <webview>.
        // Útil para debug caso o pipe esteja indisponível.
        // console.debug("[cap] safeSend failed:", channel, err);
    }
}

type HeaderInitLike = Headers | Record<string, string> | string[][];

/** Normaliza Headers/HeadersInit/Record em { k: v } (lowercase). */
function headersToObj(h?: HeaderInitLike): Record<string, string> {
    if (!h) return {};
    // Caso seja Headers
    if (typeof (h as Headers).forEach === "function") {
        const o: Record<string, string> = {};
        (h as Headers).forEach((v, k) => {
            o[String(k).toLowerCase()] = String(v);
        });
        return o;
    }
    // Caso seja string[][]
    if (Array.isArray(h)) {
        const o: Record<string, string> = {};
        for (const [k, v] of h) {
            if (k) o[String(k).toLowerCase()] = String(v ?? "");
        }
        return o;
    }
    // Caso seja Record<string,string>
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
}

/** Converte ArrayBuffer (ou view) em base64 para transporte legível. */
function abToBase64(ab: ArrayBufferLike): string {
    const bytes = new Uint8Array(ab);
    let bin = "";
    // evita "number | undefined"
    for (const b of bytes) {
        bin += String.fromCharCode(b);
    }
    // btoa lida com Latin1; para binário cru funciona para fins de log/transporte.
    return btoa(bin);
}


/* ============================================================================
 * fetch() - proxy com telemetria
 * ========================================================================== */

const __origFetch = window.fetch.bind(window);

window.fetch = async function fetchCaptured(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    // --------- URL e método ---------
    const reqUrl =
        typeof input === "string"
            ? input
            : input instanceof URL
                ? input.toString()
                : (input as Request).url;

    const method = (
        init?.method ||
        (typeof input !== "string" && !(input instanceof URL)
            ? (input as Request).method
            : "GET")
    ).toUpperCase();

    // --------- cabeçalhos da requisição ---------
    let reqHeaders: Record<string, string> = {};
    try {
        if (init?.headers) {
            const ih = init.headers as unknown;
            let hInit: HeadersInit = [];
            if (ih instanceof Headers || Array.isArray(ih) || typeof ih === "object") {
                hInit = ih as HeadersInit;
            }
            reqHeaders = headersToObj(new Headers(hInit));
        } else if (typeof input !== "string" && !(input instanceof URL)) {
            reqHeaders = headersToObj((input as Request).headers);
        }
    } catch {
        /* noop */
    }

    // --------- corpo da requisição (texto simples / URLSearchParams) ---------
    let reqBody: string | undefined;
    try {
        const b = init?.body as unknown;
        if (typeof b === "string") {
            reqBody = b;
        } else if (b instanceof URLSearchParams) {
            reqBody = b.toString();
        }
        // Observação: ler Blob/streams aqui consumiria o body do fetch
        // e pode quebrar a requisição; se precisar, avalie carefully.
    } catch {
        /* noop */
    }

    const tStart = Date.now();

    safeSend("cap:rest:request", {
        ts: tStart,
        url: reqUrl,
        method,
        reqHeaders,
        reqBody,
    });

    // --------- executa a requisição real ---------
    try {
        const resp = await __origFetch(input as RequestInfo, init);

        // Tamanho do corpo (sem materializar string): arrayBuffer é mais barato p/ medir
        let bodySize = 0;
        try {
            const buf = await resp.clone().arrayBuffer();
            bodySize = buf.byteLength;
        } catch {
            /* noop */
        }

        safeSend("cap:rest:response", {
            ts: Date.now(),
            url: reqUrl,
            method,
            status: resp.status,
            statusText: resp.statusText,
            resHeaders: headersToObj(resp.headers),
            bodySize,
            timingMs: Date.now() - tStart,
        });

        return resp;
    } catch (error) {
        safeSend("cap:rest:error", {
            ts: Date.now(),
            url: reqUrl,
            method,
            reqHeaders,
        });
        throw error;
    }
};

/* ============================================================================
 * XMLHttpRequest - proxy com telemetria
 * ========================================================================== */

interface XhrWithCap extends XMLHttpRequest {
    __cap?: {
        method: string;
        url: string;
        headers: Record<string, string>;
        tStart: number;
    };
}

(function patchXHR() {
    const proto = XMLHttpRequest.prototype;
    const _open = proto.open;
    const _send = proto.send;
    const _setHeader = proto.setRequestHeader;

    proto.open = function (
        this: XhrWithCap,
        method: string,
        url: string,
        async?: boolean,
        username?: string | null,
        password?: string | null
    ): void {
        this.__cap = { method: String(method || "GET").toUpperCase(), url, headers: {}, tStart: 0 };
        return _open.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    proto.setRequestHeader = function (this: XhrWithCap, k: string, v: string): void {
        try {
            if (!this.__cap) this.__cap = { method: "GET", url: "", headers: {}, tStart: 0 };
            this.__cap.headers[k.toLowerCase()] = v;
        } catch {
            /* noop */
        }
        return _setHeader.call(this, k, v);
    };

    proto.send = function (
        this: XhrWithCap,
        body?: Document | XMLHttpRequestBodyInit | null
    ): void {
        try {
            if (!this.__cap) this.__cap = { method: "GET", url: "", headers: {}, tStart: 0 };
            this.__cap.tStart = Date.now();

            safeSend("cap:rest:request", {
                ts: this.__cap.tStart,
                url: this.__cap.url,
                method: this.__cap.method,
                reqHeaders: this.__cap.headers,
                reqBody: typeof body === "string" ? body : undefined,
            });

            this.addEventListener("readystatechange", () => {
                if (this.readyState === 4) {
                    const tEnd = Date.now();

                    // Parse básico dos headers de resposta
                    const resHeaders: Record<string, string> = {};
                    try {
                        const raw = this.getAllResponseHeaders() || "";
                        raw
                            .trim()
                            .split(/[\r\n]+/)
                            .forEach((line) => {
                                const idx = line.indexOf(":");
                                if (idx > 0) {
                                    const k = line.slice(0, idx).toLowerCase();
                                    const v = line.slice(idx + 1).trim();
                                    resHeaders[k] = v;
                                }
                            });
                    } catch {
                        /* noop */
                    }

                    // Tamanho aproximado quando responseType = "" (texto)
                    // Para binários, você pode tratar responseType === "arraybuffer"/"blob" se quiser.
                    const size =
                        typeof this.responseText === "string" ? this.responseText.length : 0;

                    safeSend("cap:rest:response", {
                        ts: tEnd,
                        url: this.__cap!.url,
                        method: this.__cap!.method,
                        status: this.status,
                        statusText: this.statusText || "",
                        resHeaders,
                        bodySize: size,
                        timingMs: tEnd - this.__cap!.tStart,
                    });
                }
            });

            this.addEventListener("error", () => {
                safeSend("cap:rest:error", {
                    ts: Date.now(),
                    url: this.__cap?.url || "",
                    method: this.__cap?.method || "GET",
                    reqHeaders: this.__cap?.headers || {},
                });
            });
        } catch {
            /* noop */
        }

        //tipagem explícita, sem "any"
        return _send.call(
            this,
            (body ?? null) as Document | XMLHttpRequestBodyInit | null
        );

    };
})();

/* ============================================================================
 * WebSocket - proxy com telemetria
 * ========================================================================== */

(function patchWS() {
    const OrigWS = window.WebSocket;

    class CapturedWebSocket extends OrigWS {
        constructor(url: string | URL, protocols?: string | string[]) {
            const urlStr = typeof url === "string" ? url : url.toString();
            super(urlStr, protocols);

            const id = Math.random().toString(36).slice(2);

            safeSend("cap:ws:open", {
                ts: Date.now(),
                id,
                url: urlStr,
                protocols,
            });

            // Mensagens recebidas
            this.addEventListener("message", (ev: MessageEvent) => {
                try {
                    const data = ev.data as unknown;
                    let repr: string;
                    if (data instanceof ArrayBuffer) {
                        repr = `base64:${abToBase64(data)}`;
                    } else if (ArrayBuffer.isView(data)) {
                        repr = `base64:${abToBase64((data as ArrayBufferView).buffer)}`;
                    } else {
                        repr = String(data);
                    }
                    safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "in", data: repr });
                } catch {
                    /* noop */
                }
            });

            // Mensagens enviadas
            const origSend = this.send as (
                this: WebSocket,
                data: string | ArrayBufferLike | Blob | ArrayBufferView
            ) => void;

            // type guard pra evitar "as" espalhado
            function isArrayBufferView(x: unknown): x is ArrayBufferView {
                return x != null && typeof x === "object" && ArrayBuffer.isView(x as ArrayBufferView);
            }

            this.send = function (
                this: WebSocket,
                data: string | ArrayBufferLike | Blob | ArrayBufferView
            ): void {
                try {
                    let repr: string;

                    // Se for binário, converte para base64
                    if (data instanceof ArrayBuffer || isArrayBufferView(data)) {
                        const buf: ArrayBufferLike =
                            data instanceof ArrayBuffer ? data : data.buffer;
                        repr = `base64:${abToBase64(buf)}`;
                    } else {
                        // Texto (inclui strings e Blobs tratados pelo próprio WS)
                        repr = String(data);
                    }

                    safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "out", data: repr });
                } catch {
                    /* noop */
                }

                // chama o send original preservando o this correto e sem 'any'
                Reflect.apply(origSend, this, [data]);
            };
        }
    }

    // Substitui o global de forma segura
    Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: CapturedWebSocket,
    });
})();

/* ============================================================================
 * Sinal leve de diagnóstico no convidado
 * ========================================================================== */

contextBridge.exposeInMainWorld("__cap_active", true);
