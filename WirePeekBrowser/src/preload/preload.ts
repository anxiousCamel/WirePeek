/**
 * @file src/preload/preload.ts
 * @brief Exposição segura de IPC para a UI (renderer).
 */
import { contextBridge, ipcRenderer } from "electron";

type UiConfig = { targetUrl?: string; isDev?: boolean };

contextBridge.exposeInMainWorld("wirepeek", {
  start: async () => ipcRenderer.invoke("wirepeek:start"),
  stop:  async () => ipcRenderer.invoke("wirepeek:stop"),
  navigate: async (url: string) => ipcRenderer.invoke("wirepeek:navigate", url),

  // Tipado (sem any) e desacoplado de ipcRenderer
  onConfig: (cb: (cfg: UiConfig) => void): void => {
    ipcRenderer.on("ui:config", (_e, cfg: UiConfig) => cb(cfg));
  },
});

// API de controles da janela usada no renderer (window.win?.*)
contextBridge.exposeInMainWorld("win", {
  minimize:       (): Promise<unknown> => ipcRenderer.invoke("win:minimize"),
  toggleMaximize: (): Promise<{ maximized: boolean } | void> =>
    ipcRenderer.invoke("win:toggleMaximize"),
  close:          (): Promise<unknown> => ipcRenderer.invoke("win:close"),

  onMaximizedChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on("win:maximized-change", (_evt, maximized: boolean) => cb(maximized));
  },
  
});
