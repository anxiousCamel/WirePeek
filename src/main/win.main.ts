// src/main/win.main.ts
import { app, BrowserWindow } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { mainAssets, webviewPreloadUrl } from "./assets.js";
import { config } from "./config.js";
import type { AppContext } from "./context.js";
import { WIREPEEK_PARTITION } from "./session.profile.js";

export function createMainWindow(ctx: AppContext): BrowserWindow {
    const { html, preload } = mainAssets(ctx.isDev);

    const opts: BrowserWindowConstructorOptions = {
        width: config.winWidth,
        height: config.winHeight,
        backgroundColor: "#111111",
        frame: false,
        webPreferences: {
            session: ctx.userSession,
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true,
        },
    };
    if (process.platform === "darwin") opts.titleBarStyle = "hiddenInset";

    const win = new BrowserWindow(opts);

    win.webContents.session.setUserAgent(app.userAgentFallback);
    win.loadFile(html);

    if (!ctx.wvPreloadUrl) ctx.wvPreloadUrl = webviewPreloadUrl();

    win.webContents.once("did-finish-load", () => {
        win.webContents.send("ui:config", {
            targetUrl: config.targetUrl,
            isDev: ctx.isDev,
            wvPreload: ctx.wvPreloadUrl,
            wvPartition: WIREPEEK_PARTITION, // manda a partition para o renderer
        });
    });

    win.on("maximize", () => win.webContents.send("win:maximized-change", true));
    win.on("unmaximize", () => win.webContents.send("win:maximized-change", false));

    ctx.setMainWin(win);
    return win;
}
