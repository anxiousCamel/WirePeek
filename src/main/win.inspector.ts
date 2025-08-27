/**
 * @file src/main/win.inspector.ts
 * @brief Cria/gerencia a janela do Inspector (filha da janela principal).
 *        - Aceita callback onClosed para o chamador decidir o que fazer
 *          quando o usuário fecha a janela manualmente (ex.: parar captura).
 */

import { BrowserWindow } from "electron";
import { inspectorAssets } from "./assets";
import type { AppContext } from "./context";

export type OpenInspectorOptions = {
    /** Chamado quando a janela é fechada (X). Útil para parar captura e sync de estado. */
    onClosed?: () => void;
};

/**
 * Abre (ou foca) a janela do Inspector.
 *
 * @param ctx     AppContext com sessão, refs de janela etc.
 * @param parent  Janela principal (BrowserWindow) como parent do Inspector
 * @param opts    Opções (ex.: callback onClosed)
 */
export function openInspector(
    ctx: AppContext,
    parent: BrowserWindow,
    opts?: OpenInspectorOptions
): void {
    // Se já existe, apenas mostra e foca.
    if (ctx.inspectorWin && !ctx.inspectorWin.isDestroyed()) {
        ctx.inspectorWin.show();
        ctx.inspectorWin.focus();
        return;
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

    // Quando o usuário fecha no "X", limpamos a ref e chamamos o callback
    w.on("closed", () => {
        ctx.setInspectorWin(null);
        try {
            opts?.onClosed?.(); // quem abriu decide (ex.: parar captura / emitir cap:state)
        } catch {
            /* noop */
        }
    });

    ctx.setInspectorWin(w);
}

/** Esconde o Inspector (não fecha). */
export function hideInspector(ctx: AppContext): void {
    const w = ctx.inspectorWin;
    if (w && !w.isDestroyed()) w.hide();
}
