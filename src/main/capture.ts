/**
 * @file src/main/capture.ts
 * @brief Captura HTTP(S) via session.webRequest, agrega req+resp e emite:
 *   - "cap:rest:request" | "cap:rest:before-send-headers" | "cap:rest:response" | "cap:rest:error"
 *   - "cap:txn" (transação consolidada para o Inspetor)
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
// opcional (diagnóstico)
import dns from "dns";
import { URL } from "url";

import { config } from "./config";
import { onReq, onResp } from "./capture.agg";
import type {
  CapReq,
  CapResp,      // ⚠ Garanta que este tipo tenha `bodyFile?: string`
  CapTiming,
  HttpMethod,
  CapTxn
} from "../common/capture.types";

// Garantia: mesmo que haja algum import duplicado durante a refatoração,
// esta extensão assegura que CapResp tenha `bodyFile`.
declare module "../common/capture.types" {
  interface CapResp {
    bodyFile?: string;
  }
}


/* ============================================================================
 *                              Tipos de evento
 * ========================================================================== */

/** Evento granular emitido ao iniciar uma request (fetch/xhr/webRequest). */
export type RestRequestPayload = {
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
};

/** Evento granular emitido ao finalizar a response (headers + métricas). */
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

/** Canais suportados de emissão para UIs (renderer/inspector). */
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

/** Descriptor retornado por `saveBody` quando persistimos corpo em disco. */
type SavedBodyInfo = { path: string; size: number; contentType?: string };

/** Callback opcional para salvar body em disco (injetado por quem tem a sessão). */
type SaveBodyFn = (
  idHint: string,
  buf: Uint8Array,
  contentType?: string
) => SavedBodyInfo;

/* ============================================================================
 *                                   Utils
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
 * @brief Decodifica corpo de acordo com Content-Encoding (gzip/deflate/br).
 * @param buf  Conteúdo bruto.
 * @param headers Headers de resposta normalizados.
 * @returns Buffer decodificado (ou o original se não suportado).
 */
function decodeBody(buf: Uint8Array, headers: Record<string, string>): Uint8Array {
  const enc = (headers["content-encoding"] || headers["Content-Encoding"] || "").toLowerCase();
  try {
    const nodeBuf = Buffer.from(buf);
    if (enc.includes("gzip")) return new Uint8Array(zlib.gunzipSync(nodeBuf));
    if (enc.includes("deflate")) return new Uint8Array(zlib.inflateSync(nodeBuf));
    if (enc.includes("br")) return new Uint8Array(zlib.brotliDecompressSync(nodeBuf));
  } catch { /* noop */ }
  return buf;
}

/**
 * @brief Filtra/normaliza um conjunto de headers para chaves e valores simples.
 * @param headers Headers heterogêneos (string | string[]).
 * @returns Mapa com subset seguro de headers.
 */
function toSafeHeaderMap(
  headers: Record<string, string | string[]> | undefined
): Record<string, string> {
  if (!headers) return {};
  // Atenção: inclui Authorization/Cookie somente se NÃO estiver redatando segredos
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

/** Cache simples para resolução DNS opcional (diagnóstico). */
const dnsCache = new Map<string, string>();

/**
 * @brief Resolve e cacheia IP remoto a partir de uma URL.
 * @param requestUrl URL do pedido.
 * @returns IP ou "N/D".
 */
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

/**
 * @brief Normaliza método HTTP para o union `HttpMethod`.
 * @param m Método informado.
 * @returns Método válido (fallback GET).
 */
function toHttpMethod(m: string): HttpMethod {
  const u = m.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(u)) return u as HttpMethod;
  return "GET";
}

/**
 * @brief Converte valores `ArrayBuffer | Buffer` em `Uint8Array` (sem `any`).
 * @param data Buffer nativo ou ArrayBuffer.
 */
function bytesToU8(data: ArrayBuffer | Buffer): Uint8Array {
  type BufferCtor = typeof Buffer & { isBuffer?(x: unknown): x is Buffer };
  const Buf = Buffer as BufferCtor;
  return (typeof Buf?.isBuffer === "function" && Buf.isBuffer(data))
    ? new Uint8Array(data)
    : new Uint8Array(data as ArrayBuffer);
}

/* ============================================================================
 *                     Estado interno (indexado por requestId)
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
};
const respAcc = new Map<number, RespAccum>();

/* ============================================================================
 *                      Tipagem do filtro de resposta
 * ========================================================================== */

/** Mínimo necessário para stream de resposta (Electron). */
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
/**
 * @brief Obtém (com bind) `filterResponseData` se existir, evitando "not a function".
 */
function getFilterFn(obj: unknown): ((id: number) => ResponseFilter) | undefined {
  const maybe = obj as Partial<WebRequestWithFilter> | undefined;
  const fn = maybe?.filterResponseData;
  return typeof fn === "function" ? fn.bind(maybe) : undefined;
}

/* ============================================================================
 *                                    Core
 * ========================================================================== */

/**
 * @brief Junta todos os chunks de `uploadData` (quando presentes em memória).
 *
 * `uploadData` pode conter três formas (tipos do Electron):
 *  - `{ bytes: Buffer }`                 → suportado (concatena)
 *  - `{ file: string, ... }`             → ignorado (não lê disco)
 *  - `{ blobUUID: string }`              → ignorado (Blob por UUID)
 */
type UploadItem = NonNullable<OnBeforeRequestListenerDetails["uploadData"]>[number];
type UploadRawLike = { bytes: ArrayBuffer | Buffer };

function uploadItemToBytes(u: UploadItem): Uint8Array | undefined {
  // Narrow por presença de 'bytes' sem usar 'any'
  if (Object.prototype.hasOwnProperty.call(u as object, "bytes")) {
    const raw = (u as UploadRawLike).bytes;
    if (raw) return bytesToU8(raw);
  }
  return undefined;
}

/**
 * @brief Concatena os bytes de `uploadData` em um único buffer.
 * @param list Lista de itens do upload (ou undefined).
 */
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
 * @brief Registra hooks de captura na sessão da janela e retorna função de detach.
 * @param win     Janela principal (fonte da `session` a ser capturada).
 * @param onEvent Callback para encaminhar eventos às UIs/persistência.
 * @param opts    Opções; pode conter `saveBody` para persistir corpos em disco.
 * @returns Função para remover todos os hooks e limpar estado.
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
      respAcc.set(d.id, {
        headers: safe,
        statusText: d.statusLine,
        bodyChunks: [],
        bodySize: 0,
      });

      // Feature-detect do suporte a filterResponseData (nem todas versões expõem)
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

      // --- corpo em memória (opcional) ---
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

      // ================= (b) Decidir quando gravar em disco =================
      // Regra: respeita config.captureBodies + content-type permitido + limite de bytes
      let savedBody: SavedBodyInfo | undefined;
      const allowByCt = !!ct && new RegExp(config.captureBodyTypes, "i").test(ct);
      const allowBySize = !!(bodyBuf && bodyBuf.byteLength <= config.captureBodyMaxBytes);

      if (config.captureBodies && bodyBuf && allowByCt && allowBySize && opts?.saveBody) {
        try {
          savedBody = opts.saveBody(String(d.id), bodyBuf, ct);
        } catch {
          // falhas de IO não devem quebrar a captura
        }
      }
      if (savedBody) {
        // ⚠ Requer que CapResp tenha esta propriedade opcional
        capResp.bodyFile = savedBody.path;
      }
      // =====================================================================

      const txn = onResp(capResp);
      if (txn) emit("cap:txn", txn);

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
   * @returns void
   */
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
