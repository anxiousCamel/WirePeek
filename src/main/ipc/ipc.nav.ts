// src/main/ipc/ipc.nav.ts
import { ipcMain } from "electron";
import type { AppContext } from "../context";

export function registerNavIpc(ctx: AppContext) {
    ipcMain.handle("wirepeek:navigate", (_evt, url: string) => {
        if (!ctx.mainWin) return { ok: false as const, error: "Sem janela principal" as const };
        if (!url) return { ok: false as const, error: "URL vazia" as const };
        try { new URL(url); } catch { return { ok: false as const, error: "URL inválida" as const }; }
        ctx.mainWin.loadURL(url);
        return { ok: true as const };
    });
}
