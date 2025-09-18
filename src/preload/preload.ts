/**
 * @file src/preload/preload.ts
 * @brief Bridge seguro (contextIsolation=true) entre renderer e processo principal.
 *
 * Expõe em window:
 *  - window.win:
 *      * minimize(), toggleMaximize(), close()
 *      * onMaximizedChange(cb)
 *      * setBackground(hex)  → sincroniza cor nativa da BrowserWindow
 *  - window.wirepeek:
 *      * start()/stop()/getState()/getCachedState()
 *      * navigate(url), openInspector()
 *      * emitCapture(channel, payload)   → payload sanitizado p/ IPC
 *      * onConfig(cb)                    → define __wvPreloadPath / __wvPartition
 *      * onState(cb)                     → cache atualizado em push
 *
 * Canais esperados no main:
 *   "win:minimize" (on), "win:close" (on), "win:toggleMaximize" (handle),
 *   "ui:set-bg" (on),   "win:maximized-change" (send),
 *   "wirepeek:start|stop|getState|navigate" (handle), "inspector:open" (handle),
 *   "cap:from-webview" (on), "ui:config" (send), "cap:state" (send).
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/* ───────────────────────── Tipos públicos ───────────────────────── */

export type UiConfig = {
  targetUrl?: string;
  isDev?: boolean;
  /** caminho file:// do preload do <webview> */
  wvPreload?: string;
  /** partition do <webview> (ex.: "persist:wirepeek") */
  wvPartition?: string;
};

export type CaptureState = { capturing: boolean };

/** Função de desinscrição de listeners. */
type Unsubscribe = () => void;

/** Controles de janela focada. */
export interface WinAPI {
  /** Minimiza a janela focada. */
  minimize: () => void;
  /** Alterna maximizar/restaurar. Retorna estado atual. */
  toggleMaximize: () => Promise<{ maximized: boolean } | void>;
  /** Fecha a janela focada. */
  close: () => void;
  /** Observa mudanças de maximização. */
  onMaximizedChange: (cb: (maximized: boolean) => void) => Unsubscribe;
  /** Define a cor nativa do fundo da janela (#rrggbb). */
  setBackground: (hex: string) => void;
}

/** API geral da UI (captura, inspector, navegação). */
export interface WirepeekAPI {
  /** Inicia a captura (tipicamente abre/mostra o Inspector). */
  start: () => Promise<CaptureState>;
  /** Para a captura. */
  stop: () => Promise<{ capturing: boolean; out?: unknown } | CaptureState>;
  /** Busca estado atual via IPC. */
  getState: () => Promise<CaptureState>;
  /** Lê o estado em cache (sem IPC). */
  getCachedState: () => CaptureState;

  /** Navega a janela principal para uma URL. */
  navigate: (url: string) => Promise<{ ok: true } | { ok: false; error: string }>;

  /** Abre (ou foca) o Inspector. */
  openInspector: () => Promise<unknown>;

  /** Encaminha envelopes de captura vindos do <webview> (guest → main). */
  emitCapture: (channel: string, payload: unknown) => void;

  /** Recebe config inicial (targetUrl, wvPreload, wvPartition). */
  onConfig: (cb: (cfg: UiConfig) => void) => Unsubscribe;

  /** Observa mudanças de estado da captura. */
  onState: (cb: (s: CaptureState) => void) => Unsubscribe;
}

/* ───────────────────────── Utilitários internos ───────────────────────── */

/** Registra listener em canal e devolve unsubscribe. */
function on<T>(
  channel: string,
  handler: (_e: IpcRendererEvent, data: T) => void
): Unsubscribe {
  const wrapped = (e: IpcRendererEvent, data: T) => handler(e, data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Valida #rrggbb. */
function isHex6(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-f]{6})$/i.test(s);
}

/**
 * Sanitiza um objeto para transporte por IPC (evita “An object could not be cloned”).
 * Remove estruturas não-serializáveis e valores cíclicos.
 */
function safeIpcPayload<T>(x: T): T | { _unserializable: true } {
  try {
    return JSON.parse(JSON.stringify(x)) as T;
  } catch {
    return { _unserializable: true } as const;
  }
}

/** Cache leve de estado de captura (evita round-trips em leituras frequentes). */
const stateCache: CaptureState = { capturing: false };

/* ───────────────────────── window.win ───────────────────────── */

const winApi: WinAPI = {
  // No main estes canais são .on() (fire-and-forget), então usamos send().
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),

  // No main este canal é .handle(), então usamos invoke() para ter retorno.
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),

  // Listener para refletir mudanças do estado de maximização no renderer.
  onMaximizedChange: (cb) =>
    on<boolean>("win:maximized-change", (_e, maximized) => cb(!!maximized)),

  // Sincroniza a cor de fundo nativa (BrowserWindow#setBackgroundColor).
  setBackground: (hex: string) => {
    if (isHex6(hex)) ipcRenderer.send("ui:set-bg", hex);
  },
};

/* ───────────────────────── window.wirepeek ───────────────────────── */

const wirepeekApi: WirepeekAPI = {
  async start() {
    const s = (await ipcRenderer.invoke("wirepeek:start")) as CaptureState;
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  async stop() {
    const s = (await ipcRenderer.invoke("wirepeek:stop")) as {
      capturing: boolean;
      out?: unknown;
    };
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  async getState() {
    const s = (await ipcRenderer.invoke("wirepeek:getState")) as CaptureState;
    stateCache.capturing = !!s?.capturing;
    return s;
  },

  getCachedState: () => ({ ...stateCache }),

  navigate: (url: string) => ipcRenderer.invoke("wirepeek:navigate", url),

  openInspector: () => ipcRenderer.invoke("inspector:open"),

  emitCapture: (channel: string, payload: unknown) => {
    // payload sanitizado para garantir clonagem pelo IPC
    ipcRenderer.send("cap:from-webview", { channel, payload: safeIpcPayload(payload) });
  },

  onConfig: (cb) =>
    on<UiConfig>("ui:config", (_e, cfg) => {
      // __wvPreloadPath
      if (typeof cfg?.wvPreload === "string") {
        window.__wvPreloadPath = cfg.wvPreload;
      } else {
        delete window.__wvPreloadPath; // evita atribuir undefined com exactOptionalPropertyTypes
      }

      // __wvPartition
      if (typeof cfg?.wvPartition === "string") {
        window.__wvPartition = cfg.wvPartition;
      } else {
        delete window.__wvPartition;
      }

      cb(cfg);
    }),

  onState: (cb) =>
    on<CaptureState>("cap:state", (_e, s) => {
      stateCache.capturing = !!s?.capturing;
      cb(s);
    }),
};

/* ───────────────────────── Exposição segura ───────────────────────── */

contextBridge.exposeInMainWorld("win", winApi);
contextBridge.exposeInMainWorld("wirepeek", wirepeekApi);
