// WirePeekBrowser/src/main/main.ts
import { app, BrowserWindow, ipcMain, session, webContents } from "electron";
import type { WebContents } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, BrowserWindowConstructorOptions } from "electron";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { config } from "./config";
import { attachNetworkCapture, type RestRequestPayload, type RestResponsePayload } from "./capture";
import { CaptureSession } from "./capture.session";
import type { CapTxn } from "../common/capture.types";


/** ---------------------------------------------------------------------------
 * Ambiente
 * ---------------------------------------------------------------------------*/
const isDev =
  process.env.NODE_ENV === "development" ||
  process.env.ELECTRON_ENV === "development" ||
  !app.isPackaged;

function resolveExisting(devPath: string, prodPath: string): string {
  return fs.existsSync(devPath) ? devPath : prodPath;
}

/** Retorna caminhos de HTML e preload da janela principal (DEV/PROD). */
function getMainAssetPaths() {
  const devHtml = path.resolve(__dirname, "../../src/renderer/index.html");
  const prodHtml = path.join(__dirname, "../renderer/index.html");

  const devPreload = path.resolve(__dirname, "../../dist/preload/preload.js");
  const prodPreload = path.join(__dirname, "../preload/preload.js");

  return {
    html: isDev ? resolveExisting(devHtml, prodHtml) : prodHtml,
    preload: isDev ? resolveExisting(devPreload, prodPreload) : prodPreload,
  };
}

/** Retorna caminhos de HTML e preload do Inspetor (DEV/PROD). */
function getInspectorAssetPaths() {
  const devHtml = path.resolve(__dirname, "../../src/inspector/index.html");
  const prodHtml = path.join(__dirname, "../inspector/index.html");

  const devPreload = path.resolve(__dirname, "../../dist/preload/preload.inspector.js");
  const prodPreload = path.join(__dirname, "../preload/preload.inspector.js");

  return {
    html: fs.existsSync(devHtml) ? devHtml : prodHtml,
    preload: fs.existsSync(devPreload) ? devPreload : prodPreload,
  };
}

/** ---------------- Tipos dos envelopes (iguais aos do webview/capture) ---------------- */
type RestRequestEnv = {
  channel: "cap:rest:request";
  payload: RestRequestPayload;
};

type RestBeforeSendHeadersEnv = {
  channel: "cap:rest:before-send-headers";
  payload: RestRequestPayload;
};

type RestResponseEnv = {
  channel: "cap:rest:response";
  payload: RestResponsePayload;
};

type RestErrorEnv = {
  channel: "cap:rest:error";
  payload: RestRequestPayload;
};

type TxnEnv = {
  channel: "cap:txn";
  payload: CapTxn;
};

// WebSocket (se você já tinha no projeto)
type WsOpenEnv  = { channel: "cap:ws:open";  payload: { ts: number; id: string; url: string; protocols?: string | string[] } };
type WsMsgEnv   = { channel: "cap:ws:msg";   payload: { ts: number; id: string; dir: "in" | "out"; data: string } };
type WsCloseEnv = { channel: "cap:ws:close"; payload: { ts: number; id: string; code: number; reason: string } };
type WsErrorEnv = { channel: "cap:ws:error"; payload: { ts: number; id: string } };

type CapEnvelope =
  | RestRequestEnv
  | RestBeforeSendHeadersEnv
  | RestResponseEnv
  | RestErrorEnv
  | TxnEnv
  | WsOpenEnv
  | WsMsgEnv
  | WsCloseEnv
  | WsErrorEnv;


/** ---------------------------------------------------------------------------
 * Estado no processo principal
 * ---------------------------------------------------------------------------*/
let detachCapture: (() => void) | null = null;
let capSession: CaptureSession | null = null;
let inspectorWin: BrowserWindow | null = null;
let mainWin: BrowserWindow | null = null;

// pequeno cache para o caminho do preload do webview (evita recomputar)
let cachedWvPreloadUrl: string | null = null;

/** Retorna se há captura ativa. */
function getCaptureFlag(): boolean {
  return !!detachCapture;
}

/** Envia estado de captura para todas as WebContents (exceto DevTools). */
function broadcastCaptureState(): void {
  const payload = { capturing: getCaptureFlag() };

  webContents
    .getAllWebContents()
    .filter((wc: WebContents) => !wc.getURL().startsWith("devtools://"))
    .forEach((wc: WebContents) => wc.send("cap:state", payload));
}

/** Espelha um evento de captura (REST/WS) no Inspetor. */
function inspectorBroadcast(channel: CapEnvelope["channel"], payload: CapEnvelope["payload"]): void {
  if (!inspectorWin || inspectorWin.isDestroyed()) return;
  inspectorWin.webContents.send("cap-event", { channel, payload });
}

/** ----------------------------------------------------------------------------
 * Captura de rede
 * ----------------------------------------------------------------------------*/
/** Inicia a captura de rede na janela alvo. */
function startCapture(targetWin: BrowserWindow): void {
  if (detachCapture) return; // já capturando

  detachCapture = attachNetworkCapture(targetWin, (channel, payload) => {
  // (1) espelha no Inspetor
  inspectorBroadcast(channel as CapEnvelope["channel"], payload as CapEnvelope["payload"]);

  // (2) grava HAR (quando aplicável)
  if (capSession) {
    if (channel === "cap:rest:request")  capSession.onRestRequest(payload as RestRequestPayload);
    if (channel === "cap:rest:response") capSession.onRestResponse(payload as RestResponsePayload);
  }
});
  broadcastCaptureState();
}

/** Para a captura de rede (idempotente). */
function stopCapture(): { ok: true } | { ok: false; reason: "not-running" } {
  if (!detachCapture) return { ok: false, reason: "not-running" };
  detachCapture();
  detachCapture = null;
  broadcastCaptureState();
  return { ok: true };
}

/** ----------------------------------------------------------------------------
 * Janela do Inspetor
 * ----------------------------------------------------------------------------*/
/** Fecha a janela do Inspetor se estiver aberta. */
function closeInspectorWindow(): void {
  if (inspectorWin && !inspectorWin.isDestroyed()) {
    inspectorWin.hide();  // não dispara 'closed'
  }
}

/**
 * Abre a janela do Inspetor com barra personalizada.
 * Remove menu, usa frame=false e titleBarStyle hidden, e carrega via file://
 * para evitar o erro de "only 'file:' protocol is supported in 'preload' attribute".
 */
function openInspectorWindow(parent: BrowserWindow): void {
  if (inspectorWin && !inspectorWin.isDestroyed()) {
    inspectorWin.show(); inspectorWin.focus(); return;
  }

  const { html, preload } = getInspectorAssetPaths();

  inspectorWin = new BrowserWindow({
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
      contextIsolation: true,
      nodeIntegration: false,
      preload, // file:// garantido
    },
  });

  inspectorWin.removeMenu();             // elimina "File/Edit/View/Window/Help"
  inspectorWin.loadFile(html);           // carrega via file://

  // Fechar o Inspetor => parar captura e refletir estado
  inspectorWin.on("closed", () => {
    inspectorWin = null;
    if (getCaptureFlag()) stopCapture();
    if (capSession) { capSession.stop(); capSession = null; }
    broadcastCaptureState();
  });
}

/** ----------------------------------------------------------------------------
 * Janela principal
 * ----------------------------------------------------------------------------*/
/** Cria a janela principal do navegador custom. */
function createMainWindow(): BrowserWindow {
  const { html, preload } = getMainAssetPaths();

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

  // User-Agent (se definido em config)
  if (config.userAgent) {
    session.defaultSession.setUserAgent(config.userAgent);
    app.userAgentFallback = config.userAgent;
  }
  win.webContents.session.setUserAgent(config.userAgent || app.userAgentFallback);

  win.loadFile(html);

  // Preload do <webview> sempre por file:// (evita erro de protocolo)
  if (!cachedWvPreloadUrl) {
    const wvPreloadDev = path.resolve(__dirname, "../../dist/webview/preload.capture.js");
    const wvPreloadProd = path.join(__dirname, "../webview/preload.capture.js");
    const wvPreloadPath = fs.existsSync(wvPreloadDev) ? wvPreloadDev : wvPreloadProd;
    cachedWvPreloadUrl = pathToFileURL(wvPreloadPath).href;
  }

  win.webContents.once("did-finish-load", () => {
    win.webContents.send("ui:config", { targetUrl: config.targetUrl, isDev, wvPreload: cachedWvPreloadUrl });
  });

  // refletir maximize no renderer (para trocar ícone)
  win.on("maximize", () => win.webContents.send("win:maximized-change", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized-change", false));

  return win;
}

/** ----------------------------------------------------------------------------
 * App lifecycle + IPC
 * ----------------------------------------------------------------------------*/
app.whenReady().then(() => {
  mainWin = createMainWindow();

  // ---- Controle de captura (start/stop) ----
  ipcMain.handle("wirepeek:start", () => {
    if (!mainWin) return { capturing: false };
    if (!getCaptureFlag()) {
      startCapture(mainWin);
      capSession = new CaptureSession();
      openInspectorWindow(mainWin);
    }
    return { capturing: getCaptureFlag() };
  });

  ipcMain.handle("wirepeek:stop", () => {
    const out = stopCapture();
    if (capSession) { capSession.stop(); capSession = null; }
    closeInspectorWindow();
    return { capturing: getCaptureFlag(), out };
  });

  // Estado atual (para sincronizar botão ao abrir a UI)
  ipcMain.handle("wirepeek:getState", () => ({ capturing: getCaptureFlag() }));

  // ---- Recebe eventos do webview e grava + espelha no Inspetor ----
  ipcMain.on("cap:from-webview", (_ev: IpcMainEvent, env: CapEnvelope) => {
    if (capSession) {
      switch (env.channel) {
        case "cap:rest:request": capSession.onRestRequest(env.payload); break;
        case "cap:rest:response": capSession.onRestResponse(env.payload); break;
        case "cap:ws:open": capSession.onWsOpen(env.payload); break;
        case "cap:ws:msg": capSession.onWsMsg(env.payload); break;
        case "cap:ws:close": capSession.onWsClose(env.payload); break;
        case "cap:ws:error": capSession.onWsError(env.payload); break;
      }
    }
    inspectorBroadcast(env.channel, env.payload);
  });

  // ---- Navegação direta ----
  ipcMain.handle("wirepeek:navigate", (_evt: IpcMainInvokeEvent, url: string) => {
    if (!mainWin) return { ok: false as const, error: "Sem janela principal" as const };
    if (typeof url === "string" && url.length > 0) {
      try { new URL(url); } catch { return { ok: false as const, error: "URL inválida" as const }; }
      mainWin.loadURL(url);
      return { ok: true as const };
    }
    return { ok: false as const, error: "URL vazia" as const };
  });

  // ---- IPCs de controle de janela (funcionam para principal e inspetor) ----
  ipcMain.handle("win:minimize", () => { BrowserWindow.getFocusedWindow()?.minimize(); });
  ipcMain.handle("win:toggleMaximize", () => {
    const w = BrowserWindow.getFocusedWindow(); if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return { maximized: w.isMaximized() };
  });
  ipcMain.handle("win:close", () => { BrowserWindow.getFocusedWindow()?.close(); });

  // Recria janela no macOS ao clicar no dock
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWin = createMainWindow(); });
});

app.on("before-quit", () => {
  // Limpeza defensiva
  if (getCaptureFlag()) stopCapture();
  if (capSession) { capSession.stop(); capSession = null; }
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
