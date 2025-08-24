/**
 * @file src/main/capture.ts
 * Captura HTTP(S) via session.webRequest, agrega req+resp e emite:
 *  - "cap:rest:request" | "cap:rest:before-send-headers" | "cap:rest:response" | "cap:rest:error"
 *  - "cap:txn" (transação consolidada para o Inspetor)
 */

import {
  BrowserWindow,
  type WebRequestFilter,
  type OnBeforeRequestListenerDetails,
  type OnBeforeSendHeadersListenerDetails,
  type OnHeadersReceivedListenerDetails,
  type OnCompletedListenerDetails,
  type OnErrorOccurredListenerDetails,
} from "electron";
import * as zlib from "zlib";
import dns from "dns";
import { URL } from "url";

import { onReq, onResp } from "./capture.agg";
import type {
  CapReq,
  CapResp,
  CapTiming,
  HttpMethod,
  CapTxn,
} from "../common/capture.types";

/* ========================= Eventos granulares ========================= */

export type RestRequestPayload = {
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
};

export type RestResponsePayload = {
  ts: number;
  url: string;
  method: string;
  status: number;
  statusText: string;
  resHeaders: Record<string, string>;
  bodySize: number;
  timingMs: number;
};

export type CapChannel =
  | "cap:rest:request"
  | "cap:rest:before-send-headers"
  | "cap:rest:response"
  | "cap:rest:error"
  | "cap:txn";

type OnEventFn = (
  channel: CapChannel,
  payload: RestRequestPayload | RestResponsePayload | CapTxn
) => void;

/* =============================== Utils =============================== */

function bufToSnippet(b?: Uint8Array, max = 512): string | undefined {
  if (!b) return;
  const t = Buffer.from(b).toString("utf8");
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

function decodeBody(buf: Uint8Array, headers: Record<string, string>): Uint8Array {
  const enc = (headers["content-encoding"] || headers["Content-Encoding"] || "").toLowerCase();
  try {
    const nodeBuf = Buffer.from(buf);
    if (enc.includes("gzip"))   return new Uint8Array(zlib.gunzipSync(nodeBuf));
    if (enc.includes("deflate"))return new Uint8Array(zlib.inflateSync(nodeBuf));
    if (enc.includes("br"))     return new Uint8Array(zlib.brotliDecompressSync(nodeBuf));
  } catch { /* noop */ }
  return buf;
}

function toSafeHeaderMap(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  if (!headers) return {};
  const allow = new Set([
    "content-type",
    "content-length",
    "accept",
    "accept-encoding",
    "user-agent",
    "origin",
    "referer",
    "host",
    "cache-control",
    "pragma",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!allow.has(key)) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** DNS com cache (opcional). */
const dnsCache = new Map<string, string>();
async function resolveRemoteIp(requestUrl: string): Promise<string> {
  try {
    const host = new URL(requestUrl).hostname;
    if (!host) return "N/D";
    const hit = dnsCache.get(host);
    if (hit) return hit;
    const ip = await new Promise<string>((resolve) => {
      dns.lookup(host, (err, address) => resolve(err ? "N/D" : address));
    });
    if (ip !== "N/D") dnsCache.set(host, ip);
    return ip;
  } catch { return "N/D"; }
}

/** Normaliza método para HttpMethod. */
function toHttpMethod(m: string): HttpMethod {
  const u = m.toUpperCase();
  if (["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"].includes(u)) return u as HttpMethod;
  return "GET";
}

/** Converte entrada desconhecida em Uint8Array. */
function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data == null) return undefined;

  // guard para Buffer.isBuffer sem usar any
  type BufferCtor = typeof Buffer & { isBuffer?(x: unknown): x is Buffer };
  const Buf = Buffer as BufferCtor;

  if (typeof Buf?.isBuffer === "function" && Buf.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return undefined;
}
/* ===================== Estado interno por requestId ==================== */

type ReqCtx = {
  startedAt: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBodyBytes?: Uint8Array;
};
const reqCtx = new Map<number, ReqCtx>();

type RespAccum = {
  headers: Record<string, string>;
  statusText?: string;
  bodyChunks: Uint8Array[];
  bodySize: number;
  firstByteTs?: number;
};
const respAcc = new Map<number, RespAccum>();

/** Tipagem mínima do filtro de resposta do Electron. */
interface ResponseFilter {
  on(event: "data",  listener: (chunk: Buffer) => void): this;
  on(event: "end",   listener: () => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
  write(chunk: Buffer): void;
  end(): void;
}
type WebRequestWithFilter = {
  filterResponseData: (id: number) => ResponseFilter;
};
function getFilterFn(obj: unknown): ((id: number) => ResponseFilter) | undefined {
  const maybe = obj as Partial<WebRequestWithFilter> | undefined;
  const fn = maybe?.filterResponseData;
  return typeof fn === "function" ? fn.bind(maybe) : undefined;
}

/* ================================ Core ================================ */

/**
 * Registra hooks de captura na sessão da janela e retorna função de detach.
 */
export function attachNetworkCapture(win: BrowserWindow, onEvent?: OnEventFn): () => void {
  const ses = win.webContents.session;
  const filter: WebRequestFilter = { urls: ["*://*/*"] };

  const emit = (
    channel: CapChannel,
    payload: RestRequestPayload | RestResponsePayload | CapTxn
  ): void => {
    try { onEvent?.(channel, payload); } catch { /* noop */ }
  };

  /* -------- onBeforeRequest -------- */
  const onBeforeRequest = (
    d: OnBeforeRequestListenerDetails,
    callback: (resp: { cancel?: boolean; redirectURL?: string }) => void
  ): void => {
    try {
      const body = toUint8Array(d.uploadData?.[0]?.bytes);

      const ctx: ReqCtx = {
        startedAt: Date.now(),
        method: d.method,
        url: d.url,
        reqHeaders: {},
      };
      if (body) ctx.reqBodyBytes = body;
      reqCtx.set(d.id, ctx);

      const reqPayload: RestRequestPayload = {
        ts: Date.now(),
        url: d.url,
        method: d.method,
        reqHeaders: {},
      };
      const snippet = bufToSnippet(body, 256);
      if (snippet !== undefined) reqPayload.reqBody = snippet;
      emit("cap:rest:request", reqPayload);

      const u = new URL(d.url);
      const capReq: CapReq = {
        id: String(d.id),
        method: toHttpMethod(d.method),
        url: d.url,
        host: u.host,
        path: u.pathname,
        query: {},
        headers: {},
        timing: { startTs: Date.now() },
      };
      if (body) {
        capReq.bodyBytes = body;
        const sn = bufToSnippet(body);
        if (sn !== undefined) capReq.bodyTextSnippet = sn;
      }
      onReq(capReq);
    } finally {
      callback({});
    }
  };

  /* -------- onBeforeSendHeaders -------- */
  const onBeforeSendHeaders = (
    d: OnBeforeSendHeadersListenerDetails,
    callback: (resp: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
  ): void => {
    try {
      const safe = toSafeHeaderMap(d.requestHeaders);
      const ctx = reqCtx.get(d.id);
      if (ctx) ctx.reqHeaders = safe;

      emit("cap:rest:before-send-headers", {
        ts: Date.now(), url: d.url, method: d.method, reqHeaders: safe,
      } satisfies RestRequestPayload);
    } finally {
      callback({});
    }
  };

  /* -------- onHeadersReceived --------
   * Guarda headers e, se suportado, intercepta o corpo.
   * ----------------------------------- */
  const onHeadersReceived = (
    d: OnHeadersReceivedListenerDetails,
    callback: (resp: { cancel?: boolean; responseHeaders?: Record<string, string | string[]> }) => void
  ): void => {
    try {
      const safe = toSafeHeaderMap(d.responseHeaders as Record<string, string[]> | undefined);
      respAcc.set(d.id, {
        headers: safe,
        statusText: d.statusLine,
        bodyChunks: [],
        bodySize: 0,
      });

      // Feature-detect real + bind da função; evita "not a function".
      const filterFn = getFilterFn(ses.webRequest);
      if (filterFn) {
        const stream = filterFn(d.id);
        stream.on("data", (chunk: Buffer) => {
          const acc = respAcc.get(d.id);
          if (acc) {
            const arr = new Uint8Array(chunk);
            acc.bodyChunks.push(arr);
            acc.bodySize += arr.byteLength;
            if (acc.firstByteTs === undefined) acc.firstByteTs = Date.now();
          }
          stream.write(chunk); // pass-through
        });
        stream.on("end",   () => { try { stream.end(); } catch { /* noop */ } });
        stream.on("error", () => { try { stream.end(); } catch { /* noop */ } });
      }
      // Sem suporte: seguimos apenas com headers/timing.
    } finally {
      callback({});
    }
  };

  /* -------- onCompleted -------- */
  const onCompleted = (d: OnCompletedListenerDetails): void => {
    void (async () => {
      const now = Date.now();
      const ctx = reqCtx.get(d.id);
      const acc = respAcc.get(d.id);

      const timingMs = ctx ? now - ctx.startedAt : 0;
      const resHeaders = acc?.headers ?? {};

      emit("cap:rest:response", {
        ts: now,
        url: d.url,
        method: d.method,
        status: d.statusCode,
        statusText: acc?.statusText || "",
        resHeaders,
        bodySize: acc?.bodySize ?? 0,
        timingMs,
      } satisfies RestResponsePayload);

      let bodyBuf: Uint8Array | undefined;
      if (acc && acc.bodyChunks.length) {
        const concat = new Uint8Array(acc.bodySize);
        let off = 0;
        for (const c of acc.bodyChunks) { concat.set(c, off); off += c.byteLength; }
        bodyBuf = decodeBody(concat, resHeaders);
      }

      const timing: CapTiming = { startTs: ctx?.startedAt ?? now, endTs: now };
      if (acc?.firstByteTs !== undefined) timing.firstByteTs = acc.firstByteTs;

      const capResp: CapResp = {
        id: String(d.id),
        status: d.statusCode,
        headers: resHeaders,
        timing,
      };
      if (acc?.statusText) capResp.statusText = acc.statusText;
      if (bodyBuf) {
        capResp.bodyBytes = bodyBuf;
        const sn = bufToSnippet(bodyBuf);
        if (sn !== undefined) capResp.bodyTextSnippet = sn;
      }
      const ct = resHeaders["content-type"]; if (ct) capResp.contentType = ct;
      if (acc?.bodySize !== undefined) capResp.sizeBytes = acc.bodySize;

      // fromCache pode não existir nos tipos
      const withCache = d as OnCompletedListenerDetails & Partial<{ fromCache: boolean }>;
      if (withCache.fromCache !== undefined) capResp.fromCache = withCache.fromCache;

      const txn = onResp(capResp);
      if (txn) emit("cap:txn", txn);

      reqCtx.delete(d.id);
      respAcc.delete(d.id);
      // opcional: await resolveRemoteIp(d.url);
    })();
  };

  /* -------- onErrorOccurred -------- */
  const onErrorOccurred = (d: OnErrorOccurredListenerDetails): void => {
    void (async () => {
      await resolveRemoteIp(d.url);
      emit("cap:rest:error", {
        ts: Date.now(), url: d.url, method: d.method, reqHeaders: {},
      } satisfies RestRequestPayload);
    })();
  };

  /* -------- Registrar / Detach -------- */
  ses.webRequest.onBeforeRequest(filter, onBeforeRequest);
  ses.webRequest.onBeforeSendHeaders(filter, onBeforeSendHeaders);
  ses.webRequest.onHeadersReceived(filter, onHeadersReceived);
  ses.webRequest.onCompleted(filter, onCompleted);
  ses.webRequest.onErrorOccurred(filter, onErrorOccurred);

  type RemoveAll = (filter: null) => void;
  const remover = ses.webRequest as unknown as {
    onBeforeRequest: RemoveAll;
    onBeforeSendHeaders: RemoveAll;
    onHeadersReceived: RemoveAll;
    onCompleted: RemoveAll;
    onErrorOccurred: RemoveAll;
  };

  return (): void => {
    remover.onBeforeRequest(null);
    remover.onBeforeSendHeaders(null);
    remover.onHeadersReceived(null);
    remover.onCompleted(null);
    remover.onErrorOccurred(null);
    reqCtx.clear();
    respAcc.clear();
  };
}
