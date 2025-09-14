/**
 * @file src/main/capture.session.ts
 * @brief Sessão de gravação da captura:
 *   - HAR (REST mínimo; content._file aponta para arquivo salvo quando houver)
 *   - NDJSON de eventos WebSocket (open/msg/close/error)
 *   - Persistência opcional de bodies de resposta em disco
 *
 * Requisitos externos:
 *   - ./fsutil: ensureDir, openAppendStream, writeJsonLine, timestamp
 *   - ./config: { outputFolder, captureBodies, captureBodyMaxBytes, captureBodyTypes, redactSecrets }
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import { ensureDir, openAppendStream, writeJsonLine, timestamp } from "./fsutil";
import { config } from "./config";
import type { CapTxn } from "../common/capture.types";

/* =======================================================================================
 * Tipos mínimos esperados pelos produtores de eventos (main/capture & IPC)
 * =======================================================================================
 */

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

export type SavedBodyInfo = {
  path: string;
  size: number;
  contentType?: string;
};

/* =======================================================================================
 * Definições HAR mínimas (com extensões customizadas)
 * =======================================================================================
 */

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

type HarContent = {
  size: number;
  mimeType: string;
  text: string;
  /** (custom) Caminho relativo do arquivo salvo em disco. */
  _file?: string;
};

type HarResponse = {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  headersSize: number;
  bodySize: number;
  content: HarContent;
  /** (custom) Indica que campos sensíveis foram redigidos. */
  _redacted?: boolean;
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

/* =======================================================================================
 * Utils internos
 * =======================================================================================
 */

function reqKey(method: string, url: string): string {
  return `${method} ${url}`;
}
function toHarHeaders(h?: Record<string, string>): HarHeader[] {
  return Object.entries(h ?? {}).map(([name, value]) => ({ name, value }));
}
function toRelative(baseDir: string, fullPath: string): string {
  try {
    return path.relative(baseDir, fullPath).replace(/\\/g, "/");
  } catch {
    return fullPath;
  }
}
function redactText(s: string): string {
  if (!config.redactSecrets) return s;
  return s
    .replace(/"password"\s*:\s*"([^"]+)"/gi, '"password":"***"')
    .replace(/"pass"\s*:\s*"([^"]+)"/gi, '"pass":"***"')
    .replace(/"token"\s*:\s*"([^"]+)"/gi, '"token":"***"')
    .replace(/"secret"\s*:\s*"([^"]+)"/gi, '"secret":"***"')
    .replace(/"apiKey"\s*:\s*"([^"]+)"/gi, '"apiKey":"***"')
    .replace(/\b(password|pass|token|secret|apiKey)=([^&]+)/gi, (_m, k) => `${k}=***`);
}
function shouldPersistBody(contentType: string | undefined, size: number): boolean {
  if (!config.captureBodies) return false;
  if (size <= 0) return false;
  if (size > config.captureBodyMaxBytes) return false;
  const ct = (contentType || "").toLowerCase();
  const rx = new RegExp(config.captureBodyTypes);
  return rx.test(ct);
}

/* =======================================================================================
 * Classe principal
 * =======================================================================================
 */

/**
 * @class CaptureSession
 * @brief Gerencia artefatos de uma sessão de captura (HAR, NDJSON e bodies).
 *
 * Fluxo:
 *   const s = new CaptureSession();
 *   s.onRestRequest(...);
 *   s.onRestResponse(...);
 *   s.onWsOpen/msg/close/error(...);
 *   s.stop();
 */
export class CaptureSession {
  private baseDir: string;
  private harPath: string;
  private wsPath: string;
  private wsStream: fs.WriteStream;
  private har: HarFile;

  private lastReq = new Map<string, RestReq>();
  private savedBodies = new Map<string, SavedBodyInfo>();
  private bodiesDir: string;

  private ndjsonFd: number | null = null;

  constructor() {
    const t = timestamp();

    // Base e subpasta para bodies
    this.baseDir = path.resolve(app.getAppPath(), "..", config.outputFolder);
    ensureDir(this.baseDir);

    this.bodiesDir = path.join(this.baseDir, `bodies-${t}`);
    ensureDir(this.bodiesDir);

    // Saídas
    this.harPath = path.join(this.baseDir, `rest-${t}.har`);
    this.wsPath = path.join(this.baseDir, `ws-${t}.wslog.ndjson`);
    this.wsStream = openAppendStream(this.wsPath);

    // HAR inicial
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

  /** Persiste o HAR/NDJSON e encerra recursos. */
  stop(): void {
    try { fs.writeFileSync(this.harPath, JSON.stringify(this.har, null, 2), "utf8"); } catch {/**/}
    try { this.wsStream.close(); } catch {/**/}
    this.stopNdjson();
  }

  // ----- NDJSON opcional para CapTxn -----

  startNdjson(filePath: string): void {
    this.ndjsonFd = fs.openSync(filePath, "w");
  }
  pushTxnNdjson(tx: CapTxn): void {
    const fd = this.ndjsonFd;
    if (fd == null) return;
    fs.writeSync(fd, JSON.stringify(tx) + "\n");
  }
  stopNdjson(): void {
    const fd = this.ndjsonFd;
    if (fd != null) {
      try { fs.closeSync(fd); } catch {/**/}
      this.ndjsonFd = null;
    }
  }

  // ----- REST → HAR -----

  onRestRequest(d: RestReq): void {
    this.lastReq.set(reqKey(d.method, d.url), d);
  }

  saveBody(idHint: string, buf: Uint8Array, contentType?: string): SavedBodyInfo {
    const safe = idHint.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const fname = `${Date.now()}_${safe}.bin`;
    const full = path.join(this.bodiesDir, fname);
    fs.writeFileSync(full, Buffer.from(buf));
    return { path: full, size: buf.byteLength, ...(contentType ? { contentType } : {}) };
  }

  noteResponseBody(method: string, url: string, info: SavedBodyInfo): void {
    this.savedBodies.set(reqKey(method, url), info);
  }

  onRestResponse(d: RestRes): void {
    const key = reqKey(d.method, d.url);
    const req = this.lastReq.get(key);

    const startedTs = req?.ts ?? d.ts - d.timingMs;

    const rawReqBody = req?.reqBody;
    const request: HarRequest = {
      method: d.method,
      url: d.url,
      httpVersion: "HTTP/2.0",
      headers: toHarHeaders(req?.reqHeaders),
      headersSize: -1,
      bodySize: rawReqBody ? rawReqBody.length : 0,
      ...(rawReqBody ? {
        postData: {
          mimeType: req?.reqHeaders["content-type"] ?? "text/plain",
          text: redactText(rawReqBody),
        },
      } : {}),
    };

    const saved = this.savedBodies.get(key);
    const ct = d.resHeaders["content-type"] ?? saved?.contentType ?? "";

    const content: HarContent = {
      size: d.bodySize,
      mimeType: ct,
      text: "",
      ...(saved ? { _file: toRelative(this.baseDir, saved.path) } : {}),
    };

    if (!saved && shouldPersistBody(ct, d.bodySize)) {
      // No-op aqui (persistência real deve ocorrer em quem tem os bytes).
    }

    const response: HarResponse = {
      status: d.status,
      statusText: d.statusText,
      httpVersion: "HTTP/2.0",
      headers: toHarHeaders(d.resHeaders),
      headersSize: -1,
      bodySize: d.bodySize,
      content,
      ...(config.redactSecrets ? { _redacted: true } : {}),
    };

    const entry: HarEntry = {
      startedDateTime: new Date(startedTs).toISOString(),
      time: d.timingMs,
      request,
      response,
      cache: {},
      timings: { send: 0, wait: d.timingMs, receive: 0 },
      pageref: "page_1",
    };

    this.har.log.entries.push(entry);
    this.lastReq.delete(key);
    this.savedBodies.delete(key);
  }

  // ----- WebSocket → NDJSON -----

  onWsOpen(d: { ts: number; id: string; url: string; protocols?: string | string[] }): void {
    void writeJsonLine(this.wsStream, { type: "open", ...d });
  }
  onWsMsg(d: { ts: number; id: string; dir: "in" | "out"; data: string }): void {
    void writeJsonLine(this.wsStream, { type: "msg", ...d });
  }
  onWsClose(d: { ts: number; id: string; code: number; reason: string }): void {
    void writeJsonLine(this.wsStream, { type: "close", ...d });
  }
  onWsError(d: { ts: number; id: string }): void {
    void writeJsonLine(this.wsStream, { type: "error", ...d });
  }
}
