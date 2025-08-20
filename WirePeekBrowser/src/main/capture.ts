/**
 * @file NetworkCapture.ts
 * @brief Captura e loga tráfego de rede em um `BrowserWindow` do Electron,
 *        com suporte a DNS reverse e cache local de IPs.
 *
 * @details
 *  - Usa os eventos de `webRequest` da sessão do Electron.
 *  - Loga fases: request, headers, response e error.
 *  - Inclui headers limitados (whitelist) para evitar excesso de dados.
 *  - Resolve IP remoto com cache DNS.
 *  - Retorna uma função `detach()` para remover todos os listeners.
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

/** Cache de resolução DNS: hostname -> IP */
const dnsCache = new Map<string, string>();

/**
 * Resolve IP do host remoto com cache local.
 * @param requestUrl URL da requisição.
 * @returns IP do host ou `"N/D"` caso não resolvido.
 */
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

/**
 * Normaliza headers em um mapa seguro.
 * @param headers Headers originais da requisição/resposta.
 * @returns Mapa filtrado de headers permitidos.
 */
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

/** -------------------- BUILDERS DE LOG -------------------- */

/**
 * Monta log da fase "request".
 */
function buildRequestLog(d: OnBeforeRequestListenerDetails) {
  return {
    phase: "request" as const,
    id: d.id,
    url: d.url,
    method: d.method,
    resourceType: d.resourceType,
    timestamp: Date.now(),
  };
}

/**
 * Monta log da fase "before-send-headers".
 */
function buildBeforeSendHeadersLog(d: OnBeforeSendHeadersListenerDetails) {
  return {
    phase: "before-send-headers" as const,
    id: d.id,
    url: d.url,
    method: d.method,
    requestHeaders: toSafeHeaderMap(d.requestHeaders),
    timestamp: Date.now(),
  };
}

/**
 * Monta log da fase "response" (com IP remoto).
 */
async function buildResponseLog(d: OnCompletedListenerDetails) {
  const ip = await resolveRemoteIp(d.url);
  return {
    phase: "response" as const,
    id: d.id,
    url: d.url,
    method: d.method,
    resourceType: d.resourceType,
    statusCode: d.statusCode,
    fromCache: d.fromCache,
    responseHeaders: toSafeHeaderMap(
      d.responseHeaders as Record<string, string[]> | undefined
    ),
    ip,
    timestamp: Date.now(),
  };
}

/**
 * Monta log da fase "error" (com IP remoto).
 */
async function buildErrorLog(d: OnErrorOccurredListenerDetails) {
  const ip = await resolveRemoteIp(d.url);
  return {
    phase: "error" as const,
    id: d.id,
    url: d.url,
    method: d.method,
    resourceType: d.resourceType,
    error: d.error,
    ip,
    timestamp: Date.now(),
  };
}
/** ---------------------------------------------------------- */

/**
 * Atacha captura de tráfego a um `BrowserWindow`.
 *
 * @param win Janela alvo (`BrowserWindow`) do Electron.
 * @returns Função `detach()` que remove todos os listeners.
 *
 * @example
 * ```ts
 * const detach = attachNetworkCapture(mainWindow);
 * // ... usar navegador
 * detach(); // remove listeners
 * ```
 */
export function attachNetworkCapture(win: BrowserWindow): () => void {
  const ses = win.webContents.session;
  const filter: WebRequestFilter = { urls: ["*://*/*"] };

  /** Captura inicial da requisição */
  const onBeforeRequest = (
    d: OnBeforeRequestListenerDetails,
    callback: (resp: { cancel?: boolean; redirectURL?: string }) => void
  ): void => {
    try {
      console.log("[REQ]", JSON.stringify(buildRequestLog(d)));
    } finally {
      callback({}); // segue fluxo normal
    }
  };

  /** Captura headers antes de envio */
  const onBeforeSendHeaders = (
    d: OnBeforeSendHeadersListenerDetails,
    callback: (resp: { cancel?: boolean; requestHeaders?: Record<string, string> }) => void
  ): void => {
    try {
      console.log("[HDR]", JSON.stringify(buildBeforeSendHeadersLog(d)));
    } finally {
      callback({}); // segue fluxo normal
    }
  };

  /** Captura de resposta finalizada */
  const onCompleted = (d: OnCompletedListenerDetails): void => {
    void (async () => {
      const log = await buildResponseLog(d);
      console.log("[RES]", JSON.stringify(log));
    })();
  };

  /** Captura de erro de rede */
  const onErrorOccurred = (d: OnErrorOccurredListenerDetails): void => {
    void (async () => {
      const log = await buildErrorLog(d);
      console.warn("[ERR]", JSON.stringify(log));
    })();
  };

  // Registrar listeners
  ses.webRequest.onBeforeRequest(filter, onBeforeRequest);
  ses.webRequest.onBeforeSendHeaders(filter, onBeforeSendHeaders);
  ses.webRequest.onCompleted(filter, onCompleted);
  ses.webRequest.onErrorOccurred(filter, onErrorOccurred);

  /** 
   * Remoção segura de todos listeners.
   * Electron typings não expõem overload `null`,
   * então usamos cast estrutural para suportar.
   */
  type RemoveAll = (filter: null) => void;
  const remover = ses.webRequest as unknown as {
    onBeforeRequest: RemoveAll;
    onBeforeSendHeaders: RemoveAll;
    onCompleted: RemoveAll;
    onErrorOccurred: RemoveAll;
  };

  /** Função para desligar captura */
  const detach = (): void => {
    remover.onBeforeRequest(null);
    remover.onBeforeSendHeaders(null);
    remover.onCompleted(null);
    remover.onErrorOccurred(null);
  };

  return detach;
}
