// WirePeekBrowser/src/main/capture.ts
/**
 * @file NetworkCapture.ts
 * Captura tráfego via webRequest e (além de logar) emite eventos tipados
 * para quem chamar attachNetworkCapture(win, onEvent).
 */

import type {
  BrowserWindow,
  WebRequestFilter,
  OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
} from "electron";
import dns from "dns";
import { URL } from "url";

/** ===== Tipos compartilhados com main (mesma forma do webview) ===== */
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
  | "cap:rest:response"
  | "cap:rest:before-send-headers"
  | "cap:rest:error";

export type CapEvent = {
  channel: CapChannel;
  payload: RestRequestPayload | RestResponsePayload | Record<string, unknown>;
};

type OnEventFn = (channel: CapChannel, payload: CapEvent["payload"]) => void;

/** ===== util: DNS com cache ===== */
const dnsCache = new Map<string, string>();

async function resolveRemoteIp(requestUrl: string): Promise<string> {
  try {
    const hostname = new URL(requestUrl).hostname;
    if (!hostname) return "N/D";
    const hit = dnsCache.get(hostname);
    if (hit) return hit;
    const ip = await new Promise<string>((resolve) => {
      dns.lookup(hostname, (err, address) => resolve(err ? "N/D" : address));
    });
    if (ip !== "N/D") dnsCache.set(hostname, ip);
    return ip;
  } catch {
    return "N/D";
  }
}

/** headers → Record<string,string> com whitelist */
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
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!allow.has(key)) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/** ===== contexto interno por requestId ===== */
type ReqCtx = {
  startedAt: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
};
const ctxById = new Map<number, ReqCtx>();

/** ====== FUNÇÃO PRINCIPAL ====== */
export function attachNetworkCapture(
  win: BrowserWindow,
  onEvent?: OnEventFn
): () => void {
  const ses = win.webContents.session;
  const filter: WebRequestFilter = { urls: ["*://*/*"] };
  const emit = (channel: CapChannel, payload: CapEvent["payload"]): void => {
    try {
      onEvent?.(channel, payload);
    } catch {
      // noop
    }
  };

  /** request start */
  const onBeforeRequest = (
    d: OnBeforeRequestListenerDetails,
    callback: (resp: { cancel?: boolean; redirectURL?: string }) => void
  ): void => {
    try {
      // cria/atualiza contexto
      ctxById.set(d.id, {
        startedAt: Date.now(),
        method: d.method,
        url: d.url,
        reqHeaders: {},
      });

      // opcional: log no terminal
      // console.log("[REQ]", JSON.stringify({ id: d.id, url: d.url, method: d.method }));

      // emite um "request" no formato RestRequestPayload (sem body)
      const payload: RestRequestPayload = {
        ts: Date.now(),
        url: d.url,
        method: d.method,
        reqHeaders: {},
      };
      emit("cap:rest:request", payload);
    } finally {
      callback({});
    }
  };

  /** request headers */
  const onBeforeSendHeaders = (
    d: OnBeforeSendHeadersListenerDetails,
    callback: (resp: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
  ): void => {
    try {
      const ctx = ctxById.get(d.id);
      if (ctx) {
        ctx.reqHeaders = toSafeHeaderMap(d.requestHeaders);
      }
      emit("cap:rest:before-send-headers", {
        ts: Date.now(),
        url: d.url,
        method: d.method,
        reqHeaders: toSafeHeaderMap(d.requestHeaders),
      } satisfies RestRequestPayload);
    } finally {
      callback({});
    }
  };

  /** response completed */
  const onCompleted = (d: OnCompletedListenerDetails): void => {
    void (async () => {
      const now = Date.now();
      const ctx = ctxById.get(d.id);
      const timing = ctx ? now - ctx.startedAt : 0;
      const resHeaders = toSafeHeaderMap(
        d.responseHeaders as Record<string, string[]> | undefined
      );

      // opcional: enriquecimento com IP remoto (não usado na UI atual)
      // const ip = await resolveRemoteIp(d.url);

      const payload: RestResponsePayload = {
        ts: now,
        url: d.url,
        method: d.method,
        status: d.statusCode,
        statusText: "", // Electron não expõe statusText aqui
        resHeaders,
        bodySize: 0, // webRequest não dá o corpo; manter 0
        timingMs: timing,
      };

      // console.log("[RES]", JSON.stringify({ ...payload, id: d.id }));
      emit("cap:rest:response", payload);

      // limpa contexto
      ctxById.delete(d.id);
    })();
  };

  /** network error */
  const onErrorOccurred = (d: OnErrorOccurredListenerDetails): void => {
    void (async () => {
      // opcional: ip
      await resolveRemoteIp(d.url);
      emit("cap:rest:error", {
        ts: Date.now(),
        url: d.url,
        method: d.method,
        reqHeaders: {},
      } satisfies RestRequestPayload);
      // não removo contexto aqui porque pode haver retries
    })();
  };

  // registra
  ses.webRequest.onBeforeRequest(filter, onBeforeRequest);
  ses.webRequest.onBeforeSendHeaders(filter, onBeforeSendHeaders);
  ses.webRequest.onCompleted(filter, onCompleted);
  ses.webRequest.onErrorOccurred(filter, onErrorOccurred);

  /** detach seguro */
  type RemoveAll = (filter: null) => void;
  const remover = ses.webRequest as unknown as {
    onBeforeRequest: RemoveAll;
    onBeforeSendHeaders: RemoveAll;
    onCompleted: RemoveAll;
    onErrorOccurred: RemoveAll;
  };

  return (): void => {
    remover.onBeforeRequest(null);
    remover.onBeforeSendHeaders(null);
    remover.onCompleted(null);
    remover.onErrorOccurred(null);
    ctxById.clear();
  };
}
