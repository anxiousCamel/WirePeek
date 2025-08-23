// src/preload/preload.ts
/**
 * @file src/preload/preload.ts
 * @brief Exposição segura de IPC para a UI (renderer).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

type UiConfig = { targetUrl?: string; isDev?: boolean; wvPreload?: string };

// >>> ajuste aqui: permitir undefined explicitamente (exactsOptionalPropertyTypes)
declare global {
  interface Window {
    __wvPreloadPath: string | undefined; // <-- em vez de `__wvPreloadPath?: string`
  }
}

contextBridge.exposeInMainWorld("wirepeek", {
  start: async (): Promise<unknown> => ipcRenderer.invoke("wirepeek:start"),
  stop:  async (): Promise<unknown> => ipcRenderer.invoke("wirepeek:stop"),
  navigate: async (url: string): Promise<unknown> =>
    ipcRenderer.invoke("wirepeek:navigate", url),

  emitCapture: (channel: string, payload: unknown): void =>
    ipcRenderer.send("cap:from-webview", { channel, payload }),

  onConfig: (cb: (cfg: UiConfig) => void): void => {
    ipcRenderer.on("ui:config", (_e: IpcRendererEvent, cfg: UiConfig) => {
      // pendura caminho para o webview preload na window (renderer)
      window.__wvPreloadPath = cfg.wvPreload ?? undefined; 
      cb(cfg);
    });
  },
});

// API de controles da janela usada no renderer (window.win?.*)
contextBridge.exposeInMainWorld("win", {
  minimize:       (): Promise<unknown> => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: (): Promise<{ maximized: boolean } | void> =>
    ipcRenderer.invoke("win:toggleMaximize"),
  close:          (): Promise<unknown> => ipcRenderer.invoke("win:close"),

  onMaximizedChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on("win:maximized-change", (_evt: IpcRendererEvent, maximized: boolean) => cb(maximized));
  },
});
