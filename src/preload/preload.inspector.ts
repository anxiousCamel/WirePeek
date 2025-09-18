/**
 * @file src/preload/preload.inspector.ts
 * @brief Bridge seguro (contextIsolation=true) para a janela do Inspector.
 *
 * O que este preload expõe no `window`:
 *  - window.win:
 *      * minimize() / toggleMaximize() / close()
 *      * onMaximizedChange(cb)
 *      * setBackground(hex) → sincroniza a cor nativa do Inspector
 *  - window.wirepeek (API do Inspector):
 *      * getState()              → busca estado de captura no main
 *      * onState(cb)             → assina atualizações do estado (push)
 *      * onCapEvent(cb)          → stream de eventos de captura normalizados
 *
 * Canais esperados no processo principal (compatível com ipc.window.ts):
 *   "win:minimize"        (ipcMain.on)
 *   "win:close"           (ipcMain.on)
 *   "win:toggleMaximize"  (ipcMain.handle)
 *   "ui:set-bg"           (ipcMain.on)
 *   "win:maximized-change"(win.on("maximize"/"unmaximize") → webContents.send)
 *
 *   "wirepeek:getState"   (ipcMain.handle)
 *   "cap:state"           (main → renderer)
 *   "cap-event"           (main → renderer)
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/* ───────────────────────── Tipos locais ───────────────────────── */

type Unsubscribe = () => void;

/** Estado mínimo da captura utilizado pelo Inspector. */
export type CaptureState = { capturing: boolean };

/** API de janela (mesma forma usada no preload principal). */
export interface WinAPI {
  minimize: () => void;
  toggleMaximize: () => Promise<{ maximized: boolean } | void>;
  close: () => void;
  onMaximizedChange: (cb: (maximized: boolean) => void) => Unsubscribe;
  setBackground: (hex: string) => void;
}

/** API específica do Inspector. */
export interface WirepeekInspectorAPI {
  getState: () => Promise<CaptureState>;
  onState: (cb: (s: CaptureState) => void) => Unsubscribe;
  onCapEvent: (cb: (env: { channel: string; payload: unknown }) => void) => Unsubscribe;
}

/* ───────────────────────── Utilitários ───────────────────────── */

/** Registra listener em um canal e retorna função de unsubscribe. */
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

/* ───────────────────────── window.win (Inspector) ───────────────────────── */

const winApi: WinAPI = {
  // No main estes canais são .on() → aqui usamos send()
  minimize: () => ipcRenderer.send("win:minimize"),
  close: () => ipcRenderer.send("win:close"),

  // No main este canal é .handle() → aqui usamos invoke()
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),

  // Reflete mudanças de maximização (útil para trocar ícone/UX no Inspector)
  onMaximizedChange: (cb) =>
    on<boolean>("win:maximized-change", (_e, maximized) => cb(!!maximized)),

  // Sincroniza cor nativa da janela do Inspector
  setBackground: (hex: string) => {
    if (isHex6(hex)) ipcRenderer.send("ui:set-bg", hex);
  },
};

/* ───────────────────────── window.wirepeek (Inspector) ───────────────────────── */

const wirepeekInspectorApi: WirepeekInspectorAPI = {
  /** Lê o estado de captura atual no processo principal. */
  getState: () => ipcRenderer.invoke("wirepeek:getState") as Promise<CaptureState>,

  /** Assina atualizações de estado (push do main). */
  onState: (cb) => on<CaptureState>("cap:state", (_e, s) => cb(s)),

  /**
   * Stream de eventos de captura normalizados pelo main.
   * Estrutura: { channel: string, payload: unknown }
   */
  onCapEvent: (cb) =>
    on<{ channel: string; payload: unknown }>("cap-event", (_e, env) => cb(env)),
};

/* ───────────────────────── Exposição segura ───────────────────────── */

contextBridge.exposeInMainWorld("win", winApi);
contextBridge.exposeInMainWorld("wirepeek", wirepeekInspectorApi);
