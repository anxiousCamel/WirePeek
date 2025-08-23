// WirePeekBrowser/src/main//main.ts
import { app, BrowserWindow, ipcMain, session } from "electron";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  BrowserWindowConstructorOptions
} from "electron";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { attachNetworkCapture, type RestRequestPayload, type RestResponsePayload } from "./capture";
import { CaptureSession } from "./capture.session";
import { pathToFileURL } from "url";

/** Ambiente atual */
const isDev =
  process.env.NODE_ENV === "development" ||
  process.env.ELECTRON_ENV === "development" ||
  !app.isPackaged;

function resolveExisting(devPath: string, prodPath: string): string {
  return fs.existsSync(devPath) ? devPath : prodPath;
}

/** Caminhos de assets (HTML e preload) mantendo DEV/PROD limpo */
function getAssetPaths() {
  const devHtml = path.resolve(__dirname, "../../src/renderer/index.html");
  const devPreload = path.resolve(__dirname, "../../dist/preload/preload.js");

  const prodHtml = path.join(__dirname, "../renderer/index.html");
  const prodPreload = path.join(__dirname, "../preload/preload.js");

  return {
    html: isDev ? resolveExisting(devHtml, prodHtml) : prodHtml,
    preload: isDev ? resolveExisting(devPreload, prodPreload) : prodPreload,
  };
}

/** ---------------- Tipos dos envelopes (iguais aos do webview) ---------------- */
type RestRequestEnv = { channel: "cap:rest:request";  payload: RestRequestPayload };
type RestResponseEnv = { channel: "cap:rest:response"; payload: RestResponsePayload };
type WsOpenEnv   = { channel: "cap:ws:open";   payload: { ts: number; id: string; url: string; protocols?: string | string[] } };
type WsMsgEnv    = { channel: "cap:ws:msg";    payload: { ts: number; id: string; dir: "in" | "out"; data: string } };
type WsCloseEnv  = { channel: "cap:ws:close";  payload: { ts: number; id: string; code: number; reason: string } };
type WsErrorEnv  = { channel: "cap:ws:error";  payload: { ts: number; id: string } };

type CapEnvelope =
  | RestRequestEnv
  | RestResponseEnv
  | WsOpenEnv
  | WsMsgEnv
  | WsCloseEnv
  | WsErrorEnv;

/** --- Estado no processo principal --- */
let detachCapture: (() => void) | null = null;
let capSession: CaptureSession | null = null;
let inspector: BrowserWindow | null = null;

function openInspectorWindow(parent: BrowserWindow): void {
  if (inspector && !inspector.isDestroyed()) return;

  const devHtml = path.resolve(__dirname, "../../src/inspector/index.html");
  const prodHtml = path.join(__dirname, "../inspector/index.html");
  const html = fs.existsSync(devHtml) ? devHtml : prodHtml;

  // NEW: preload do Inspector
  const devPreload = path.resolve(__dirname, "../../dist/preload/preload.inspector.js");
  const prodPreload = path.join(__dirname, "../preload/preload.inspector.js");
  const preload = fs.existsSync(devPreload) ? devPreload : prodPreload;

  inspector = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: "#0f0f10",
    title: "WirePeek Inspector",
    parent,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload, // ESSENCIAL
    },
  });
  inspector.loadFile(html);
}

function inspectorBroadcast(channel: CapEnvelope["channel"], payload: CapEnvelope["payload"]): void {
  if (!inspector || inspector.isDestroyed()) return;
  // usar IPC padrão do Electron
  inspector.webContents.send("cap-event", { channel, payload });
}

function isCapturing(_win: BrowserWindow): boolean {
  return !!detachCapture;
}

function startCapture(win: BrowserWindow): void {
  if (detachCapture) return; // já capturando
  // passa callback para espelhar eventos do webRequest também
  detachCapture = attachNetworkCapture(win, (channel, payload) => {
    // (1) espelha no Inspector
    inspectorBroadcast(channel as CapEnvelope["channel"], payload as CapEnvelope["payload"]);
    // (2) opcional: alimentar HAR quando compatível
    if (capSession) {
      if (channel === "cap:rest:request") capSession.onRestRequest(payload as RestRequestPayload);
      if (channel === "cap:rest:response") capSession.onRestResponse(payload as RestResponsePayload);
    }
  });
}

function stopCapture(_win: BrowserWindow): { ok: true } | { ok: false; reason: "not-running" } {
  if (!detachCapture) return { ok: false, reason: "not-running" };
  detachCapture();
  detachCapture = null;
  return { ok: true };
}

/** ------------------------------------------------------- */

function createWindow(): BrowserWindow {
  const { html, preload } = getAssetPaths();

  const opts: BrowserWindowConstructorOptions = {
    width: config.winWidth,
    height: config.winHeight,
    backgroundColor: "#111111",
    frame: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  };

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

  // Carrega a UI
  win.loadFile(html);

  // Preload do webview (file://)
  const wvPreloadDev = path.resolve(__dirname, "../../dist/webview/preload.capture.js");
  const wvPreloadProd = path.join(__dirname, "../webview/preload.capture.js");
  const wvPreloadPath = fs.existsSync(wvPreloadDev) ? wvPreloadDev : wvPreloadProd;
  const wvPreloadUrl  = pathToFileURL(wvPreloadPath).href;

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("ui:config", { targetUrl: config.targetUrl, isDev, wvPreload: wvPreloadUrl });
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

  // ---- Controle de captura
  ipcMain.handle("wirepeek:start", () => {
    if (!isCapturing(win)) {
      startCapture(win);
      capSession = new CaptureSession();
      openInspectorWindow(win);
    }
    return { capturing: isCapturing(win) };
  });

  ipcMain.handle("wirepeek:stop", () => {
    const out = stopCapture(win);
    if (capSession) {
      capSession.stop();
      capSession = null;
    }
    return { capturing: isCapturing(win), out };
  });

  // ---- Recebe eventos do webview e grava (tipado) + espelha Inspector
  ipcMain.on("cap:from-webview", (_ev: IpcMainEvent, env: CapEnvelope) => {
    if (capSession) {
      switch (env.channel) {
        case "cap:rest:request":  capSession.onRestRequest(env.payload);  break;
        case "cap:rest:response": capSession.onRestResponse(env.payload); break;
        case "cap:ws:open":       capSession.onWsOpen(env.payload);       break;
        case "cap:ws:msg":        capSession.onWsMsg(env.payload);        break;
        case "cap:ws:close":      capSession.onWsClose(env.payload);      break;
        case "cap:ws:error":      capSession.onWsError(env.payload);      break;
      }
    }
    inspectorBroadcast(env.channel, env.payload);
  });

  // ---- Navegação direta
  ipcMain.handle("wirepeek:navigate", (_evt: IpcMainInvokeEvent, url: string) => {
    if (typeof url === "string" && url.length > 0) {
      try { new URL(url); } catch { return { ok: false as const, error: "URL inválida" as const }; }
      win.loadURL(url);
      return { ok: true as const };
    }
    return { ok: false as const, error: "URL vazia" as const };
  });

  // ---- IPCs de controle da janela
  ipcMain.handle("win:minimize", () => { BrowserWindow.getFocusedWindow()?.minimize(); });
  ipcMain.handle("win:toggleMaximize", () => {
    const w = BrowserWindow.getFocusedWindow(); if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return { maximized: w.isMaximized() };
  });
  ipcMain.handle("win:close", () => { BrowserWindow.getFocusedWindow()?.close(); });

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
