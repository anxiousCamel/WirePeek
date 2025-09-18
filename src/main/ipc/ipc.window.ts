/**
 * @file src/main/ipc/ipc.window.ts
 * @brief Registra IPCs de controle de janela e utilidades visuais (idempotente).
 *
 * Canais:
 *  - "win:minimize"        (renderer → main)  -> ipcRenderer.send()
 *  - "win:close"           (renderer → main)  -> ipcRenderer.send()
 *  - "win:toggleMaximize"  (renderer → main)  -> ipcRenderer.invoke()
 *  - "ui:set-bg"           (renderer → main)  -> ipcRenderer.send()
 *
 * Detalhes:
 *  - Antes de registrar, remove handlers/listeners anteriores (idempotência).
 *  - Usa BrowserWindow.fromWebContents(e.sender) para atuar na janela correta
 *    (a que enviou a mensagem), evitando dependência de foco.
 */

import { ipcMain, BrowserWindow, WebContents } from "electron";
import type { AppContext } from "../context.js";

/** Valida #rrggbb */
function isHex6(s: unknown): s is string {
  return typeof s === "string" && /^#([0-9a-f]{6})$/i.test(s);
}

function asWindowFromSender(sender: WebContents | undefined | null): BrowserWindow | null {
  try {
    if (!sender) return null;
    return BrowserWindow.fromWebContents(sender) ?? null;
  } catch {
    return null;
  }
}

/** Remove handlers/listeners antigos para permitir re-registro sem erro. */
function resetChannel(channel: string, kind: "handle" | "on") {
  try {
    if (kind === "handle") ipcMain.removeHandler(channel);
    else ipcMain.removeAllListeners(channel);
  } catch {
    /* noop */
  }
}

export function registerWindowIpc(_ctx: AppContext): void {
  // Limpa qualquer registro anterior (idempotência)
  resetChannel("win:minimize", "on");
  resetChannel("win:close", "on");
  resetChannel("ui:set-bg", "on");
  resetChannel("win:toggleMaximize", "handle");

  /** Minimiza a janela que enviou o IPC. */
  ipcMain.on("win:minimize", (e) => {
    try { asWindowFromSender(e.sender)?.minimize(); } catch { /* noop */ }
  });

  /** Alterna maximizado/restaurado e retorna o estado atual da janela que enviou o IPC. */
  ipcMain.handle("win:toggleMaximize", (e) => {
    try {
      const w = asWindowFromSender(e.sender);
      if (!w) return { maximized: false };
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
      return { maximized: w.isMaximized() };
    } catch {
      return { maximized: false };
    }
  });

  /** Fecha a janela que enviou o IPC. */
  ipcMain.on("win:close", (e) => {
    try { asWindowFromSender(e.sender)?.close(); } catch { /* noop */ }
  });

  /** Define a cor de fundo nativa da janela que enviou o IPC. */
  ipcMain.on("ui:set-bg", (e, hex: unknown) => {
    try {
      if (!isHex6(hex)) return;
      asWindowFromSender(e.sender)?.setBackgroundColor((hex as string).toLowerCase());
    } catch {
      /* noop */
    }
  });
}
