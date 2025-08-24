/**
 * @file src/main/capture.session.ts
 * @brief Gera HAR (REST) e NDJSON (WS/txn) a partir dos eventos de captura.
 *        - Escreve HAR em disco ao finalizar.
 *        - WS em NDJSON via stream append.
 *        - Suporta NDJSON de CapTxn (agregador) opcional.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import { ensureDir, openAppendStream, writeJsonLine, timestamp } from "./fsutil";
import { config } from "./config";

/** ------------ Tipos dos eventos REST/WS vindos do main/capture ------------ */
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

type WsOpen  = { ts: number; id: string; url: string; protocols?: string | string[] };
type WsMsg   = { ts: number; id: string; dir: "in" | "out"; data: string };
type WsClose = { ts: number; id: string; code: number; reason: string };
type WsError = { ts: number; id: string };

/** --------------------------- Tipos HAR mínimos --------------------------- */
type HarHeader   = { name: string; value: string };
type HarPostData = { mimeType: string; text: string };
type HarRequest  = {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  headersSize: number;
  bodySize: number;
  postData?: HarPostData; // opcional: só presente quando houver body
};
type HarContent  = { size: number; mimeType: string; text: string };
type HarResponse = {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  headersSize: number;
  bodySize: number;
  content: HarContent;
};
type HarTimings  = { send: number; wait: number; receive: number };
type HarEntry    = {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, unknown>;
  timings: HarTimings;
  pageref: string;
};
type HarPage     = {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: Record<string, unknown>;
};
type HarLog      = {
  version: string;
  creator: { name: string; version: string };
  pages: HarPage[];
  entries: HarEntry[];
};
type HarFile     = { log: HarLog };

/** --------------------------- Agregado (txn) --------------------------- */
import type { CapTxn } from "../common/capture.types";

/**
 * @class CaptureSession
 * @brief Sessão de gravação de artefatos de captura (HAR/NDJSON).
 */
export class CaptureSession {
  private baseDir: string;
  private harPath: string;
  private wsPath: string;
  private wsStream: fs.WriteStream;
  private har: HarFile;

  /** correlaciona última request por (method + url) */
  private lastReq: Map<string, RestReq> = new Map();

  /** FD do arquivo NDJSON de txns; usar null como sentinela (evita undefined). */
  private ndjsonFd: number | null = null;

  /**
   * @method startNdjson
   * @brief Abre arquivo NDJSON para transações agregadas.
   */
  startNdjson(filePath: string): void {
    this.ndjsonFd = fs.openSync(filePath, "w"); // retorna number
  }

  /**
   * @method pushTxnNdjson
   * @brief Acrescenta uma transação agregada em linha NDJSON.
   */
  pushTxnNdjson(tx: CapTxn): void {
    const fd = this.ndjsonFd;
    if (fd == null) return; // narrow explícito
    fs.writeSync(fd, JSON.stringify(tx) + "\n");
  }

  /**
   * @method stopNdjson
   * @brief Fecha o FD do NDJSON (se aberto).
   */
  stopNdjson(): void {
    const fd = this.ndjsonFd;
    if (fd != null) {
      fs.closeSync(fd);
      this.ndjsonFd = null;
    }
  }

  /** @constructor */
  constructor() {
    const t = timestamp();
    this.baseDir = path.resolve(app.getAppPath(), "..", config.outputFolder);
    ensureDir(this.baseDir);

    this.harPath = path.join(this.baseDir, `rest-${t}.har`);
    this.wsPath  = path.join(this.baseDir, `ws-${t}.wslog.ndjson`);
    this.wsStream = openAppendStream(this.wsPath);

    this.har = {
      log: {
        version: "1.2",
        creator: { name: "WirePeek", version: "0.1" },
        pages: [{
          startedDateTime: new Date().toISOString(),
          id: "page_1",
          title: "Main",
          pageTimings: {},
        }],
        entries: [],
      },
    };
  }

  /**
   * @method stop
   * @brief Persiste HAR e fecha stream de WS.
   */
  stop(): void {
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
    this.stopNdjson();
  }

  /**
   * @method onRestRequest
   * @brief Memoriza a última request por (method + url) para compor o HAR.
   */
  onRestRequest(d: RestReq): void {
    const key = `${d.method} ${d.url}`;
    this.lastReq.set(key, d);
  }

  /**
   * @method onRestResponse
   * @brief Gera uma entry HAR a partir da response + última request correlata.
   */
  onRestResponse(d: RestRes): void {
    const key = `${d.method} ${d.url}`;
    const req = this.lastReq.get(key);

    // started/time 100% numérico (sem undefined)
    const startedTs: number = req?.ts !== undefined ? req.ts : (d.ts - d.timingMs);
    const totalTimeMs: number = d.timingMs;

    const requestHeaders: HarHeader[] =
      Object.entries(req?.reqHeaders ?? {}).map(([name, value]) => ({ name, value }));

    const responseHeaders: HarHeader[] =
      Object.entries(d.resHeaders ?? {}).map(([name, value]) => ({ name, value }));

    const reqBody = req?.reqBody; // string | undefined

    const request: HarRequest = {
      method: d.method,
      url: d.url,
      httpVersion: "HTTP/2.0",
      headers: requestHeaders,
      headersSize: -1,
      bodySize: reqBody ? reqBody.length : 0,
      ...(reqBody
        ? {
            postData: {
              mimeType: (req?.reqHeaders["content-type"] ?? "text/plain"),
              text: reqBody,
            },
          }
        : {}),
    };

    const response: HarResponse = {
      status: d.status,
      statusText: d.statusText,
      httpVersion: "HTTP/2.0",
      headers: responseHeaders,
      headersSize: -1,
      bodySize: d.bodySize,
      content: {
        size: d.bodySize,
        mimeType: d.resHeaders["content-type"] ?? "",
        text: "", // não gravamos corpo para evitar volume; pode ser preenchido depois
      },
    };

    const entry: HarEntry = {
      startedDateTime: new Date(startedTs).toISOString(),
      time: totalTimeMs,
      request,
      response,
      cache: {},
      timings: { send: 0, wait: totalTimeMs, receive: 0 },
      pageref: "page_1",
    };

    this.har.log.entries.push(entry);
  }

  /** @method onWsOpen */
  onWsOpen(d: WsOpen): void  { writeJsonLine(this.wsStream, { type: "open",  ...d }); }
  /** @method onWsMsg  */
  onWsMsg(d: WsMsg): void    { writeJsonLine(this.wsStream, { type: "msg",   ...d }); }
  /** @method onWsClose*/
  onWsClose(d: WsClose): void{ writeJsonLine(this.wsStream, { type: "close", ...d }); }
  /** @method onWsError*/
  onWsError(d: WsError): void{ writeJsonLine(this.wsStream, { type: "error", ...d }); }
}
