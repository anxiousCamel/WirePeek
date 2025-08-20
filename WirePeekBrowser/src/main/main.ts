// src/main/main.ts
import { app, BrowserWindow, ipcMain, session } from "electron";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { attachNetworkCapture } from "./capture";
import type { BrowserWindowConstructorOptions } from "electron";

/** Ambiente atual */
const isDev =
  process.env.NODE_ENV === "development" ||
  process.env.ELECTRON_ENV === "development" ||
  !app.isPackaged;

/**
 * Resolve um caminho preferindo DEV e caindo para PROD se não existir.
 * Útil porque em dev o __dirname costuma ser “…/src/main”,
 * mas o preload transpilado fica em “dist/preload”.
 */
function resolveExisting(devPath: string, prodPath: string) {
  return fs.existsSync(devPath) ? devPath : prodPath;
}

/** Caminhos de assets (HTML e preload) mantendo DEV/PROD limpo */
function getAssetPaths() {
  // Em dev (rodando a partir do source):
  //  • HTML vive em src/renderer
  //  • preload transpilado vive em dist/preload/preload.js (tsc -w)
  const devHtml = path.resolve(__dirname, "../../src/renderer/index.html");
  const devPreload = path.resolve(__dirname, "../../dist/preload/preload.js");

  // Em prod (app empacotado): __dirname === "<app>/dist/main"
  const prodHtml = path.join(__dirname, "../renderer/index.html");
  const prodPreload = path.join(__dirname, "../preload/preload.js");

  return {
    html: isDev ? resolveExisting(devHtml, prodHtml) : prodHtml,
    preload: isDev ? resolveExisting(devPreload, prodPreload) : prodPreload,
  };
}

/** --- Estado simples de captura no processo principal --- */
let detachCapture: (() => void) | null = null;

function isCapturing(_win: BrowserWindow): boolean {
  return !!detachCapture;
}
function startCapture(win: BrowserWindow) {
  if (detachCapture) return; // já capturando
  detachCapture = attachNetworkCapture(win);
}
function stopCapture(_win: BrowserWindow) {
  if (!detachCapture) return { ok: false as const, reason: "not-running" as const };
  detachCapture();
  detachCapture = null;
  return { ok: true as const };
}
/** ------------------------------------------------------- */

function createWindow(): BrowserWindow {
  const { html, preload } = getAssetPaths();

  // Monte as opções básicas
  const opts: BrowserWindowConstructorOptions = {
    width: config.winWidth,
    height: config.winHeight,
    backgroundColor: "#111111",
    frame: false, // sem barra nativa
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  };

  // Só defina titleBarStyle no macOS
  if (process.platform === "darwin") {
    opts.titleBarStyle = "hiddenInset";
  }

  const win = new BrowserWindow(opts);

  // User-Agent opcional
  if (config.userAgent) {
    session.defaultSession.setUserAgent(config.userAgent);
    app.userAgentFallback = config.userAgent;
  }
  win.webContents.session.setUserAgent(config.userAgent || app.userAgentFallback);

  // Carrega a UI (src em dev, dist em prod)
  win.loadFile(html);

  // Envia config inicial para a UI
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("ui:config", { targetUrl: config.targetUrl, isDev });
  });

  if (isDev) {
    // win.webContents.openDevTools({ mode: "detach" });
  }

  win.on("maximize", () => win.webContents.send("win:maximized-change", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized-change", false));

  return win;
}

app.whenReady().then(() => {
  const win = createWindow();

  // IPC: controle de captura
  ipcMain.handle("wirepeek:start", () => {
    if (!isCapturing(win)) startCapture(win);
    return { capturing: isCapturing(win) };
  });

  ipcMain.handle("wirepeek:stop", () => {
    const out = stopCapture(win);
    return { capturing: isCapturing(win), out };
  });

  ipcMain.handle("wirepeek:navigate", (_evt, url: string) => {
    if (typeof url === "string" && url.length > 0) {
      try {
        new URL(url);
      } catch {
        return { ok: false, error: "URL inválida" };
      }
      win.loadURL(url);
      return { ok: true };
    }
    return { ok: false, error: "URL vazia" };
  });

  // IPCs de controle da janela
  ipcMain.handle("win:minimize", () => {
    const w = BrowserWindow.getFocusedWindow(); w?.minimize();
  });
  ipcMain.handle("win:toggleMaximize", () => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return { maximized: w.isMaximized() };
  });
  ipcMain.handle("win:close", () => {
    const w = BrowserWindow.getFocusedWindow(); w?.close();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
