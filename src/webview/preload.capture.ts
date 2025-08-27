/* eslint-env browser */
/**
 * @file src/webview/preload.capture.ts
 * @brief Preload que roda dentro do processo do <webview> (convidado).
 *
 * Responsabilidades:
 *  - Instrumentar fetch / XHR / WebSocket (e opcionalmente SSE/Beacon).
 *  - Emitir eventos de captura para o host via `ipcRenderer.sendToHost(...)`.
 *  - Ser resiliente: nunca quebrar a página convidada (try/catch em volta).
 *
 * Canais emitidos:
 *   - "cap:rest:request"  { ts, url, method, reqHeaders, reqBody? }
 *   - "cap:rest:response" { ts, url, method, status, statusText, resHeaders, bodySize, timingMs }
 *   - "cap:rest:error"    { ts, url, method, reqHeaders }
 *   - "cap:ws:open"       { ts, id, url, protocols? }
 *   - "cap:ws:msg"        { ts, id, dir: "in"|"out", data }
 *   - "cap:ws:close"      { ts, id, code, reason }
 *   - "cap:ws:error"      { ts, id }
 *   - "cap:sse:open"      { ts, url, withCredentials }
 *   - "cap:sse:msg"       { ts, url, data }
 *   - "cap:sse:error"     { ts, url }
 *   - "cap:beacon"        { ts, url, size }
 */

import { ipcRenderer, contextBridge } from "electron";

/* ============================================================================
 * Utilidades / helpers
 * ========================================================================== */

/**
 * @brief Envia um payload ao host sem deixar exceções vazarem (robustez).
 * @param channel Canal enviado ao host (renderer-pai).
 * @param payload Qualquer payload serializável.
 */
function safeSend(channel: string, payload: unknown): void {
    try {
        ipcRenderer.sendToHost(channel, payload);
    } catch (_err) {
        // Mantemos silêncio por padrão para não poluir console do convidado.
        // Satisfaz "no-empty":
        void 0;
    }
}

/** Conveniência local para o tipo do DOM. */
type HeaderInitLike = HeadersInit;

/**
 * @brief Normaliza Headers/HeadersInit/Record em { k: v } (lowercase).
 * @param h Estrutura de headers suportada pelo DOM.
 */
function headersToObj(h?: HeaderInitLike): Record<string, string> {
    if (!h) return {};
    // Headers
    if (h instanceof Headers) {
        const o: Record<string, string> = {};
        h.forEach((v, k) => {
            o[String(k).toLowerCase()] = String(v);
        });
        return o;
    }
    // string[][]
    if (Array.isArray(h)) {
        const o: Record<string, string> = {};
        for (const [k, v] of h) {
            if (k) o[String(k).toLowerCase()] = String(v ?? "");
        }
        return o;
    }
    // Record<string,string>
    if (typeof h === "object") {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
            out[k.toLowerCase()] = String(v);
        }
        return out;
    }
    return {};
}

/**
 * @brief Converte ArrayBuffer (ou view) em base64 para transporte legível.
 * @param ab Buffer ou view compatível.
 */
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

/**
 * @brief Wrapper de `window.fetch` que emite eventos de request/response.
 */
window.fetch = async function fetchCaptured(
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    // -------- URL & método ----------
    let reqUrl: string;
    let method: string;

    if (typeof input === "string" || input instanceof URL) {
        reqUrl = typeof input === "string" ? input : input.toString();
        method = (init?.method ?? "GET").toUpperCase();
    } else {
        // input é um Request
        const r = input as Request;
        reqUrl = r.url;
        method = (init?.method ?? r.method ?? "GET").toUpperCase();
    }

    // -------- cabeçalhos da requisição ----------
    let reqHeaders: Record<string, string> = {};
    try {
        if (init?.headers) {
            reqHeaders = headersToObj(init.headers);
        } else if (input instanceof Request) {
            reqHeaders = headersToObj(input.headers);
        }
    } catch (_e) {
        void 0;
    }

    // -------- corpo (texto simples / querystring) ----------
    let reqBody: string | undefined;
    try {
        const b = init?.body as unknown;
        if (typeof b === "string") {
            reqBody = b;
        } else if (b instanceof URLSearchParams) {
            reqBody = b.toString();
        }
        // Observação: ler Blob/streams aqui consome o body → risco de quebrar a request.
    } catch (_e) {
        void 0;
    }

    const tStart = Date.now();

    safeSend("cap:rest:request", {
        ts: tStart,
        url: reqUrl,
        method,
        reqHeaders,
        reqBody,
    });

    // -------- executa a requisição real ----------
    try {
        const resp = await __origFetch(input as RequestInfo, init);

        // Tamanho sem materializar string: `arrayBuffer()` é mais barato para medir
        let bodySize = 0;
        try {
            const buf = await resp.clone().arrayBuffer();
            bodySize = buf.byteLength;
        } catch (_e) {
            void 0;
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

/** Estado interno guardado por instância de XHR. */
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

    // Tipagens explícitas dos métodos originais (evita casts depois)
    const _open: (
        this: XMLHttpRequest,
        method: string,
        url: string,
        async?: boolean,
        username?: string | null,
        password?: string | null
    ) => void = proto.open;

    const _send: (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null
    ) => void = proto.send;

    const _setHeader: (this: XMLHttpRequest, k: string, v: string) => void =
        proto.setRequestHeader;

    /**
     * @brief Intercepta `open` para armazenar método/URL.
     */
    proto.open = function (
        this: XhrWithCap,
        method: string,
        url: string,
        async?: boolean,
        username?: string | null,
        password?: string | null
    ): void {
        this.__cap = {
            method: String(method || "GET").toUpperCase(),
            url,
            headers: {},
            tStart: 0,
        };
        return _open.call(this, method, url, async ?? true, username ?? null, password ?? null);
    };

    /**
     * @brief Intercepta `setRequestHeader` para coletar headers.
     */
    proto.setRequestHeader = function (this: XhrWithCap, k: string, v: string): void {
        try {
            if (!this.__cap) this.__cap = { method: "GET", url: "", headers: {}, tStart: 0 };
            this.__cap.headers[k.toLowerCase()] = v;
        } catch (_e) {
            void 0;
        }
        return _setHeader.call(this, k, v);
    };

    /**
     * @brief Intercepta `send` para emitir request/response e tempos.
     */
    proto.send = function (this: XhrWithCap, body?: Document | XMLHttpRequestBodyInit | null): void {
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

                    // Parse básico de headers de resposta
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
                    } catch (_e) {
                        void 0;
                    }

                    // Aproxima tamanho quando responseType padrão (texto)
                    const size = typeof this.responseText === "string" ? this.responseText.length : 0;

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
        } catch (_e) {
            void 0;
        }

        // Sem 'any' e preservando o this correto
        return _send.call(this, body ?? null);
    };
})();

/* ============================================================================
 * WebSocket - proxy com telemetria
 * ========================================================================== */

(function patchWS() {
    const OrigWS = window.WebSocket;

    /** @brief Type guard para `ArrayBufferView` sem usar assertions. */
    function isArrayBufferView(x: unknown): x is ArrayBufferView {
        return x != null && typeof x === "object" && ArrayBuffer.isView(x as ArrayBufferView);
    }

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
                    } else if (isArrayBufferView(data)) {
                        repr = `base64:${abToBase64(data.buffer)}`;
                    } else {
                        repr = String(data);
                    }
                    safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "in", data: repr });
                } catch (_e) {
                    void 0;
                }
            });

            // Mensagens enviadas
            const origSend: (
                this: WebSocket,
                data: string | ArrayBufferLike | Blob | ArrayBufferView
            ) => void = this.send;

            this.send = function (
                this: WebSocket,
                data: string | ArrayBufferLike | Blob | ArrayBufferView
            ): void {
                try {
                    let repr: string;
                    if (data instanceof ArrayBuffer || isArrayBufferView(data)) {
                        const buf: ArrayBufferLike = data instanceof ArrayBuffer ? data : data.buffer;
                        repr = `base64:${abToBase64(buf)}`;
                    } else {
                        repr = String(data);
                    }
                    safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "out", data: repr });
                } catch (_e) {
                    void 0;
                }
                // preserva this correto; sem 'any'
                Reflect.apply(origSend, this, [data]);
            };

            this.addEventListener("close", (ev: CloseEvent) => {
                safeSend("cap:ws:close", { ts: Date.now(), id, code: ev.code, reason: ev.reason });
            });

            this.addEventListener("error", () => {
                safeSend("cap:ws:error", { ts: Date.now(), id });
            });
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
 * EventSource (SSE) – log leve de abertura/mensagens/erros
 * ========================================================================== */

(function patchEventSource() {
    const _ES = window.EventSource;
    if (!_ES) return;

    class ES extends _ES {
        constructor(url: string | URL, init?: EventSourceInit) {
            const u = String(url);
            super(u, init);
            safeSend("cap:sse:open", {
                ts: Date.now(),
                url: u,
                withCredentials: !!init?.withCredentials,
            });
            this.addEventListener("message", (ev) => {
                safeSend("cap:sse:msg", { ts: Date.now(), url: u, data: String(ev.data ?? "") });
            });
            this.addEventListener("error", () => {
                safeSend("cap:sse:error", { ts: Date.now(), url: u });
            });
        }
    }

    Object.defineProperty(window, "EventSource", {
        configurable: true,
        writable: true,
        value: ES,
    });
})();

/* ============================================================================
 * navigator.sendBeacon – URL + tamanho (sem bloquear thread)
 * ========================================================================== */

(function patchBeacon() {
    const orig = navigator.sendBeacon?.bind(navigator);
    if (!orig) return;

    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
        let size = 0;
        try {
            if (typeof data === "string") size = data.length;
            else if (data instanceof Blob) size = data.size;
            else if (data instanceof ArrayBuffer) size = data.byteLength;
            else if (ArrayBuffer.isView(data as ArrayBufferView)) size = (data as ArrayBufferView).byteLength;
            else if (data instanceof URLSearchParams) size = String(data).length;
        } catch (_e) {
            void 0;
        }
        safeSend("cap:beacon", { ts: Date.now(), url: String(url), size });
        // mesma assinatura; sem 'any'
        return orig(url, data ?? null);
    };
})();

/* ============================================================================
 * Sinal leve de diagnóstico no convidado
 * ========================================================================== */

contextBridge.exposeInMainWorld("__cap_active", true);
