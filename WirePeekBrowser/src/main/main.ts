// src/main/main.ts
import { app, BrowserWindow, ipcMain, session } from "electron";
import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  BrowserWindowConstructorOptions
} from "electron";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { attachNetworkCapture } from "./capture";
import { CaptureSession } from "./capture.session";
import { pathToFileURL } from "url";

/** Ambiente atual */
const isDev =
  process.env.NODE_ENV === "development" ||
  process.env.ELECTRON_ENV === "development" ||
  !app.isPackaged;

/** Resolve um caminho preferindo DEV e caindo para PROD se não existir. */
function resolveExisting(devPath: string, prodPath: string) {
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

/** ---------------- Tipos dos eventos do WebView ---------------- */
type RestRequestPayload = {
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
};

type RestResponsePayload = {
  ts: number;
  url: string;
  method: string;
  status: number;
  statusText: string;
  resHeaders: Record<string, string>;
  bodySize: number;
  timingMs: number;
};

type WsOpenPayload = {
  ts: number;
  id: string;
  url: string;
  protocols?: string | string[];
};

type WsMsgPayload = {
  ts: number;
  id: string;
  dir: "in" | "out";
  data: string;
};

type WsClosePayload = {
  ts: number;
  id: string;
  code: number;
  reason: string;
};

type WsErrorPayload = {
  ts: number;
  id: string;
};

type CapEnvelope =
  | { channel: "cap:rest:request";  payload: RestRequestPayload }
  | { channel: "cap:rest:response"; payload: RestResponsePayload }
  | { channel: "cap:ws:open";       payload: WsOpenPayload }
  | { channel: "cap:ws:msg";        payload: WsMsgPayload }
  | { channel: "cap:ws:close";      payload: WsClosePayload }
  | { channel: "cap:ws:error";      payload: WsErrorPayload };

/** --- Estado simples de captura no processo principal --- */
let detachCapture: (() => void) | null = null;
let capSession: CaptureSession | null = null;
let inspector: BrowserWindow | null = null;

function openInspectorWindow(parent: BrowserWindow) {
  if (inspector && !inspector.isDestroyed()) return;

  const devHtml = path.resolve(__dirname, "../../src/inspector/index.html");
  const prodHtml = path.join(__dirname, "../inspector/index.html");
  const html = fs.existsSync(devHtml) ? devHtml : prodHtml;

  inspector = new BrowserWindow({
    width: 900,
    height: 600,
    backgroundColor: "#0f0f10",
    title: "WirePeek Inspector",
    parent,
    webPreferences: { contextIsolation: true },
  });
  inspector.loadFile(html);
}

function inspectorBroadcast(channel: CapEnvelope["channel"], payload: CapEnvelope["payload"]) {
  if (!inspector || inspector.isDestroyed()) return;
  inspector.webContents.postMessage("cap-event", { channel, payload });
}

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

  // Envia config inicial para a UI
  const wvPreloadDev = path.resolve(__dirname, "../../dist/webview/preload.capture.js");
  const wvPreloadProd = path.join(__dirname, "../webview/preload.capture.js");
  const wvPreloadPath = fs.existsSync(wvPreloadDev) ? wvPreloadDev : wvPreloadProd;
  const wvPreloadUrl  = pathToFileURL(wvPreloadPath).href;

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("ui:config", { targetUrl: config.targetUrl, isDev,  wvPreload: wvPreloadUrl, });
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

  // ---- Recebe eventos do webview e grava (tipado)
  ipcMain.on(
    "cap:from-webview",
    (_ev: IpcMainEvent, env: CapEnvelope) => {
      if (!capSession) return;

      switch (env.channel) {
        case "cap:rest:request":
          capSession.onRestRequest(env.payload);
          break;
        case "cap:rest:response":
          capSession.onRestResponse(env.payload);
          break;
        case "cap:ws:open":
          capSession.onWsOpen(env.payload);
          break;
        case "cap:ws:msg":
          capSession.onWsMsg(env.payload);
          break;
        case "cap:ws:close":
          capSession.onWsClose(env.payload);
          break;
        case "cap:ws:error":
          capSession.onWsError(env.payload);
          break;
      }

      // espelha para o Inspector, se aberto
      inspectorBroadcast(env.channel, env.payload);
    }
  );

  // ---- Navegação direta
  ipcMain.handle("wirepeek:navigate", (_evt: IpcMainInvokeEvent, url: string) => {
    if (typeof url === "string" && url.length > 0) {
      try {
        new URL(url);
      } catch {
        return { ok: false, error: "URL inválida" as const };
      }
      win.loadURL(url);
      return { ok: true as const };
    }
    return { ok: false as const, error: "URL vazia" as const };
  });

  // ---- IPCs de controle da janela
  ipcMain.handle("win:minimize", () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.minimize();
  });

  ipcMain.handle("win:toggleMaximize", () => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return { maximized: w.isMaximized() };
  });

  ipcMain.handle("win:close", () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.close();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
