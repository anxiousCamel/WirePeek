/**
 * @file src/main/ipc/ipc.capture.ts
 * @brief IPC do fluxo de captura:
 *        - wirepeek:start  → inicia captura, abre Inspector, grava artefatos
 *        - wirepeek:stop   → para captura, fecha artefatos, atualiza estado
 *        - wirepeek:getState → estado atual
 *        - cap:from-webview → recebe eventos do <webview> convidado
 *
 *        Também garante sincronização do estado quando o usuário
 *        fecha o Inspector pelo “X” (via callback onClosed em openInspector).
 */

import { ipcMain, BrowserWindow, webContents } from "electron";
import type { AppContext } from "../context.js";
import {
    attachNetworkCapture,
    type RestRequestPayload,
    type RestResponsePayload,
} from "../capture.js";
import { CaptureSession } from "../capture.session.js";
import { openInspector, hideInspector } from "../win.inspector.js";
import type { CapTxn } from "../common/capture.types.ts";

/* -------------------- Tipos de envelopes/granulares -------------------- */

type WsOpenPayload = { ts: number; id: string; url: string; protocols?: string | string[] };
type WsMsgPayload = { ts: number; id: string; dir: "in" | "out"; data: string };
type WsClosePayload = { ts: number; id: string; code: number; reason: string };

type WsErrorPayload = { ts: number; id: string };
type CapEnvelope =
    { channel: "cap:txn"; payload: CapTxn }
    | { channel: "cap:rest:request"; payload: RestRequestPayload }
    | { channel: "cap:rest:before-send-headers"; payload: RestRequestPayload }
    | { channel: "cap:rest:response"; payload: RestResponsePayload }
    | { channel: "cap:rest:error"; payload: RestRequestPayload }
    | { channel: "cap:ws:open"; payload: WsOpenPayload }
    | { channel: "cap:ws:msg"; payload: WsMsgPayload }
    | { channel: "cap:ws:close"; payload: WsClosePayload }
    | { channel: "cap:ws:error"; payload: WsErrorPayload };
/* ----------------------- Estado interno da captura ---------------------- */

let detach: null | (() => void) = null;        // função para remover webRequest hooks
let capSession: CaptureSession | null = null;  // sessão de gravação atual

function isCapturing(): boolean {
    return !!detach;
}

/** Notifica todas as UIs (renderer + inspector) sobre o estado de captura. */
function broadcastState(): void {
    const payload = { capturing: isCapturing() };
    for (const wc of webContents.getAllWebContents()) {
        // evita enviar para guias do DevTools
        if (!wc.getURL().startsWith("devtools://")) wc.send("cap:state", payload);
    }
}

/** Envia envelopes para o Inspector (se existir). */
function inspectorBroadcast(ctx: AppContext, env: CapEnvelope): void {
    if (!ctx.inspectorWin || ctx.inspectorWin.isDestroyed()) return;
    ctx.inspectorWin.webContents.send("cap-event", env);
}

/**
 * Para a captura de forma centralizada.
 * - Fecha/zera hooks
 * - Persiste/fecha artefatos
 * - Atualiza janelas/estado
 * @param ctx     AppContext
 * @param reason  "user" quando o botão/IPC pediu; "inspector-closed" quando o usuário fechou a janela do Inspector
 */
function stopCaptureInternal(
    ctx: AppContext,
    reason: "user" | "inspector-closed"
): { capturing: false; out: { ok: true } } | { capturing: false; out: { ok: false; reason: string } } {
    if (!isCapturing()) {
        broadcastState();
        return { capturing: false, out: { ok: false, reason: "not-running" } };
    }

    try {
        // Remover hooks
        detach?.();
        detach = null;

        // Parar persistências/artefatos
        if (capSession) {
            capSession.stop();
            capSession = null;
        }

        // Se foi o usuário que mandou parar, esconda o Inspector;
        // se foi fechado pelo "X", a janela já foi destruída no win.inspector.ts
        if (reason === "user") {
            hideInspector(ctx);
        }

        return { capturing: false, out: { ok: true } };
    } finally {
        broadcastState();
    }
}

/* ------------------------------ Registro IPC --------------------------- */

export function registerCaptureIpc(ctx: AppContext): void {
    /**
     * wirepeek:start
     * - Ativa hooks de captura na sessão da janela principal
     * - Começa sessão de gravação
     * - Abre Inspector com callback para parar captura se fechar no "X"
     */
    ipcMain.handle("wirepeek:start", () => {
        if (!isCapturing() && ctx.mainWin) {
            detach = attachNetworkCapture(
                ctx.mainWin as BrowserWindow,
                (channel, payload) => {
                    // Monta envelope e encaminha para o Inspector
                    const env = { channel, payload } as CapEnvelope;

                    // Persistência REST → HAR
                    if (capSession) {
                        if (channel === "cap:rest:request") {
                            capSession.onRestRequest(payload as RestRequestPayload);
                        }
                        if (channel === "cap:rest:response") {
                            capSession.onRestResponse(payload as RestResponsePayload);
                        }
                    }

                    inspectorBroadcast(ctx, env);
                }
            );

            // Sessão de gravação
            capSession = new CaptureSession();

            // Abre o Inspector e, se fechar no "X", paramos a captura + sincronizamos estado
            openInspector(ctx, ctx.mainWin, {
                onClosed: () => {
                    stopCaptureInternal(ctx, "inspector-closed");
                },
            });

            broadcastState();
        }

        return { capturing: isCapturing() };
    });

    /**
     * wirepeek:stop
     * - Para a captura sob demanda do usuário (UI principal)
     */
    ipcMain.handle("wirepeek:stop", () => {
        return stopCaptureInternal(ctx, "user");
    });

    /** Estado atual sob demanda */
    ipcMain.handle("wirepeek:getState", () => ({ capturing: isCapturing() }));

    /**
     * cap:from-webview
     * - Eventos emitidos pelo <webview> (patch de fetch/XHR/WS) encaminhados ao Inspector
     *   e persistidos quando aplicável (WS/open/msg/close/error etc).
     */
    ipcMain.on("cap:from-webview", (_e, env: CapEnvelope) => {
        if (capSession) {
            switch (env.channel) {
                case "cap:rest:request":
                    capSession.onRestRequest(env.payload as RestRequestPayload);
                    break;
                case "cap:rest:response":
                    capSession.onRestResponse(env.payload as RestResponsePayload);
                    break;
                case "cap:ws:open":
                    capSession.onWsOpen?.(env.payload as WsOpenPayload);
                    break;
                case "cap:ws:msg":
                    capSession.onWsMsg?.(env.payload as WsMsgPayload);
                    break;
                case "cap:ws:close":
                    capSession.onWsClose?.(env.payload as WsClosePayload);
                    break;
                case "cap:ws:error":
                    capSession.onWsError?.(env.payload as WsErrorPayload);
                    break;
                case "cap:txn":
                    // se desejar salvar transações agregadas em NDJSON:
                    // capSession.pushTxnNdjson?.(env.payload as CapTxn);
                    break;
                default:
                    break;
            }
        }

        inspectorBroadcast(ctx, env);
    });
}
