/**
 * @file src/main/capture.ts
 * @brief Captura HTTP(S) via session.webRequest, agrega req+resp e emite:
 *   - "cap:rest:request" | "cap:rest:before-send-headers" | "cap:rest:response" | "cap:rest:error"
 *   - "cap:txn" (transação consolidada para o Inspector)
 *
 * Recursos:
 *   • CORS + preflight correlacionado (OPTIONS ↔ request real)
 *   • Destaque de Access-Control-Allow-*
 *   • Persistência opcional do body em disco (opt-in por config + SaveBodyFn)
 *   • Parse de Set-Cookie em responses
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

import { config } from "./config";
import type {
  CapReq,
  CapResp,
  CapTiming,
  HttpMethod,
  CapTxn,
} from "../common/capture.types";
import { findJwtInString, redactJwt, decodeJwt } from "./fsutil";
import { onReq, onResp, patchReqJwt } from "./capture.agg";

/* ============================================================================
 *                                Eventos granulares
 * ========================================================================== */

/**
 * @typedef RestRequestPayload
 * @property {number} ts
 * @property {string} url
 * @property {string} method
 * @property {Record<string,string>} reqHeaders
 * @property {string} [reqBody]
 */
export type RestRequestPayload = {
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
};

/**
 * @typedef RestResponsePayload
 * @property {number} ts
 * @property {string} url
 * @property {string} method
 * @property {number} status
 * @property {string} statusText
 * @property {Record<string,string>} resHeaders
 * @property {number} bodySize
 * @property {number} timingMs
 */
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

/** Canais suportados para emissão às UIs/persistência. */
export type CapChannel =
  | "cap:rest:request"
  | "cap:rest:before-send-headers"
  | "cap:rest:response"
  | "cap:rest:error"
  | "cap:txn";

/** Callback para encaminhar eventos ao chamador. */
type OnEventFn = (
  channel: CapChannel,
  payload: RestRequestPayload | RestResponsePayload | CapTxn
) => void;

/** Descriptor retornado ao salvar body em disco. */
type SavedBodyInfo = { path: string; size: number; contentType?: string };

/** Callback de persistência do body em disco (injeção externa). */
type SaveBodyFn = (idHint: string, buf: Uint8Array, contentType?: string) => SavedBodyInfo;

/* ============================================================================
 *                                    Utils
 * ========================================================================== */

/**
 * @brief Gera um snippet UTF-8 do corpo para visualização rápida.
 * @param b  Buffer do corpo.
 * @param max Tamanho máximo do texto.
 * @returns Trecho de texto ou undefined.
 */
function bufToSnippet(b?: Uint8Array, max = 512): string | undefined {
  if (!b) return;
  const t = Buffer.from(b).toString("utf8");
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

/**
 * @brief Decodifica corpo conforme Content-Encoding (gzip/deflate/br).
 * @param buf      Conteúdo bruto.
 * @param headers  Headers de resposta normalizados (lowercase).
 * @returns Buffer decodificado (ou o original se não suportado).
 */
function decodeBody(buf: Uint8Array, headers: Record<string, string>): Uint8Array {
  const enc = (headers["content-encoding"] || "").toLowerCase();
  try {
    const nodeBuf = Buffer.from(buf);
    if (enc.includes("gzip")) return new Uint8Array(zlib.gunzipSync(nodeBuf));
    if (enc.includes("deflate")) return new Uint8Array(zlib.inflateSync(nodeBuf));
    if (enc.includes("br")) return new Uint8Array(zlib.brotliDecompressSync(nodeBuf));
  } catch { /* noop */ }
  return buf;
}

/**
 * @brief Filtra/normaliza headers para chaves/valores simples (lowercase).
 * @details
 *  - Mantém cabeçalhos CORS (A-C-Allow-*) para destacar no Inspector.
 *  - Inclui Authorization/Cookie apenas se `redactSecrets=false`.
 */
function toSafeHeaderMap(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  if (!headers) return {};
  const allow = new Set<string>([
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
    // CORS response headers:
    "access-control-allow-origin",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-credentials",
    "vary",
    // segredos só se liberado:
    ...(!config.redactSecrets ? ["authorization", "cookie"] : []),
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!allow.has(key)) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * @brief Retorna todas as ocorrências de um header (case-insensitive) em array.
 * @param headers Record de headers (string|string[]), possivelmente undefined
 * @param nameLower Nome do header em minúsculas (ex.: "set-cookie")
 */
function getHeaderList(
  headers: Record<string, string | string[]> | undefined,
  nameLower: string
): string[] | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === nameLower) {
      return Array.isArray(v) ? v : [v];
    }
  }
  return undefined;
}

/**
 * @brief Faz o parse de uma linha `Set-Cookie` de forma defensiva.
 * @param setCookie Linha completa vinda do cabeçalho Set-Cookie
 * @returns Objeto com { name, value, flags }
 */
function parseSetCookie(
  setCookie: string
): { name: string; value: string; flags: Record<string, string | boolean> } {
  // Garante string e separa em "par" (nome=valor) + atributos
  const parts = String(setCookie ?? "").split(";").map(s => s.trim());
  const pair = parts[0] ?? "";
  const attrs = parts.length > 1 ? parts.slice(1) : [];

  // Nome e valor do cookie (sem usar destructuring que vira string|undefined)
  const eq = pair.indexOf("=");
  const name = eq >= 0 ? pair.slice(0, eq) : pair;   // se não tiver "=", tudo é nome
  const value = eq >= 0 ? pair.slice(eq + 1) : "";   // e valor vazio

  // Atributos/flags (Max-Age, Path, Secure, HttpOnly, SameSite etc.)
  const flags: Record<string, string | boolean> = {};
  for (const a of attrs) {
    if (!a) continue;
    const i = a.indexOf("=");
    if (i >= 0) {
      const key = a.slice(0, i).trim().toLowerCase();
      const val = a.slice(i + 1).trim();
      flags[key] = val !== "" ? val : true;
    } else {
      flags[a.trim().toLowerCase()] = true;
    }
  }

  return { name, value, flags };
}

/** DNS opcional (diagnóstico). */
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

/** Normaliza método HTTP para o union `HttpMethod`. */
function toHttpMethod(m: string): HttpMethod {
  const u = m.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(u)) return u as HttpMethod;
  return "GET";
}

/* ============================================================================
 *            CORS: fila de preflights para correlacionar com a request real
 * ========================================================================== */

type PreflightKey = string;
const preflights = new Map<PreflightKey, { ts: number; origin?: string }>();

/** Gera uma chave de preflight: host + pathname + method. */
function pfKey(host: string, path: string, method: string): PreflightKey {
  return `${host}|${path}|${method.toUpperCase()}`;
}

/* ============================================================================
 *                      Estado interno por requestId (Electron)
 * ========================================================================== */

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
  /** Linhas cruas de Set-Cookie (sem filtro) capturadas em onHeadersReceived */
  rawSetCookies?: string[];
};
const respAcc = new Map<number, RespAccum>();

/* ============================================================================
 *                 Tipagem mínima do filtro de resposta (stream)
 * ========================================================================== */

interface ResponseFilter {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (err: unknown) => void): this;
  write(chunk: Buffer): void;
  end(): void;
}
type WebRequestWithFilter = {
  filterResponseData: (id: number) => ResponseFilter;
};
/** Safely obtém `filterResponseData` se existir na versão do Electron. */
function getFilterFn(obj: unknown): ((id: number) => ResponseFilter) | undefined {
  const maybe = obj as Partial<WebRequestWithFilter> | undefined;
  const fn = maybe?.filterResponseData;
  return typeof fn === "function" ? fn.bind(maybe) : undefined;
}

/* ============================================================================
 *                                     Core
 * ========================================================================== */

type UploadItem = NonNullable<OnBeforeRequestListenerDetails["uploadData"]>[number];
type UploadRawLike = { bytes: ArrayBuffer | Buffer };

function uploadItemToBytes(u: UploadItem): Uint8Array | undefined {
  if (Object.prototype.hasOwnProperty.call(u as object, "bytes")) {
    const raw = (u as UploadRawLike).bytes;
    if (raw) return raw instanceof Buffer ? new Uint8Array(raw) : new Uint8Array(raw);
  }
  return undefined;
}
function mergeUploadData(list?: ReadonlyArray<UploadItem>): Uint8Array | undefined {
  if (!list?.length) return undefined;
  const parts: Uint8Array[] = [];
  for (const u of list) {
    const p = uploadItemToBytes(u);
    if (p) parts.push(p);
  }
  if (!parts.length) return undefined;
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

/**
 * @brief Registra hooks de captura e retorna função de detach.
 * @param win     Janela principal (fonte da `session` a ser capturada).
 * @param onEvent Callback para encaminhar eventos às UIs/persistência.
 * @param opts    Opções; incluir `saveBody` ativa persistência opcional do corpo.
 */
export function attachNetworkCapture(
  win: BrowserWindow,
  onEvent?: OnEventFn,
  opts?: { saveBody?: SaveBodyFn }
): () => void {
  const ses = win.webContents.session;
  const filter: WebRequestFilter = { urls: ["*://*/*"] };

  const emit = (
    channel: CapChannel,
    payload: RestRequestPayload | RestResponsePayload | CapTxn
  ): void => { try { onEvent?.(channel, payload); } catch { /* noop */ } };

  /* --------------------------- onBeforeRequest --------------------------- */
  const onBeforeRequest = (
    d: OnBeforeRequestListenerDetails,
    callback: (resp: { cancel?: boolean; redirectURL?: string }) => void
  ): void => {
    try {
      const body = mergeUploadData(d.uploadData);

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

      // CORS: correlaciona com preflight recente (até ~3s)
      try {
        const key = pfKey(u.host, u.pathname, d.method);
        const pf = preflights.get(key);
        if (pf && Date.now() - pf.ts < 3000) {
          // Só inclui a prop quando existir (exactOptionalPropertyTypes)
          (capReq as CapReq & { cors?: { preflight: boolean; origin?: string } }).cors =
            pf.origin !== undefined ? { preflight: true, origin: pf.origin } : { preflight: true };
          preflights.delete(key);
        }
      } catch { /* noop */ }

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

  /* ------------------------ onBeforeSendHeaders ------------------------- */
  const onBeforeSendHeaders = (
    d: OnBeforeSendHeadersListenerDetails,
    callback: (resp: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
  ): void => {
    try {
      const safe = toSafeHeaderMap(d.requestHeaders);
      const ctx = reqCtx.get(d.id);
      if (ctx) ctx.reqHeaders = safe;

      // CORS: memoriza preflight OPTIONS → Access-Control-Request-Method
      try {
        if (d.method.toUpperCase() === "OPTIONS") {
          const rh = d.requestHeaders as Record<string, string>;
          let acrm: string | undefined; // método real desejado
          let origin: string | undefined;
          for (const [k, v] of Object.entries(rh)) {
            const lk = k.toLowerCase();
            if (lk === "access-control-request-method") acrm = String(v);
            else if (lk === "origin") origin = String(v);
          }
          if (acrm) {
            const u = new URL(d.url);
            const key = pfKey(u.host, u.pathname, acrm);
            const rec = origin !== undefined ? { ts: Date.now(), origin } : { ts: Date.now() };
            preflights.set(key, rec);
          }
        }
      } catch { /* noop */ }

      // JWT em Authorization: Bearer <jwt>
      try {
        const rh = d.requestHeaders as Record<string, string | string[] | undefined>;
        const authRaw =
          (rh["Authorization"] as string | undefined) ??
          (rh["authorization"] as string | undefined);
        if (typeof authRaw === "string" && authRaw.startsWith("Bearer ")) {
          const raw = authRaw.slice(7).trim();
          const jwt = findJwtInString(raw);
          if (jwt) {
            const red = redactJwt(jwt);
            const dec = decodeJwt(jwt);
            // Atualiza o req da transação via agregador
            patchReqJwt(String(d.id), { token: red, decoded: dec });
          }
        }
      } catch {
        /* noop */
      }

      emit("cap:rest:before-send-headers", {
        ts: Date.now(), url: d.url, method: d.method, reqHeaders: safe,
      } as RestRequestPayload);
    } finally {
      callback({});
    }
  };

  /* -------------------------- onHeadersReceived ------------------------- */
  const onHeadersReceived = (
    d: OnHeadersReceivedListenerDetails,
    callback: (resp: { cancel?: boolean; responseHeaders?: Record<string, string | string[]> }) => void
  ): void => {
    try {
      const safe = toSafeHeaderMap(d.responseHeaders as Record<string, string[]> | undefined);

      // Captura Set-Cookie cru ANTES do filtro seguro
      const rawSetCookies = getHeaderList(
        d.responseHeaders as Record<string, string | string[]> | undefined,
        "set-cookie"
      );

      respAcc.set(d.id, {
        headers: safe,
        statusText: d.statusLine,
        bodyChunks: [],
        bodySize: 0,
        ...(rawSetCookies && rawSetCookies.length ? { rawSetCookies } : {}),
      });

      // Stream do corpo de resposta (quando disponível no Electron)
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
        stream.on("end", () => { try { stream.end(); } catch { /* noop */ } });
        stream.on("error", () => { try { stream.end(); } catch { /* noop */ } });
      }
    } finally {
      callback({});
    }
  };

  /* ------------------------------ onCompleted --------------------------- */
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
      } as RestResponsePayload);

      // Corpo em memória (opcional)
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

      // Algumas versões expõem 'fromCache' no objeto (não tipado)
      const withCache = d as OnCompletedListenerDetails & Partial<{ fromCache: boolean }>;
      if (withCache.fromCache !== undefined) capResp.fromCache = withCache.fromCache;

      // --------- CORS: destacar Access-Control-Allow-* ---------
      try {
        const aco = resHeaders["access-control-allow-origin"];
        const acm = resHeaders["access-control-allow-methods"];
        const ach = resHeaders["access-control-allow-headers"];
        const accred = resHeaders["access-control-allow-credentials"];
        const credBool = accred ? /^true$/i.test(accred.trim()) : undefined;

        if (aco || acm || ach || credBool !== undefined) {
          (capResp as CapResp & { corsAllow?: { origin?: string; methods?: string; headers?: string; credentials?: boolean } }).corsAllow = {
            ...(aco ? { origin: aco } : {}),
            ...(acm ? { methods: acm } : {}),
            ...(ach ? { headers: ach } : {}),
            ...(credBool !== undefined ? { credentials: credBool } : {}),
          };
        }
      } catch { /* noop */ }

      // --------- Set-Cookie → capResp.setCookies ---------
      try {
        const lines = acc?.rawSetCookies;
        if (lines && lines.length) {
          const redact = config.redactSecrets;
          const parsed = lines.map(parseSetCookie).map(c => ({
            name: c.name,
            value: redact ? "•••redacted•••" : c.value,
            flags: c.flags,
          }));
          if (parsed.length) {
            (capResp as CapResp & {
              setCookies?: Array<{ name: string; value: string; flags: Record<string, string | boolean> }>;
            }).setCookies = parsed;
          }
        }
      } catch { /* noop */ }

      // --------- Persistência opcional do corpo (usa opts.saveBody) ---------
      let savedBody: SavedBodyInfo | undefined;
      const allowByCt = !!ct && new RegExp(config.captureBodyTypes, "i").test(ct);
      const allowBySize = !!(bodyBuf && bodyBuf.byteLength <= config.captureBodyMaxBytes);
      if (config.captureBodies && bodyBuf && allowByCt && allowBySize && opts?.saveBody) {
        try {
          savedBody = opts.saveBody(String(d.id), bodyBuf, ct);
        } catch { /* noop */ }
      }
      if (savedBody) {
        (capResp as CapResp & { bodyFile?: string }).bodyFile = savedBody.path;
      }

      // Agregar e emitir transação
      const txn = onResp(capResp);
      if (txn) emit("cap:txn", txn);

      // Limpeza
      reqCtx.delete(d.id);
      respAcc.delete(d.id);
      // opcional: await resolveRemoteIp(d.url);
    })();
  };

  /* ---------------------------- onErrorOccurred ------------------------- */
  const onErrorOccurred = (d: OnErrorOccurredListenerDetails): void => {
    void (async () => {
      await resolveRemoteIp(d.url);
      emit("cap:rest:error", {
        ts: Date.now(), url: d.url, method: d.method, reqHeaders: {},
      } as RestRequestPayload);
    })();
  };

  /* ------------------------- Registrar / Detach ------------------------- */
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

  /**
   * @brief Cancela a captura e limpa todos os estados.
   */
  return (): void => {
    remover.onBeforeRequest(null);
    remover.onBeforeSendHeaders(null);
    remover.onHeadersReceived(null);
    remover.onCompleted(null);
    remover.onErrorOccurred(null);
    reqCtx.clear();
    respAcc.clear();
    preflights.clear();
  };
}
