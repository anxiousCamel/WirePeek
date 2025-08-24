// src/main/ipc/ipc.capture.ts
import { ipcMain, BrowserWindow, webContents } from "electron";
import type { AppContext } from "../context.js";
import {
    attachNetworkCapture,
    type RestRequestPayload,
    type RestResponsePayload,
} from "../capture.js";
import { CaptureSession } from "../capture.session.js";
import { openInspector, hideInspector } from "../win.inspector.js";

type WsOpenPayload = { ts: number; id: string; url: string; protocols?: string | string[] };
type WsMsgPayload = { ts: number; id: string; dir: "in" | "out"; data: string };
type WsClosePayload = { ts: number; id: string; code: number; reason: string };
type WsErrorPayload = { ts: number; id: string };
type TxnPayload = unknown; // (defina seu tipo real se tiver)

type CapEnvelope =
    | { channel: "cap:rest:request"; payload: RestRequestPayload }
    | { channel: "cap:rest:before-send-headers"; payload: RestRequestPayload }
    | { channel: "cap:rest:response"; payload: RestResponsePayload }
    | { channel: "cap:rest:error"; payload: RestRequestPayload }
    | { channel: "cap:ws:open"; payload: WsOpenPayload }
    | { channel: "cap:ws:msg"; payload: WsMsgPayload }
    | { channel: "cap:ws:close"; payload: WsClosePayload }
    | { channel: "cap:ws:error"; payload: WsErrorPayload }
    | { channel: "cap:txn"; payload: TxnPayload };

let detach: null | (() => void) = null;
let capSession: CaptureSession | null = null;

function isCapturing(): boolean { return !!detach; }

function broadcastState(): void {
    const payload = { capturing: isCapturing() };
    for (const wc of webContents.getAllWebContents()) {
        if (!wc.getURL().startsWith("devtools://")) wc.send("cap:state", payload);
    }
}

function inspectorBroadcast(ctx: AppContext, env: CapEnvelope): void {
    if (!ctx.inspectorWin || ctx.inspectorWin.isDestroyed()) return;
    ctx.inspectorWin.webContents.send("cap-event", env);
}

export function registerCaptureIpc(ctx: AppContext): void {
    ipcMain.handle("wirepeek:start", () => {
        if (!isCapturing() && ctx.mainWin) {
            detach = attachNetworkCapture(ctx.mainWin as BrowserWindow, (ch, payload) => {
                const env = { channel: ch, payload } as CapEnvelope;
                if (capSession) {
                    if (ch === "cap:rest:request") capSession.onRestRequest(payload as RestRequestPayload);
                    if (ch === "cap:rest:response") capSession.onRestResponse(payload as RestResponsePayload);
                }
                inspectorBroadcast(ctx, env);
            });
            capSession = new CaptureSession();
            openInspector(ctx, ctx.mainWin);
            broadcastState();
        }
        return { capturing: isCapturing() };
    });

    ipcMain.handle("wirepeek:stop", () => {
        if (!isCapturing()) return { capturing: false, out: { ok: false as const, reason: "not-running" as const } };
        detach!(); detach = null;
        if (capSession) { capSession.stop(); capSession = null; }
        hideInspector(ctx);
        broadcastState();
        return { capturing: false, out: { ok: true as const } };
    });

    ipcMain.handle("wirepeek:getState", () => ({ capturing: isCapturing() }));

    ipcMain.on("cap:from-webview", (_e, env: CapEnvelope) => {
        if (capSession) {
            switch (env.channel) {
                case "cap:rest:request": capSession.onRestRequest(env.payload); break;
                case "cap:rest:response": capSession.onRestResponse(env.payload); break;
                case "cap:ws:open": capSession.onWsOpen?.(env.payload); break;
                case "cap:ws:msg": capSession.onWsMsg?.(env.payload); break;
                case "cap:ws:close": capSession.onWsClose?.(env.payload); break;
                case "cap:ws:error": capSession.onWsError?.(env.payload); break;
                default: break;
            }
        }
        inspectorBroadcast(ctx, env);
    });
}
