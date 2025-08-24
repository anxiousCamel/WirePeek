// src/main/app.ts
import { app, BrowserWindow } from "electron";
import { createUserSession } from "./session.profile";
import { createMainWindow } from "./win.main";
import { registerAllIpc } from "./ipc";
import type { AppContext } from "./context";

const isDev =
    process.env.NODE_ENV === "development" ||
    process.env.ELECTRON_ENV === "development" ||
    !app.isPackaged;

const ctx: AppContext = {
    isDev,
    userSession: createUserSession(),
    mainWin: null,
    inspectorWin: null,
    wvPreloadUrl: null,
    setMainWin: (w) => (ctx.mainWin = w),
    setInspectorWin: (w) => (ctx.inspectorWin = w),
};

app.whenReady().then(() => {
    createMainWindow(ctx);
    registerAllIpc(ctx);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow(ctx);
    });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
