/**
 * @file src/main/ipc/ipc.capture.ts
 * @brief IPC do fluxo de captura:
 *        - wirepeek:start        → inicia captura, abre Inspector, grava artefatos
 *        - wirepeek:stop         → para captura, fecha artefatos, atualiza estado
 *        - wirepeek:getState     → estado atual
 *        - cap:from-webview      → eventos do <webview> (fetch / XHR / WS)
 *
 *        Também sincroniza estado quando o usuário fecha o Inspector no “X”
 *        (via callback onClosed em openInspector).
 */

import { ipcMain, BrowserWindow, webContents, type WebContents } from "electron";
import type { AppContext } from "../context.js";
import {
    attachNetworkCapture,
    type RestRequestPayload,
    type RestResponsePayload,
} from "../capture.js";
import { CaptureSession } from "../capture.session.js";
import { openInspector, hideInspector } from "../win.inspector.js";
import type { CapTxn } from "../common/capture.types.ts";

/* ----------------------------------------------------------------------------
 * Tipos dos envelopes/granulares que trafegam até o Inspector
 * -------------------------------------------------------------------------- */

type WsOpenPayload = { ts: number; id: string; url: string; protocols?: string | string[] };
type WsMsgPayload = { ts: number; id: string; dir: "in" | "out"; data: string };
type WsClosePayload = { ts: number; id: string; code: number; reason: string };
type WsErrorPayload = { ts: number; id: string };

/**
 * Frames WS via CDP (opcional). `direction` indica sentido do frame;
 * `url` é resolvido a partir de `Network.webSocketCreated`.
 */
type WsFramePayload = {
    ts: number;
    direction: "in" | "out";
    url?: string | undefined;
    opCode?: number | undefined;
    data?: string | undefined;
};

type CapEnvelope =
    | { channel: "cap:txn"; payload: CapTxn }
    | { channel: "cap:rest:request"; payload: RestRequestPayload }
    | { channel: "cap:rest:before-send-headers"; payload: RestRequestPayload }
    | { channel: "cap:rest:response"; payload: RestResponsePayload }
    | { channel: "cap:rest:error"; payload: RestRequestPayload }
    | { channel: "cap:ws:open"; payload: WsOpenPayload }
    | { channel: "cap:ws:msg"; payload: WsMsgPayload }
    | { channel: "cap:ws:close"; payload: WsClosePayload }
    | { channel: "cap:ws:error"; payload: WsErrorPayload }
    | { channel: "cap:ws:frame"; payload: WsFramePayload }
/* ----------------------------------------------------------------------------
 * Estado interno de captura
 * -------------------------------------------------------------------------- */

let detachWebRequest: null | (() => void) = null;  // remove webRequest hooks
let detachCdp: null | (() => void) = null;         // detach do DevTools Protocol
let capSession: CaptureSession | null = null;      // sessão de gravação atual

/**
 * @brief Diz se há captura ativa.
 */
function isCapturing(): boolean {
    return !!detachWebRequest || !!detachCdp;
}

/**
 * @brief Notifica todas as UIs (renderers + inspector) sobre o estado de captura.
 */
function broadcastState(): void {
    const payload = { capturing: isCapturing() };
    for (const wc of webContents.getAllWebContents()) {
        // evita enviar para DevTools e outras visões internas
        if (!wc.getURL().startsWith("devtools://")) {
            wc.send("cap:state", payload);
        }
    }
}

/**
 * @brief Envia envelopes para o Inspector (se existir).
 */
function inspectorBroadcast(ctx: AppContext, env: CapEnvelope): void {
    const w = ctx.inspectorWin;
    if (!w || w.isDestroyed()) return;
    w.webContents.send("cap-event", env);
}

/* ----------------------------------------------------------------------------
 * Helpers (type guards) para extrair campos do CDP sem usar `any`
 * -------------------------------------------------------------------------- */

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === "object" && x !== null;
}
function getStr(obj: unknown, key: string): string | undefined {
    return isRecord(obj) && typeof obj[key] === "string" ? (obj[key] as string) : undefined;
}
function getNum(obj: unknown, key: string): number | undefined {
    return isRecord(obj) && typeof obj[key] === "number" ? (obj[key] as number) : undefined;
}
function getObj(obj: unknown, key: string): Record<string, unknown> | undefined {
    return isRecord(obj) && isRecord(obj[key]) ? (obj[key] as Record<string, unknown>) : undefined;
}

/* ----------------------------------------------------------------------------
 * CDP (Chrome DevTools Protocol) opcional para frames WS binários
 * -------------------------------------------------------------------------- */

/**
 * @brief Liga o DevTools Protocol em um WebContents para escutar frames de WebSocket.
 * @param ctx Contexto da aplicação (para emitir ao inspector).
 * @param wc  WebContents da janela onde os frames devem ser observados.
 * @returns função de detach (remove listeners e solta o debugger).
 */
function attachCdpNetwork(ctx: AppContext, wc: WebContents): () => void {
    try {
        if (wc.debugger.isAttached()) {
            // já anexado por outro trecho; não vamos interferir
            return () => void 0;
        }

        wc.debugger.attach("1.3");
        // Habilita domínio Network
        void wc.debugger.sendCommand("Network.enable");

        // Mapeia requestId → url para lookup nos eventos de frame
        const wsUrlById = new Map<string, string>();

        const onMessage = (_ev: unknown, method: string, params: unknown): void => {
            try {
                // Network.webSocketCreated → guarda URL
                if (method === "Network.webSocketCreated") {
                    const reqId = getStr(params, "requestId");
                    const url = getStr(params, "url");
                    if (reqId && url) wsUrlById.set(reqId, url);
                    return;
                }

                // Frame enviado
                if (method === "Network.webSocketFrameSent") {
                    const reqId = getStr(params, "requestId");
                    const response = getObj(params, "response");
                    const opcode = response ? getNum(response, "opcode") : undefined;
                    const payloadData = response ? getStr(response, "payloadData") : undefined;

                    const url = (reqId && wsUrlById.get(reqId)) || undefined;
                    inspectorBroadcast(ctx, {
                        channel: "cap:ws:frame",
                        payload: { ts: Date.now(), direction: "out", url, opCode: opcode, data: payloadData },
                    });
                    return;
                }

                // Frame recebido
                if (method === "Network.webSocketFrameReceived") {
                    const reqId = getStr(params, "requestId");
                    const response = getObj(params, "response");
                    const opcode = response ? getNum(response, "opcode") : undefined;
                    const payloadData = response ? getStr(response, "payloadData") : undefined;

                    const url = (reqId && wsUrlById.get(reqId)) || undefined;
                    inspectorBroadcast(ctx, {
                        channel: "cap:ws:frame",
                        payload: { ts: Date.now(), direction: "in", url, opCode: opcode, data: payloadData },
                    });
                    return;
                }

                // Opcional: Network.responseReceived → Network.getResponseBody(requestId)
                // (se no futuro quiser corpo das respostas)
            } catch (_e) {
                // nunca propagar erro do listener
                void 0;
            }
        };

        wc.debugger.on("message", onMessage);

        // detach
        return (): void => {
            try {
                wc.debugger.removeListener("message", onMessage);
            } catch (_e) {
                void 0;
            }
            try {
                if (wc.debugger.isAttached()) wc.debugger.detach();
            } catch (_e) {
                void 0;
            }
        };
    } catch (_e) {
        // Falha ao anexar: apenas siga sem CDP
        return () => void 0;
    }
}

/* ----------------------------------------------------------------------------
 * Parada centralizada da captura
 * -------------------------------------------------------------------------- */

/**
 * @brief Para a captura: remove hooks, fecha artefatos, atualiza estado e UI.
 * @param ctx    AppContext
 * @param reason "user" (pedido explícito) | "inspector-closed" (fechou no X)
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
        // 1) Remover hooks webRequest
        try {
            detachWebRequest?.();
        } catch (_e) {
            void 0;
        }
        detachWebRequest = null;

        // 2) Detach CDP (se ligado)
        try {
            detachCdp?.();
        } catch (_e) {
            void 0;
        }
        detachCdp = null;

        // 3) Parar persistências/artefatos
        if (capSession) {
            capSession.stop();
            capSession = null;
        }

        // 4) Lidar com janela do Inspector
        if (reason === "user") {
            hideInspector(ctx);
        }

        return { capturing: false, out: { ok: true } };
    } finally {
        broadcastState();
    }
}

/* ----------------------------------------------------------------------------
 * Registro dos handlers IPC
 * -------------------------------------------------------------------------- */

/**
 * @brief Registra os IPC handlers do fluxo de captura.
 */
export function registerCaptureIpc(ctx: AppContext): void {
    /**
     * wirepeek:start
     *  - Ativa hooks de captura (webRequest) na sessão da janela principal
     *  - Inicia sessão de gravação (HAR/NDJSON, conforme implementado)
     *  - Abre Inspector e garante stop se fechar no "X"
     *  - (Opcional) Liga CDP para frames WS binários
     */
    ipcMain.handle("wirepeek:start", () => {
        if (!isCapturing() && ctx.mainWin && !ctx.mainWin.isDestroyed()) {
            // Hooks de rede via webRequest
            detachWebRequest = attachNetworkCapture(ctx.mainWin as BrowserWindow, (channel, payload) => {
                const env = { channel, payload } as CapEnvelope;

                // Persistência REST → HAR
                if (capSession) {
                    if (channel === "cap:rest:request") {
                        capSession.onRestRequest(payload as RestRequestPayload);
                    } else if (channel === "cap:rest:response") {
                        capSession.onRestResponse(payload as RestResponsePayload);
                    }
                }

                inspectorBroadcast(ctx, env);
            });

            // Sessão de gravação
            capSession = new CaptureSession();

            // (Opcional) CDP para frames WS (binário)
            try {
                detachCdp = attachCdpNetwork(ctx, ctx.mainWin.webContents);
            } catch (_e) {
                detachCdp = null;
            }

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
     *  - Para a captura sob demanda do usuário (UI principal)
     */
    ipcMain.handle("wirepeek:stop", () => {
        return stopCaptureInternal(ctx, "user");
    });

    /** Estado atual sob demanda */
    ipcMain.handle("wirepeek:getState", () => ({ capturing: isCapturing() }));

    /**
     * cap:from-webview
     *  - Eventos emitidos pelo <webview> (patch de fetch/XHR/WS) encaminhados ao Inspector
     *    e persistidos quando aplicável.
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
                    // Se desejar salvar transações agregadas em NDJSON:
                    // capSession.pushTxnNdjson?.(env.payload as CapTxn);
                    break;
                // "cap:ws:frame" (CDP) atualmente só é encaminhado ao inspector.
                default:
                    break;
            }
        }

        inspectorBroadcast(ctx, env);
    });
}
