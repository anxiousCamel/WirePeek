/**
 * @file src/preload/preload.ts
 * @brief Bridge seguro (contextIsolation=true) para a UI principal.
 *        Exponho:
 *          - window.win: controles de janela
 *          - window.wirepeek: captura, navegação, eventos e config
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/* ============================================================================
 * Tipos públicos expostos ao renderer
 * ========================================================================== */
export type UiConfig = {
  targetUrl?: string;
  isDev?: boolean;
  /** caminho file:// para o preload do <webview> */
  wvPreload?: string;
};

export type CaptureState = { capturing: boolean };
type Unsubscribe = () => void;

/** Controles da janela focada. */
export interface WinAPI {
  /** Minimiza a janela focada. */
  minimize: () => Promise<unknown>;
  /** Alterna maximizar/restaurar. Retorna estado atual. */
  toggleMaximize: () => Promise<{ maximized: boolean } | void>;
  /** Fecha a janela focada. */
  close: () => Promise<unknown>;
  /** Observa mudanças de maximização. */
  onMaximizedChange: (cb: (maximized: boolean) => void) => Unsubscribe;
}

/** API de captura e utilidades para a UI. */
export interface WirepeekAPI {
  /** Inicia captura (abre Inspetor). */
  start: () => Promise<CaptureState>;
  /** Para captura. */
  stop: () => Promise<{ capturing: boolean; out?: unknown } | CaptureState>;
  /** Estado atual via IPC. */
  getState: () => Promise<CaptureState>;
  /** Estado em cache (sem IPC). */
  getCachedState: () => CaptureState;

  /** Navega a janela principal. */
  navigate: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  /** Abre a janela do Inspetor. */
  openInspector: () => Promise<unknown>;

  /** Encaminha envelopes de captura vindos do webview. */
  emitCapture: (channel: string, payload: unknown) => void;

  /** Recebe config inicial (targetUrl, wvPreload). */
  onConfig: (cb: (cfg: UiConfig) => void) => Unsubscribe;

  /** Observa mudanças de estado da captura (cap:state). */
  onState: (cb: (s: CaptureState) => void) => Unsubscribe;
}

/* ============================================================================
 * Ambiente global do renderer (TS)
 *  - Use opcional (?) para evitar conflito entre múltiplos preloads
 *  - __wvPreloadPath aceita undefined por causa de exactOptionalPropertyTypes
 * ========================================================================== */
declare global {
  interface Window {
    win?: WinAPI;
    wirepeek?: WirepeekAPI;
    __wvPreloadPath: string | undefined;
  }
}

/* ============================================================================
 * Utilidades internas
 * ========================================================================== */

/** Registra listener e devolve unsubscribe. */
function on<T>(
  channel: string,
  handler: (_e: IpcRendererEvent, data: T) => void
): Unsubscribe {
  const wrapped = (e: IpcRendererEvent, data: T) => handler(e, data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Cache leve do estado da captura. */
const stateCache: CaptureState = { capturing: false };

/* ============================================================================
 * Implementações
 * ========================================================================== */

/** ---------------- window.win ---------------- */
const winApi: WinAPI = {
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),
  close: () => ipcRenderer.invoke("win:close"),
  onMaximizedChange: (cb) => on<boolean>("win:maximized-change", (_e, v) => cb(v)),
};

/** ---------------- window.wirepeek ---------------- */
const wirepeekApi: WirepeekAPI = {
  start: async () => {
    const s = (await ipcRenderer.invoke("wirepeek:start")) as CaptureState;
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  stop: async () => {
    const s = (await ipcRenderer.invoke("wirepeek:stop")) as {
      capturing: boolean;
      out?: unknown;
    };
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  getState: async () => {
    const s = (await ipcRenderer.invoke("wirepeek:getState")) as CaptureState;
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  getCachedState: () => ({ ...stateCache }),

  navigate: (url: string) => ipcRenderer.invoke("wirepeek:navigate", url),

  openInspector: () => ipcRenderer.invoke("inspector:open"),

  emitCapture: (channel: string, payload: unknown) =>
    ipcRenderer.send("cap:from-webview", { channel, payload }),

  onConfig: (cb) =>
    on<UiConfig>("ui:config", (_e, cfg) => {
      // salva/limpa o caminho do preload do <webview> no escopo global da UI
      window.__wvPreloadPath =
        typeof cfg?.wvPreload === "string" ? cfg.wvPreload : undefined;
      cb(cfg);
    }),

  onState: (cb) =>
    on<CaptureState>("cap:state", (_e, s) => {
      stateCache.capturing = !!s?.capturing;
      cb(s);
    }),
};

/* ============================================================================
 * Exposição segura
 * ========================================================================== */

contextBridge.exposeInMainWorld("win", winApi);
contextBridge.exposeInMainWorld("wirepeek", wirepeekApi);
