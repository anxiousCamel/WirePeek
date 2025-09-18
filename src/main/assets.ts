/**
 * @file src/main/assets.ts
 * @brief Resolve caminhos (FS absolutos) para HTML e preloads (main, inspector, webview).
 *        Funciona em dev e em build (asar/unpacked).
 *
 * Importante:
 *  - BrowserWindow.loadFile() espera caminho de arquivo (ex.: "C:\\...\\index.html").
 *  - webPreferences.preload também é um caminho absoluto de arquivo.
 *  - O atributo preload do <webview> aceita caminho absoluto.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

type AssetPair = { html: string; preload: string };

/** Retorna o primeiro caminho existente; sempre em caminho absoluto (FS). */
function pickPath(candidates: string[], label: string): string {
  for (const p of candidates) {
    const abs = path.isAbsolute(p) ? p : path.resolve(p);
    if (fs.existsSync(abs)) return abs;
  }
  // eslint-disable-next-line no-console
  console.warn(`[assets] ${label} não encontrado nas opções:`, candidates);
  return "";
}

/** Diretórios base típicos para dev e prod. */
function roots() {
  const projectRoot = process.cwd();                 // raiz do projeto
  const srcRoot = path.join(projectRoot, "src");
  const distRoot = path.join(projectRoot, "dist");

  // Em produção, os arquivos podem estar extraídos ao lado do app.asar
  // (Electron resolve app.getAppPath() para .../resources/app.asar)
  const prodUnpacked = path.join(app.getAppPath(), "..");

  const distRenderer = path.join(distRoot, "renderer");
  const distPreload  = path.join(distRoot, "preload");

  return { projectRoot, srcRoot, distRoot, distRenderer, distPreload, prodUnpacked };
}

/**
 * Página e preload da JANELA PRINCIPAL.
 * @param _isDev  sinalização (não usamos aqui; deixamos com _ para agradar o ESLint)
 */
export function mainAssets(_isDev: boolean): AssetPair {
  const { srcRoot, distRenderer, distPreload, prodUnpacked, distRoot } = roots();

  // HTML principal — tenta dist primeiro, depois src (seu caso)
  const htmlPath = pickPath(
    [
      path.join(distRenderer, "index.html"),
      path.join(distRoot, "renderer", "index.html"),
      path.join(srcRoot, "renderer", "index.html"),
    ],
    "main html"
  );

  // Preload principal — tenta dist (.js/.cjs); em prod tenta unpacked
  const preloadPath = pickPath(
    [
      path.join(distPreload, "preload.js"),
      path.join(distPreload, "preload.cjs"),
      path.join(prodUnpacked, "dist", "preload", "preload.js"),
      path.join(prodUnpacked, "dist", "preload", "preload.cjs"),
    ],
    "main preload"
  );

  if (!htmlPath || !preloadPath) {
    // eslint-disable-next-line no-console
    console.warn("[assets] mainAssets incompleto; verifique build de renderer/preload.");
  }

  return { html: htmlPath, preload: preloadPath };
}

/** Página e preload do INSPECTOR (seu HTML está em src/Inspector/index.html). */
export function inspectorAssets(): AssetPair {
  const { srcRoot, distRoot, distRenderer, distPreload, prodUnpacked } = roots();

  const htmlPath = pickPath(
    [
      // dist – casos comuns
      path.join(distRenderer, "inspector.html"),
      path.join(distRoot, "renderer", "inspector.html"),
      path.join(distRenderer, "inspector", "index.html"),
      path.join(distRoot, "renderer", "inspector", "index.html"),

      // src – SEU CASO: pasta "Inspector" (maiúsculo)
      path.join(srcRoot, "Inspector", "index.html"),
      // variações (caso sensibilidade diferente)
      path.join(srcRoot, "inspector", "index.html"),
      path.join(srcRoot, "renderer", "inspector.html"),
      path.join(srcRoot, "renderer", "inspector", "index.html"),
    ],
    "inspector html"
  );

  const preloadPath = pickPath(
    [
      path.join(distPreload, "preload.inspector.js"),
      path.join(distPreload, "preload.inspector.cjs"),
      path.join(prodUnpacked, "dist", "preload", "preload.inspector.js"),
      path.join(prodUnpacked, "dist", "preload", "preload.inspector.cjs"),
    ],
    "inspector preload"
  );

  if (!htmlPath || !preloadPath) {
    // eslint-disable-next-line no-console
    console.warn("[assets] inspectorAssets incompleto; verifique build do inspector/preload.");
  }

  return { html: htmlPath, preload: preloadPath };
}

/**
 * Preload do WEBVIEW (guest) — retorna CAMINHO ABSOLUTO (FS).
 * Primeiro tentamos o novo (dist/preload/webview.preload.js).
 * Como fallback, tentamos o legado (dist/webview/preload.capture.js).
 */
export function webviewPreloadUrl(): string {
  const { distPreload, prodUnpacked, distRoot } = roots();

  return pickPath(
    [
      // Novo caminho (o que te sugeri)
      path.join(distPreload, "webview.preload.js"),
      path.join(distPreload, "webview.preload.cjs"),
      path.join(prodUnpacked, "dist", "preload", "webview.preload.js"),
      path.join(prodUnpacked, "dist", "preload", "webview.preload.cjs"),

      // Legado da sua árvore (compilado de src/webview/preload.capture.ts)
      path.join(distRoot, "webview", "preload.capture.js"),
      path.join(prodUnpacked, "dist", "webview", "preload.capture.js"),
    ],
    "webview preload"
  );
}
