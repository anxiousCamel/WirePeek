// src/main/ipc/ipc.window.ts
import { ipcMain, BrowserWindow } from "electron";
import type { AppContext } from "../context";

export function registerWindowIpc(_ctx: AppContext) {
    ipcMain.handle("win:minimize", () => { BrowserWindow.getFocusedWindow()?.minimize(); });
    ipcMain.handle("win:toggleMaximize", () => {
        const w = BrowserWindow.getFocusedWindow(); if (!w) return;
        if (w.isMaximized()) w.unmaximize(); else w.maximize();
        return { maximized: w.isMaximized() };
    });
    ipcMain.handle("win:close", () => { BrowserWindow.getFocusedWindow()?.close(); });
}
