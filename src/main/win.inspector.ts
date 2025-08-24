// src/main/win.inspector.ts
import { BrowserWindow } from "electron";
import { inspectorAssets } from "./assets";
import type { AppContext } from "./context";

export function openInspector(ctx: AppContext, parent: BrowserWindow): void {
    if (ctx.inspectorWin && !ctx.inspectorWin.isDestroyed()) {
        ctx.inspectorWin.show(); ctx.inspectorWin.focus(); return;
    }
    const { html, preload } = inspectorAssets();

    const w = new BrowserWindow({
        width: 900,
        height: 600,
        minWidth: 720,
        minHeight: 420,
        backgroundColor: "#0f0f10",
        frame: false,
        titleBarStyle: "hidden",
        autoHideMenuBar: true,
        parent,
        webPreferences: {
            session: ctx.userSession,
            contextIsolation: true,
            nodeIntegration: false,
            preload,
        },
    });

    w.removeMenu();
    w.loadFile(html);
    w.on("closed", () => ctx.setInspectorWin(null));
    ctx.setInspectorWin(w);
}

export function hideInspector(ctx: AppContext): void {
    const w = ctx.inspectorWin;
    if (w && !w.isDestroyed()) w.hide();
}
