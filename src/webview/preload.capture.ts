/* eslint-env browser */
/**
 * @file src/webview/preload.capture.ts
 * @description
 * Preload que roda DENTRO do processo do <webview> (guest).
 * - Instrumenta APIs de rede e envia eventos para o host com sendToHost.
 * - Nunca quebra a página (try/catch em volta de tudo).
 * - Idempotente: se carregar 2x, não repatcha.
 *
 * Canais emitidos:
 *   cap:rest:request  { ts, url, method, reqHeaders, reqBody? }
 *   cap:rest:response { ts, url, method, status, statusText, resHeaders, bodySize, timingMs }
 *   cap:rest:error    { ts, url, method, reqHeaders }
 *   cap:ws:open       { ts, id, url, protocols? }
 *   cap:ws:msg        { ts, id, dir: "in"|"out", data }
 *   cap:ws:close      { ts, id, code, reason }
 *   cap:ws:error      { ts, id }
 *   cap:sse:open      { ts, url, withCredentials }
 *   cap:sse:msg       { ts, url, data }
 *   cap:sse:error     { ts, url }
 *   cap:beacon        { ts, url, size }
 */

import { ipcRenderer, contextBridge } from "electron";

/* ──────────────────────────────────────────────────────────────────────────
 *  Augment: flags de diagnóstico no escopo global do guest
 * ────────────────────────────────────────────────────────────────────────── */
declare global {
    interface Window {
        /** marca para impedir patch duplo */
        __cap_patched?: boolean;
        /** flag visível no DevTools do guest */
        __cap_active?: boolean;
    }
}

/* Tudo dentro de um IIFE para permitir "return" cedo */
(() => {
    if (window.__cap_patched) {
        try { contextBridge.exposeInMainWorld("__cap_active", true); } catch { /* noop */ }
        return;
    }
    window.__cap_patched = true;

    /* ──────────────────────────────────────────────────────────────────────
     *  Helpers
     * ──────────────────────────────────────────────────────────────────── */

    /** Envia payloads serializáveis ao host (sem deixar exceção vazar). */
    function safeSend(channel: string, payload: unknown): void {
        try {
            ipcRenderer.sendToHost(channel, payload);
        } catch {
            // Fallback: força uma cópia JSON-safe
            try {
                const safe = JSON.parse(
                    JSON.stringify(payload, (_k, v) => {
                        if (typeof v === "function" || typeof v === "symbol") return undefined;
                        if (v && typeof v === "object") {
                            if (v instanceof ArrayBuffer) return { _type: "ArrayBuffer", base64: abToBase64(v) };
                            if (ArrayBuffer.isView(v as ArrayBufferView)) {
                                return { _type: (v as ArrayBufferView).constructor.name, base64: abToBase64((v as ArrayBufferView).buffer) };
                            }
                        }
                        return v;
                    })
                );
                ipcRenderer.sendToHost(channel, safe);
            } catch {
                // último recurso: sinal mínimo
                try { ipcRenderer.sendToHost(channel, { _error: "unserializable", _channel: channel }); } catch { /* noop */ }
            }
        }
    }

    /** Normaliza Headers/HeadersInit/Record -> { k:v } (lowercase). */
    function headersToObj(h?: HeadersInit): Record<string, string> {
        try {
            if (!h) return {};
            if (typeof Headers !== "undefined" && h instanceof Headers) {
                const o: Record<string, string> = {};
                (h as Headers).forEach((v, k) => { o[String(k).toLowerCase()] = String(v); });
                return o;
            }
            if (Array.isArray(h)) {
                const o: Record<string, string> = {};
                for (const [k, v] of h) {
                    if (k) o[String(k).toLowerCase()] = String(v ?? "");
                }
                return o;
            }
            if (typeof h === "object") {
                const o: Record<string, string> = {};
                for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
                    o[String(k).toLowerCase()] = String(v);
                }
                return o;
            }
        } catch { /* noop */ }
        return {};
    }

    /** ArrayBuffer -> base64. */
    function abToBase64(ab: ArrayBufferLike): string {
        try {
            const bytes = new Uint8Array(ab);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
            // No DOM, btoa sempre existe; mas tipamos para satisfazer TS.
            // Em ambientes alternativos, Buffer pode existir:
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore - Buffer pode não existir no DOM; checamos em runtime
            return (typeof btoa === "function")
                ? btoa(bin)
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                : (typeof Buffer !== "undefined" ? Buffer.from(bin, "binary").toString("base64") : "");
        } catch {
            return "";
        }
    }

    /** Type guard simples: ArrayBufferView (TypedArray, DataView). */
    function isArrayBufferView(x: unknown): x is ArrayBufferView {
        return x != null && typeof x === "object" && ArrayBuffer.isView(x as ArrayBufferView);
    }

    /* ──────────────────────────────────────────────────────────────────────
     *  fetch()
     * ──────────────────────────────────────────────────────────────────── */

    try {
        const __origFetch = window.fetch.bind(window);

        window.fetch = async function fetchCaptured(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            // URL + método
            let reqUrl = "";
            let method = "GET";

            try {
                if (typeof input === "string" || input instanceof URL) {
                    reqUrl = typeof input === "string" ? input : input.toString();
                    method = (init?.method ?? "GET").toUpperCase();
                } else if (typeof Request !== "undefined" && input instanceof Request) {
                    reqUrl = input.url;
                    method = (init?.method ?? input.method ?? "GET").toUpperCase();
                }
            } catch { /* noop */ }

            // Headers de request
            let reqHeaders: Record<string, string> = {};
            try {
                if (init?.headers) reqHeaders = headersToObj(init.headers);
                else if (typeof Request !== "undefined" && input instanceof Request) reqHeaders = headersToObj(input.headers);
            } catch { /* noop */ }

            // Corpo (apenas formatos "seguros")
            let reqBody: string | undefined;
            try {
                const b = init?.body as unknown;
                if (typeof b === "string") reqBody = b;
                else if (b instanceof URLSearchParams) reqBody = b.toString();
            } catch { /* noop */ }

            const tStart = Date.now();

            safeSend("cap:rest:request", {
                ts: tStart,
                url: String(reqUrl || ""),
                method: String(method || "GET"),
                reqHeaders,
                reqBody,
            });

            try {
                const resp = await __origFetch(input as RequestInfo, init);

                // mede tamanho do corpo sem consumir o original
                let bodySize = 0;
                try {
                    const clone = resp.clone();
                    const buf = await clone.arrayBuffer();
                    bodySize = buf.byteLength | 0;
                } catch { /* noop */ }

                safeSend("cap:rest:response", {
                    ts: Date.now(),
                    url: String(reqUrl || ""),
                    method: String(method || "GET"),
                    status: resp.status | 0,
                    statusText: String(resp.statusText || ""),
                    resHeaders: headersToObj(resp.headers),
                    bodySize,
                    timingMs: Date.now() - tStart,
                });

                return resp;
            } catch (error) {
                safeSend("cap:rest:error", {
                    ts: Date.now(),
                    url: String(reqUrl || ""),
                    method: String(method || "GET"),
                    reqHeaders,
                });
                throw error;
            }
        };
    } catch { /* noop */ }

    /* ──────────────────────────────────────────────────────────────────────
     *  XMLHttpRequest
     * ──────────────────────────────────────────────────────────────────── */

    interface XhrCapData {
        method: string;
        url: string;
        headers: Record<string, string>;
        tStart: number;
    }
    interface XhrWithCap extends XMLHttpRequest {
        __cap?: XhrCapData;
    }

    try {
        const proto = XMLHttpRequest.prototype;

        const origOpen = proto.open;
        const origSend = proto.send;
        const origSetHeader = proto.setRequestHeader;

        const newOpen: typeof proto.open = function (
            this: XhrWithCap,
            method: string,
            url: string | URL,
            async?: boolean,
            username?: string | null,
            password?: string | null
        ): void {
            try {
                this.__cap = {
                    method: String(method || "GET").toUpperCase(),
                    url: String(url ?? ""),
                    headers: {},
                    tStart: 0,
                };
            } catch { /* noop */ }
            // chamar com os mesmos parâmetros (todos opcionais)
            return origOpen.call(this, method, url, async as boolean, username as string | null, password as string | null);
        };

        const newSetHeader: typeof proto.setRequestHeader = function (
            this: XhrWithCap,
            k: string,
            v: string
        ): void {
            try {
                if (!this.__cap) this.__cap = { method: "GET", url: "", headers: {}, tStart: 0 };
                this.__cap.headers[String(k || "").toLowerCase()] = String(v ?? "");
            } catch { /* noop */ }
            return origSetHeader.call(this, k, v);
        };

        const newSend: typeof proto.send = function (
            this: XhrWithCap,
            body?: Document | XMLHttpRequestBodyInit | null
        ): void {
            try {
                if (!this.__cap) this.__cap = { method: "GET", url: "", headers: {}, tStart: 0 };
                this.__cap.tStart = Date.now();

                safeSend("cap:rest:request", {
                    ts: this.__cap.tStart,
                    url: String(this.__cap.url || ""),
                    method: String(this.__cap.method || "GET"),
                    reqHeaders: this.__cap.headers || {},
                    reqBody: typeof body === "string" ? body : undefined,
                });

                this.addEventListener("readystatechange", () => {
                    try {
                        if (this.readyState === 4) {
                            const tEnd = Date.now();

                            // parse de headers de resposta
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
                            } catch { /* noop */ }

                            const size = typeof this.responseText === "string" ? this.responseText.length : 0;

                            safeSend("cap:rest:response", {
                                ts: tEnd,
                                url: String(this.__cap!.url || ""),
                                method: String(this.__cap!.method || "GET"),
                                status: this.status | 0,
                                statusText: String(this.statusText || ""),
                                resHeaders,
                                bodySize: size | 0,
                                timingMs: tEnd - (this.__cap!.tStart | 0),
                            });
                        }
                    } catch { /* noop */ }
                });

                this.addEventListener("error", () => {
                    try {
                        safeSend("cap:rest:error", {
                            ts: Date.now(),
                            url: String(this.__cap?.url || ""),
                            method: String(this.__cap?.method || "GET"),
                            reqHeaders: this.__cap?.headers || {},
                        });
                    } catch { /* noop */ }
                });
            } catch { /* noop */ }
            return origSend.call(this, body ?? null);
        };

        proto.open = newOpen;
        proto.setRequestHeader = newSetHeader;
        proto.send = newSend;
    } catch { /* noop */ }

    /* ──────────────────────────────────────────────────────────────────────
     *  WebSocket
     * ──────────────────────────────────────────────────────────────────── */

    try {
        const OrigWS = window.WebSocket;
        if (OrigWS) {
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

                    this.addEventListener("message", (ev: MessageEvent) => {
                        try {
                            const data = ev.data as unknown;
                            let repr: string;
                            if (data instanceof ArrayBuffer) repr = `base64:${abToBase64(data)}`;
                            else if (isArrayBufferView(data)) repr = `base64:${abToBase64((data as ArrayBufferView).buffer)}`;
                            else repr = String(data);
                            safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "in", data: repr });
                        } catch { /* noop */ }
                    });

                    const origSend = this.send;
                    this.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
                        try {
                            let repr: string;
                            if (data instanceof ArrayBuffer || isArrayBufferView(data)) {
                                const buf = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
                                repr = `base64:${abToBase64(buf)}`;
                            } else {
                                repr = String(data);
                            }
                            safeSend("cap:ws:msg", { ts: Date.now(), id, dir: "out", data: repr });
                        } catch { /* noop */ }
                        Reflect.apply(origSend, this, [data]);
                    };

                    this.addEventListener("close", (ev: CloseEvent) => {
                        try {
                            safeSend("cap:ws:close", { ts: Date.now(), id, code: ev.code | 0, reason: String(ev.reason || "") });
                        } catch { /* noop */ }
                    });

                    this.addEventListener("error", () => {
                        try { safeSend("cap:ws:error", { ts: Date.now(), id }); } catch { /* noop */ }
                    });
                }
            }

            Object.defineProperty(window, "WebSocket", {
                configurable: true,
                writable: true,
                value: CapturedWebSocket,
            });
        }
    } catch { /* noop */ }

    /* ──────────────────────────────────────────────────────────────────────
     *  EventSource (SSE)
     * ──────────────────────────────────────────────────────────────────── */

    try {
        const OrigES = window.EventSource;
        if (OrigES) {
            class ES extends OrigES {
                constructor(url: string | URL, init?: EventSourceInit) {
                    const u = String(url);
                    super(u, init);
                    try {
                        safeSend("cap:sse:open", {
                            ts: Date.now(),
                            url: u,
                            withCredentials: !!init?.withCredentials,
                        });
                    } catch { /* noop */ }
                    this.addEventListener("message", (ev: MessageEvent) => {
                        try { safeSend("cap:sse:msg", { ts: Date.now(), url: u, data: String(ev.data ?? "") }); } catch { /* noop */ }
                    });
                    this.addEventListener("error", () => {
                        try { safeSend("cap:sse:error", { ts: Date.now(), url: u }); } catch { /* noop */ }
                    });
                }
            }

            Object.defineProperty(window, "EventSource", {
                configurable: true,
                writable: true,
                value: ES,
            });
        }
    } catch { /* noop */ }

    /* ──────────────────────────────────────────────────────────────────────
     *  navigator.sendBeacon
     * ──────────────────────────────────────────────────────────────────── */

    try {
        const orig = navigator.sendBeacon?.bind(navigator);
        if (orig) {
            navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
                let size = 0;
                try {
                    if (typeof data === "string") size = data.length;
                    else if (typeof Blob !== "undefined" && data instanceof Blob) size = data.size;
                    else if (data instanceof ArrayBuffer) size = data.byteLength;
                    else if (ArrayBuffer.isView(data as ArrayBufferView)) size = (data as ArrayBufferView).byteLength;
                    else if (data instanceof URLSearchParams) size = String(data).length;
                } catch { /* noop */ }
                try { safeSend("cap:beacon", { ts: Date.now(), url: String(url), size: size | 0 }); } catch { /* noop */ }
                return orig(url, data ?? null);
            };
        }
    } catch { /* noop */ }

    /* ──────────────────────────────────────────────────────────────────────
     *  Sinal leve de diagnóstico no guest
     * ──────────────────────────────────────────────────────────────────── */
    try { contextBridge.exposeInMainWorld("__cap_active", true); } catch { /* noop */ }
})();
