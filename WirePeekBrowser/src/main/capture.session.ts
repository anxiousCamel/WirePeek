// src/main/capture.session.ts
import fs from "fs";
import path from "path";
import { ensureDir, openAppendStream, writeJsonLine, timestamp } from "./fsutil";
import { app } from "electron";
import { config } from "./config";

/** ------------ Tipos dos eventos que chegam do webview ------------ */
type RestReq = {
    ts: number;
    url: string;
    method: string;
    reqHeaders: Record<string, string>;
    reqBody?: string;
};
type RestRes = {
    ts: number;
    url: string;
    method: string;
    status: number;
    statusText: string;
    resHeaders: Record<string, string>;
    bodySize: number;
    timingMs: number;
};
type WsOpen = { ts: number; id: string; url: string; protocols?: string | string[] };
type WsMsg = { ts: number; id: string; dir: "in" | "out"; data: string };
type WsClose = { ts: number; id: string; code: number; reason: string };
type WsError = { ts: number; id: string };

/** --------------------------- Tipos HAR mínimos --------------------------- */
type HarHeader = { name: string; value: string };
type HarPostData = { mimeType: string; text: string };
type HarRequest = {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    headersSize: number;
    bodySize: number;
    postData?: HarPostData;
};
type HarContent = { size: number; mimeType: string; text: string };
type HarResponse = {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    headersSize: number;
    bodySize: number;
    content: HarContent;
};
type HarTimings = { send: number; wait: number; receive: number };
type HarEntry = {
    startedDateTime: string;
    time: number;
    request: HarRequest;
    response: HarResponse;
    cache: Record<string, unknown>;
    timings: HarTimings;
    pageref: string;
};
type HarPage = {
    startedDateTime: string;
    id: string;
    title: string;
    pageTimings: Record<string, unknown>;
};
type HarLog = {
    version: string;
    creator: { name: string; version: string };
    pages: HarPage[];
    entries: HarEntry[];
};
type HarFile = { log: HarLog };

/** ------------------------------------------------------------------------ */

export class CaptureSession {
    private baseDir: string;
    private harPath: string;
    private wsPath: string;
    private wsStream: fs.WriteStream;
    private har: HarFile;

    // mapa chave para correlacionar (url+method) => último started (simples e suficiente para backtest)
    private lastReq: Map<string, RestReq> = new Map();

    constructor() {
        const t = timestamp();
        this.baseDir = path.resolve(app.getAppPath(), "..", config.outputFolder);
        ensureDir(this.baseDir);
        this.harPath = path.join(this.baseDir, `rest-${t}.har`);
        this.wsPath = path.join(this.baseDir, `ws-${t}.wslog.ndjson`);
        this.wsStream = openAppendStream(this.wsPath);

        this.har = {
            log: {
                version: "1.2",
                creator: { name: "WirePeek", version: "0.1" },
                pages: [
                    {
                        startedDateTime: new Date().toISOString(),
                        id: "page_1",
                        title: "Main",
                        pageTimings: {},
                    },
                ],
                entries: [],
            },
        };
    }

    stop() {
        try {
            fs.writeFileSync(this.harPath, JSON.stringify(this.har, null, 2), "utf8");
        } catch (e) {
            console.debug("[cap] failed to write HAR:", e);
        }
        try {
            this.wsStream.close();
        } catch (e) {
            console.debug("[cap] failed to close ws log stream:", e);
        }
    }

    onRestRequest(d: RestReq) {
        const key = `${d.method} ${d.url}`;
        this.lastReq.set(key, d);
    }

    onRestResponse(d: RestRes) {
        const key = `${d.method} ${d.url}`;
        const req = this.lastReq.get(key);
        const started = req?.ts ?? d.ts - d.timingMs;
        const time = d.timingMs;

        const requestHeaders: HarHeader[] =
            Object.entries(req?.reqHeaders ?? {}).map(([name, value]) => ({ name, value }));
        const responseHeaders: HarHeader[] =
            Object.entries(d.resHeaders ?? {}).map(([name, value]) => ({ name, value }));

        const reqBody = req?.reqBody;
        const request: HarRequest = {
            method: d.method,
            url: d.url,
            httpVersion: "HTTP/2.0",
            headers: requestHeaders,
            headersSize: -1,
            bodySize: reqBody?.length ?? 0,
            ...(reqBody
                ? { postData: { mimeType: req?.reqHeaders["content-type"] || "text/plain", text: reqBody } }
                : {}), // <-- omite a chave quando não houver body
        };

        this.har.log.entries.push({
            startedDateTime: new Date(started).toISOString(),
            time,
            request,
            response: {
                status: d.status,
                statusText: d.statusText,
                httpVersion: "HTTP/2.0",
                headers: responseHeaders,
                headersSize: -1,
                bodySize: d.bodySize,
                content: { size: d.bodySize, mimeType: d.resHeaders["content-type"] || "", text: "" },
            },
            cache: {},
            timings: { send: 0, wait: time, receive: 0 },
            pageref: "page_1",
        });
    }


    onWsOpen(d: WsOpen) { writeJsonLine(this.wsStream, { type: "open", ...d }); }
    onWsMsg(d: WsMsg) { writeJsonLine(this.wsStream, { type: "msg", ...d }); }
    onWsClose(d: WsClose) { writeJsonLine(this.wsStream, { type: "close", ...d }); }
    onWsError(d: WsError) { writeJsonLine(this.wsStream, { type: "error", ...d }); }
}
