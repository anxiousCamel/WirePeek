// src/webview/preload.capture.ts
/* eslint-env browser */
import { ipcRenderer, contextBridge } from "electron";

/* ===================== Utils ===================== */

type HeaderInitLike = Headers | Record<string, string> | string[][];

/** Normaliza headers em objeto simples {k: v} (lowercase). */
function headersToObj(h?: HeaderInitLike): Record<string, string> {
    if (!h) return {};
    // Headers
    if (typeof (h as Headers).forEach === "function") {
        const o: Record<string, string> = {};
        (h as Headers).forEach((v, k) => {
            o[String(k).toLowerCase()] = String(v);
        });
        return o;
    }
    // string[][]
    if (Array.isArray(h)) {
        const o: Record<string, string> = {};
        for (const pair of h) {
            const k = String(pair[0] ?? "");
            const v = String(pair[1] ?? "");
            if (k) o[k.toLowerCase()] = v;
        }
        return o;
    }
    // Record<string,string>
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
    return out;
}

/** Converte ArrayBuffer (ou SharedArrayBuffer) em base64 no browser. */
function abToBase64(ab: ArrayBufferLike): string {
    const bytes = new Uint8Array(ab);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

/* ===================== fetch ===================== */

const _fetch = window.fetch.bind(window);

window.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    const startedAt = performance.now();

    // URL e método
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

    // Headers da requisição
    let reqHeaders: Record<string, string> = {};
    try {
        if (init?.headers) {
            // Converte qualquer forma de HeaderInitLike para HeadersInit seguro
            const ih = init.headers as unknown;
            let hInit: HeadersInit = [];
            if (ih instanceof Headers || Array.isArray(ih) || typeof ih === "object") {
                hInit = ih as HeadersInit;
            }
            reqHeaders = headersToObj(new Headers(hInit));
        } else if (typeof input !== "string" && !(input instanceof URL)) {
            reqHeaders = headersToObj((input as Request).headers);
        }
    } catch (e) {
        console.debug("[cap] fetch req headers parse error:", e);
    }

    // Corpo (texto) — não forço leitura de streams aqui
    let reqBody: string | undefined;
    try {
        if (init?.body && typeof init.body === "string") reqBody = init.body;
    } catch (e) {
        console.debug("[cap] fetch req body parse error:", e);
    }

    ipcRenderer.sendToHost("cap:rest:request", {
        ts: Date.now(),
        url: reqUrl,
        method,
        reqHeaders,
        reqBody,
    });

    // Executa a requisição original
    const resp = await _fetch(input as RequestInfo, init);
    const endedAt = performance.now();

    // Headers da resposta
    const resHeaders = headersToObj(resp.headers);

    // Tenta clonar para pegar tamanho do corpo (texto)
    const clone = resp.clone();
    let bodySize = 0;
    try {
        const text = await clone.text();
        bodySize = text.length;
    } catch (e) {
        console.debug("[cap] fetch resp body size error:", e);
    }

    ipcRenderer.sendToHost("cap:rest:response", {
        ts: Date.now(),
        url: reqUrl,
        method,
        status: resp.status,
        statusText: resp.statusText,
        resHeaders,
        bodySize,
        timingMs: endedAt - startedAt,
    });

    return resp;
};

/* ===================== XHR ===================== */

interface XhrWithCap extends XMLHttpRequest {
    __cap?: {
        method: string;
        url: string;
        headers: Record<string, string>;
        startedAt: number;
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
        this.__cap = { method, url, headers: {}, startedAt: 0 };
        return _open.call(
            this,
            method,
            url,
            async ?? true,
            username ?? null,
            password ?? null
        );
    };

    proto.setRequestHeader = function (
        this: XhrWithCap,
        k: string,
        v: string
    ): void {
        try {
            if (!this.__cap)
                this.__cap = { method: "GET", url: "", headers: {}, startedAt: 0 };
            this.__cap.headers[k.toLowerCase()] = v;
        } catch (e) {
            console.debug("[cap] xhr setHeader error:", e);
        }
        return _setHeader.call(this, k, v);
    };

    proto.send = function (
        this: XhrWithCap,
        body?: Document | XMLHttpRequestBodyInit | null
    ): void {
        try {
            if (!this.__cap)
                this.__cap = { method: "GET", url: "", headers: {}, startedAt: 0 };
            this.__cap.startedAt = performance.now();

            ipcRenderer.sendToHost("cap:rest:request", {
                ts: Date.now(),
                url: this.__cap.url,
                method: this.__cap.method,
                reqHeaders: this.__cap.headers,
                reqBody: typeof body === "string" ? body : undefined,
            });

            this.addEventListener("readystatechange", () => {
                if (this.readyState === 4) {
                    const ended = performance.now();
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
                    } catch (e) {
                        console.debug("[cap] xhr parse resp headers error:", e);
                    }

                    ipcRenderer.sendToHost("cap:rest:response", {
                        ts: Date.now(),
                        url: this.__cap!.url,
                        method: this.__cap!.method,
                        status: this.status,
                        statusText: this.statusText,
                        resHeaders,
                        bodySize: (this.responseText || "").length,
                        timingMs: ended - this.__cap!.startedAt,
                    });
                }
            });
        } catch (e) {
            console.debug("[cap] xhr send wrapper error:", e);
        }
        return _send.call(
            this,
            body as Document | XMLHttpRequestBodyInit | null | undefined
        );
    };
})();

/* ===================== WebSocket ===================== */

(function patchWS() {
    const _WS = window.WebSocket;

    class WS extends _WS {
        constructor(url: string | URL, protocols?: string | string[]) {
            const urlStr = typeof url === "string" ? url : url.toString();
            super(urlStr, protocols);

            const id = Math.random().toString(36).slice(2); // 👈 voltou

            ipcRenderer.sendToHost("cap:ws:open", {
                ts: Date.now(),
                id,            // agora existe
                url: urlStr,
                protocols,
            });

            this.addEventListener("message", (ev: MessageEvent) => {
                let repr: string;
                const data = ev.data as unknown;

                if (data instanceof ArrayBuffer) {
                    repr = `base64:${abToBase64(data)}`;
                } else if (ArrayBuffer.isView(data)) {
                    repr = `base64:${abToBase64((data as ArrayBufferView).buffer)}`;
                } else {
                    repr = String(data);
                }

                ipcRenderer.sendToHost("cap:ws:msg", {
                    ts: Date.now(),
                    id,
                    dir: "in",
                    data: repr,
                });
            });

            const origSend = this.send;
            this.send = function (
                data: string | ArrayBufferLike | Blob | ArrayBufferView
            ): void {
                try {
                    let repr: string;
                    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                        const buf =
                            data instanceof ArrayBuffer
                                ? data
                                : (data as ArrayBufferView).buffer;
                        repr = `base64:${abToBase64(buf)}`;
                    } else {
                        repr = String(data);
                    }

                    ipcRenderer.sendToHost("cap:ws:msg", {
                        ts: Date.now(),
                        id,
                        dir: "out",
                        data: repr,
                    });
                } catch (e) {
                    console.debug("[cap] ws send mirror error:", e);
                }
                return origSend.call(this, data);
            };

            this.addEventListener("close", (ev: CloseEvent) => {
                ipcRenderer.sendToHost("cap:ws:close", {
                    ts: Date.now(),
                    id,
                    code: ev.code,
                    reason: ev.reason,
                });
            });

            this.addEventListener("error", () => {
                ipcRenderer.sendToHost("cap:ws:error", { ts: Date.now(), id });
            });
        }
    }

    // Substitui o global sem usar `any`
    Object.defineProperty(window, "WebSocket", {
        configurable: true,
        writable: true,
        value: WS,
    });
})();

/** Flag de diagnóstico no convidado */
contextBridge.exposeInMainWorld("__cap_active", true);
