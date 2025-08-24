/**
 * @file src/preload/preload.inspector.ts
 * @brief Bridge seguro para a janela do Inspetor.
 *        Exponho:
 *          - window.win: controles da janela do Inspetor
 *          - window.wirepeek: leitura de estado e stream de eventos cap-event
 */

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { CaptureState, WirepeekAPI } from "./preload"; // reaproveita os tipos

type Unsubscribe = () => void;

/* ============================================================================
 * Declaração global coerente com o outro preload (opcional)
 * ========================================================================== */
declare global {
  interface Window {
    win?: {
      minimize: () => Promise<unknown>;
      toggleMaximize: () => Promise<{ maximized: boolean } | void>;
      close: () => Promise<unknown>;
      onMaximizedChange: (cb: (maximized: boolean) => void) => Unsubscribe;
    };
    wirepeek?: WirepeekAPI;
  }
}

/* ============================================================================
 * Util
 * ========================================================================== */
function on<T>(
  channel: string,
  handler: (_e: IpcRendererEvent, data: T) => void
): Unsubscribe {
  const wrapped = (e: IpcRendererEvent, data: T) => handler(e, data);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/* ============================================================================
 * APIs
 * ========================================================================== */

const winApi = {
  minimize: () => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("win:toggleMaximize"),
  close: () => ipcRenderer.invoke("win:close"),
  onMaximizedChange: (cb: (v: boolean) => void) =>
    on<boolean>("win:maximized-change", (_e, v) => cb(v)),
};

const wirepeekInspectorApi = {
  getState: () => ipcRenderer.invoke("wirepeek:getState") as Promise<CaptureState>,

  onState: (cb: (s: CaptureState) => void) =>
    on<CaptureState>("cap:state", (_e, s) => cb(s)),

  onCapEvent: (
    cb: (env: { channel: string; payload: unknown }) => void
  ) => on<{ channel: string; payload: unknown }>("cap-event", (_e, env) => cb(env)),
};

/* ============================================================================
 * Exposição segura
 * ========================================================================== */
contextBridge.exposeInMainWorld("win", winApi);
contextBridge.exposeInMainWorld("wirepeek", wirepeekInspectorApi);
