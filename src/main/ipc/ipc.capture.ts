// src/main/ipc/ipc.capture.ts
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
import { config } from "../config";
import type { CapTxn } from "../common/capture.types";

/* ----------------------------------------------------------------------------
 * Tipos dos envelopes/granulares que trafegam até o Inspector
 * -------------------------------------------------------------------------- */

/**
 * @typedef WsOpenPayload
 * @property {number} ts
 * @property {string} id
 * @property {string} url
 * @property {string|string[]} [protocols]
 */
type WsOpenPayload = { ts: number; id: string; url: string; protocols?: string | string[] };

/**
 * @typedef WsMsgPayload
 * @property {number} ts
 * @property {"in"|"out"} dir
 * @property {string} id
 * @property {string} data
 */
type WsMsgPayload = { ts: number; id: string; dir: "in" | "out"; data: string };

/**
 * @typedef WsClosePayload
 * @property {number} ts
 * @property {string} id
 * @property {number} code
 * @property {string} reason
 */
type WsClosePayload = { ts: number; id: string; code: number; reason: string };

/** @typedef WsErrorPayload */
type WsErrorPayload = { ts: number; id: string };

/**
 * @typedef WsFramePayload
 * @brief Frames WS via CDP (opcional).
 * @property {number} ts
 * @property {"in"|"out"} direction
 * @property {string} [url]
 * @property {number} [opCode]
 * @property {string} [data]
 */
type WsFramePayload = {
    ts: number;
    direction: "in" | "out";
    url?: string;
    opCode?: number;
    data?: string;
};

/**
 * @typedef CdpInitiator
 * @property {string} type    Ex.: "parser", "script", "preload", "other"
 * @property {string} [url]   URL que causou o disparo (quando aplicável)
 */
type CdpInitiator = { type: string; url?: string };

/**
 * @typedef CdpRedirect
 * @property {string} from  URL de origem (antes do redirect)
 * @property {string} to    URL de destino (após o redirect)
 * @property {number} status Código HTTP do redirect (ex.: 301, 302, 307...)
 */
type CdpRedirect = { from: string; to: string; status: number };

/**
 * @typedef CdpInitiatorPayload
 * @brief Evento sintético para o Inspector com initiator + cadeia de redirects
 * @property {string} requestId       ID do CDP (Network.requestWillBeSent.requestId)
 * @property {string} url             URL atual da navegação/pedido
 * @property {CdpRedirect[]} redirectChain  Cadeia acumulada de redirects
 * @property {CdpInitiator} [initiator]     Initiator (quando fornecido pelo CDP)
 */
type CdpInitiatorPayload = {
    requestId: string;
    url: string;
    redirectChain: CdpRedirect[];
    initiator?: CdpInitiator;
};

/**
 * @typedef CapEnvelope
 * @brief Union dos eventos encaminhados ao Inspector.
 */
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
    | { channel: "cap:cdp:initiator"; payload: CdpInitiatorPayload };

/* ----------------------------------------------------------------------------
 * Estado interno de captura
 * -------------------------------------------------------------------------- */

let detachWebRequest: null | (() => void) = null; // remove webRequest hooks
let detachCdp: null | (() => void) = null;        // detach do DevTools Protocol
let capSession: CaptureSession | null = null;     // sessão de gravação atual

/** @returns {boolean} Se há captura ativa. */
function isCapturing(): boolean {
    return !!detachWebRequest || !!detachCdp;
}

/** Notifica todas as UIs sobre o estado de captura. */
function broadcastState(): void {
    const payload = { capturing: isCapturing() };
    for (const wc of webContents.getAllWebContents()) {
        // evita enviar para DevTools e outras visões internas
        if (!wc.getURL().startsWith("devtools://")) wc.send("cap:state", payload);
    }
}

/** Envia envelopes para o Inspector (se existir). */
function inspectorBroadcast(ctx: AppContext, env: CapEnvelope): void {
    const w = ctx.inspectorWin;
    if (!w || w.isDestroyed()) return;
    w.webContents.send("cap-event", env);
}

/* ----------------------------------------------------------------------------
 * Helpers (type guards) para extrair campos do CDP sem `any`
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
 * CDP (Chrome DevTools Protocol) — Initiator + Redirect chain + WS frames
 * -------------------------------------------------------------------------- */

/**
 * @brief Liga o DevTools Protocol no WebContents:
 *        - Network.requestWillBeSent → Initiator + cadeia de redirects
 *        - Network.webSocket*        → Frames WS (texto/binário) resumidos
 * @param ctx Contexto da app (para emitir ao Inspector)
 * @param wc  WebContents que será observado
 * @returns função de detach (remove listeners e solta o debugger)
 */
function attachCdpNetwork(ctx: AppContext, wc: WebContents): () => void {
    if (!config.enableCdp) return () => void 0;

    // Mantém o tipo fixo para evitar never[]
    interface CdpRequestInfo {
        url: string;
        chain: CdpRedirect[];
        initiator?: CdpInitiator;
    }

    try {
        if (wc.debugger.isAttached()) return () => void 0;

        wc.debugger.attach("1.3");
        void wc.debugger.sendCommand("Network.enable", { maxPostDataSize: 0 });

        // requestId → info
        const rqs = new Map<string, CdpRequestInfo>();
        // requestId → url (para mapear frames WS)
        const wsUrlById = new Map<string, string>();

        const onMessage = (_ev: unknown, method: string, params: unknown): void => {
            try {
                // -------------------- Initiator + redirect chain --------------------
                if (method === "Network.requestWillBeSent") {
                    const id = String(getStr(params, "requestId") ?? "");
                    const req = getObj(params, "request");
                    const url = String((req && getStr(req, "url")) ?? "");
                    if (!id || !url) return;

                    const initObj = getObj(params, "initiator");
                    const maybeInitiator: CdpInitiator | undefined = initObj
                        ? {
                            type: String(getStr(initObj, "type") ?? "other"),
                            ...(getStr(initObj, "url") !== undefined ? { url: getStr(initObj, "url")! } : {}),
                        }
                        : undefined;

                    // cria/recupera mantendo tipos estáveis
                    let prev = rqs.get(id);
                    if (!prev) {
                        prev = { url, chain: [] as CdpRedirect[] };
                        if (maybeInitiator) prev.initiator = maybeInitiator;
                        rqs.set(id, prev);
                    } else {
                        prev.url = url;
                        if (maybeInitiator) prev.initiator = maybeInitiator;
                    }

                    // redirect?
                    const redirectResp = getObj(params, "redirectResponse");
                    if (redirectResp) {
                        const from = String(getStr(redirectResp, "url") ?? "");
                        const statusNum = Number(getNum(redirectResp, "status") ?? 0);
                        // prev.chain tem tipo CdpRedirect[] (não é never[])
                        prev.chain.push({ from, to: url, status: statusNum });
                    }

                    const payload: CdpInitiatorPayload = {
                        requestId: id,
                        url,
                        redirectChain: prev.chain,
                        ...(prev.initiator ? { initiator: prev.initiator } : {}),
                    };
                    inspectorBroadcast(ctx, { channel: "cap:cdp:initiator", payload });
                    return;
                }

                // -------------------- WebSocket bookkeeping --------------------
                if (method === "Network.webSocketCreated") {
                    const reqId = getStr(params, "requestId");
                    const url = getStr(params, "url");
                    if (reqId && url) wsUrlById.set(reqId, url);
                    return;
                }

                // -------------------- WS frame enviado -------------------------
                if (method === "Network.webSocketFrameSent") {
                    const reqId = getStr(params, "requestId");
                    const response = getObj(params, "response");
                    const opcode = response ? getNum(response, "opcode") : undefined;
                    const payloadData = response ? getStr(response, "payloadData") : undefined;
                    const url = reqId ? wsUrlById.get(reqId) : undefined;

                    const frame: WsFramePayload = {
                        ts: Date.now(),
                        direction: "out",
                        ...(url !== undefined ? { url } : {}),
                        ...(opcode !== undefined ? { opCode: opcode } : {}),
                        ...(payloadData !== undefined ? { data: payloadData } : {}),
                    };
                    inspectorBroadcast(ctx, { channel: "cap:ws:frame", payload: frame });
                    return;
                }

                // -------------------- WS frame recebido ------------------------
                if (method === "Network.webSocketFrameReceived") {
                    const reqId = getStr(params, "requestId");
                    const response = getObj(params, "response");
                    const opcode = response ? getNum(response, "opcode") : undefined;
                    const payloadData = response ? getStr(response, "payloadData") : undefined;
                    const url = reqId ? wsUrlById.get(reqId) : undefined;

                    const frame: WsFramePayload = {
                        ts: Date.now(),
                        direction: "in",
                        ...(url !== undefined ? { url } : {}),
                        ...(opcode !== undefined ? { opCode: opcode } : {}),
                        ...(payloadData !== undefined ? { data: payloadData } : {}),
                    };
                    inspectorBroadcast(ctx, { channel: "cap:ws:frame", payload: frame });
                    return;
                }
            } catch {
                /* noop */
            }
        };

        wc.debugger.on("message", onMessage);

        return (): void => {
            try { wc.debugger.removeListener("message", onMessage); } catch { /* noop */ }
            try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* noop */ }
        };
    } catch {
        return () => void 0;
    }
}

/* ----------------------------------------------------------------------------
 * Parada centralizada da captura
 * -------------------------------------------------------------------------- */

/**
 * @brief Para a captura: remove hooks, fecha artefatos, atualiza estado e UI.
 * @param ctx    AppContext
 * @param reason "user" | "inspector-closed"
 */
function stopCaptureInternal(
    ctx: AppContext,
    reason: "user" | "inspector-closed"
):
    | { capturing: false; out: { ok: true } }
    | { capturing: false; out: { ok: false; reason: string } } {
    if (!isCapturing()) {
        broadcastState();
        return { capturing: false, out: { ok: false, reason: "not-running" } };
    }

    try {
        // 1) Remover hooks webRequest
        try { detachWebRequest?.(); } catch { /* noop */ }
        detachWebRequest = null;

        // 2) Detach CDP (se ligado)
        try { detachCdp?.(); } catch { /* noop */ }
        detachCdp = null;

        // 3) Parar persistências/artefatos
        if (capSession) {
            capSession.stop();
            capSession = null;
        }

        // 4) Lidar com janela do Inspector
        if (reason === "user") hideInspector(ctx);

        return { capturing: false, out: { ok: true } };
    } finally {
        broadcastState();
    }
}

/* ----------------------------------------------------------------------------
 * Registro dos handlers IPC
 * -------------------------------------------------------------------------- */

/** Registra os IPC handlers do fluxo de captura. */
export function registerCaptureIpc(ctx: AppContext): void {
    /**
     * wirepeek:start
     *  - Inicia sessão de gravação (HAR/NDJSON, conforme implementado)
     *  - Ativa hooks de captura (webRequest) na sessão da janela principal
     *    **já injetando `saveBody`** para persistência condicional
     *  - Abre Inspector e garante stop se fechar no "X"
     *  - (Opcional) Liga CDP para Initiator/Redirect e frames WS
     */
    ipcMain.handle("wirepeek:start", () => {
        if (!isCapturing() && ctx.mainWin && !ctx.mainWin.isDestroyed()) {
            // 1) Sessão de gravação
            capSession = new CaptureSession();

            // 2) Hooks de rede via webRequest + injeção de saveBody
            detachWebRequest = attachNetworkCapture(
                ctx.mainWin as BrowserWindow,
                (channel, payload) => {
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
                },
                // injeta callback de salvar body em disco
                { saveBody: capSession.saveBody.bind(capSession) }
            );

            // 3) CDP para Initiator/Redirect + WS frames
            try {
                detachCdp = attachCdpNetwork(ctx, ctx.mainWin.webContents);
            } catch {
                detachCdp = null;
            }

            // 4) Abre o Inspector e, se fechar no "X", paramos a captura
            openInspector(ctx, ctx.mainWin, {
                onClosed: () => {
                    stopCaptureInternal(ctx, "inspector-closed");
                },
            });

            broadcastState();
        }

        return { capturing: isCapturing() };
    });

    /** wirepeek:stop — para captura sob demanda do usuário (UI principal) */
    ipcMain.handle("wirepeek:stop", () => stopCaptureInternal(ctx, "user"));

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
                    // Se quiser salvar transações agregadas em NDJSON:
                    // capSession.pushTxnNdjson?.(env.payload as CapTxn);
                    break;
                // "cap:ws:frame" e "cap:cdp:initiator" vão só para o Inspector por enquanto.
                default:
                    break;
            }
        }

        inspectorBroadcast(ctx, env);
    });
}
