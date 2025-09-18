// src/main/win.main.ts
/**
 * Cria e gerencia a janela principal (sem registrar IPCs de janela aqui).
 *
 * Importante:
 *  - Os canais "win:minimize", "win:close", "win:toggleMaximize" e "ui:set-bg"
 *    são registrados EXCLUSIVAMENTE em src/main/ipc/ipc.window.ts.
 *  - Aqui apenas emitimos "win:maximized-change" e mandamos "ui:config".
 *  - Convertemos file:// → caminho absoluto quando necessário (preloads).
 */

import { app, BrowserWindow } from "electron";
import type { BrowserWindowConstructorOptions } from "electron";
import { mainAssets, webviewPreloadUrl } from "./assets.js";
import { config } from "./config.js";
import type { AppContext } from "./context.js";
import { WIREPEEK_PARTITION } from "./session.profile.js";
import { fileURLToPath } from "node:url";

/** Cor neutra igual ao renderer para evitar “flash” entre processos. */
const NEUTRAL_FALLBACK = "#24272b";

/** Converte string file://foo/bar.js → caminho absoluto "foo/bar.js" (senão retorna original). */
function toFsPathIfFileUrl(maybeFileUrl: string | undefined | null): string | "" {
  if (!maybeFileUrl) return "";
  try {
    // eslint-disable-next-line no-new
    const u = new URL(maybeFileUrl);
    if (u.protocol === "file:") return fileURLToPath(u);
    return maybeFileUrl;
  } catch {
    // não era uma URL válida; provavelmente já é caminho;
    return maybeFileUrl;
  }
}

export function createMainWindow(ctx: AppContext): BrowserWindow {
  // `mainAssets` (seu assets.ts) retorna file:// para html e preload
  const { html, preload } = mainAssets(ctx.isDev);

  // BrowserWindow: use SEMPRE a mesma partition do app/webview
  const opts: BrowserWindowConstructorOptions = {
    width: config.winWidth,
    height: config.winHeight,
    backgroundColor: NEUTRAL_FALLBACK,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      // ❗ Importante: mesma partition do <webview>
      partition: WIREPEEK_PARTITION,

      // ❗ Preload da janela PRECISA ser caminho absoluto (não file://)
      preload: toFsPathIfFileUrl(preload),

      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false, // bom explicitar quando se usa <webview>
      devTools: ctx.isDev !== false,
    },
  };

  // macOS: barra “compacta” escondida
  if (process.platform === "darwin") {
    opts.titleBarStyle = "hiddenInset";
  }

  const win = new BrowserWindow(opts);

  // Se quiser reter a referência no contexto
  ctx.setMainWin?.(win);

  // User-Agent estável (em sites chatos ajuda)
  try {
    win.webContents.session.setUserAgent(app.userAgentFallback);
  } catch {
    /* noop */
  }

  // Carrega a UI — `html` é file://... então use loadURL (não loadFile)
  win.loadURL(html);

  // Descobre/prepara o preload do <webview>
  // Seu assets.webviewPreloadUrl() retorna file://; converta para caminho absoluto
  if (!ctx.wvPreloadUrl) {
    ctx.wvPreloadUrl = webviewPreloadUrl();
  }
  const wvPreloadPath = toFsPathIfFileUrl(ctx.wvPreloadUrl);

  // Envia config inicial para o renderer assim que a UI terminar o 1º load
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("ui:config", {
      targetUrl: config.targetUrl,
      isDev: ctx.isDev,

      // 🔹 tabs.js/preload principal esperam isto:
      wvPreloadPath,               // ← caminho ABSOLUTO p/ atributo <webview preload="...">
      wvPartition: WIREPEEK_PARTITION,
    });
  });

  // Emite mudanças de maximização (preload/renderer atualiza ícone da UI)
  win.on("maximize", () => win.webContents.send("win:maximized-change", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized-change", false));

  return win;
}
