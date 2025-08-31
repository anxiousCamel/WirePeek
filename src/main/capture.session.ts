/**
 * @file src/main/capture.session.ts
 * @brief Gera HAR (REST) e NDJSON (WS/txn) a partir dos eventos de captura.
 *        - Escreve HAR em disco ao finalizar.
 *        - WS em NDJSON via stream append.
 *        - (Novo) Suporte a persistência de bodies de resposta em disco, com
 *          inclusão opcional do caminho no HAR via campos customizados `_file`.
 *
 * @details
 *  Este módulo é responsável por materializar artefatos em disco:
 *   • HAR de requisições REST (mínimo viável, com campos customizados `_file`)
 *   • NDJSON de eventos WebSocket (open/msg/close/error)
 *   • (Novo) Diretório `bodies-<timestamp>` para armazenar corpos de resposta
 *     quando permitido pela configuração.
 *
 *  Para salvar bodies, chame:
 *     - saveBody(idHint, bytes, contentType?)         → retorna SavedBodyInfo
 *     - noteResponseBody(method, url, savedBodyInfo)  → associa ao par (method+url)
 *  Em seguida, quando `onRestResponse` for chamado para o mesmo (method+url),
 *  o HAR será enriquecido com referências ao arquivo persistido.
 */

import fs from "fs";
import path from "path";
import { app } from "electron";
import { ensureDir, openAppendStream, writeJsonLine, timestamp } from "./fsutil";
import { config } from "./config";

/* ============================================================================
 * Tipos dos eventos REST/WS recebidos
 * ========================================================================== */

/** Evento (mínimo) da request vindo do pipeline do main/capture */
type RestReq = {
  ts: number;
  url: string;
  method: string;
  reqHeaders: Record<string, string>;
  reqBody?: string;
};

/** Evento (mínimo) da response vindo do pipeline do main/capture */
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

/* ============================================================================
 * Tipos (HAR mínimo) — com campos customizados
 * ========================================================================== */

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
  /**
   * @custom Campo customizado: caminho do arquivo do body salvo no disco
   * (relativo à pasta base de saída). Não faz parte do HAR 1.2.
   */
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
  /**
   * @custom Indica que dados sensíveis foram redigidos no HAR.
   */
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

/* ============================================================================
 * Agregado (txn)
 * ========================================================================== */
import type { CapTxn } from "../common/capture.types";

/* ============================================================================
 * Persistência de body
 * ========================================================================== */

/**
 * Descriptor do body salvo em disco.
 */
export type SavedBodyInfo = {
  /** Caminho absoluto do arquivo salvo. */
  path: string;
  /** Tamanho em bytes do arquivo salvo. */
  size: number;
  /** Content-Type reportado/assumido para o arquivo. */
  contentType?: string;
};

/* ============================================================================
 * Utils internos
 * ========================================================================== */

/**
 * Cria chave de correlação (method + url).
 */
function reqKey(method: string, url: string): string {
  return `${method} ${url}`;
}

/**
 * Decide se um body pode/vale a pena ser persistido,
 * respeitando os flags de configuração.
 */
function shouldPersistBody(contentType: string | undefined, size: number): boolean {
  if (!config.captureBodies) return false;
  if (size <= 0) return false;
  if (size > config.captureBodyMaxBytes) return false;

  const ct = (contentType || "").toLowerCase();
  const rx = new RegExp(config.captureBodyTypes);
  return rx.test(ct);
}

/**
 * Redige campos sensíveis em uma string (best-effort).
 * Evita vazar tokens/segredos em HAR legível.
 */
function redactText(input: string): string {
  if (!config.redactSecrets) return input;
  let out = input;

  // JSON keys comuns: password / token / secret / authorization / apiKey
  // NOTE: heurística propositalmente simples para não quebrar payloads.
  out = out.replace(/"password"\s*:\s*"([^"]+)"/gi, '"password":"***"');
  out = out.replace(/"pass"\s*:\s*"([^"]+)"/gi, '"pass":"***"');
  out = out.replace(/"token"\s*:\s*"([^"]+)"/gi, '"token":"***"');
  out = out.replace(/"secret"\s*:\s*"([^"]+)"/gi, '"secret":"***"');
  out = out.replace(/"apiKey"\s*:\s*"([^"]+)"/gi, '"apiKey":"***"');

  // Campos em formato x-www-form-urlencoded
  out = out.replace(/\b(password|pass|token|secret|apiKey)=([^&]+)/gi, (_m, k) => `${k}=***`);

  return out;
}

/**
 * Converte headers (Record) para pares do HAR.
 */
function toHarHeaders(h: Record<string, string> | undefined): HarHeader[] {
  return Object.entries(h ?? {}).map(([name, value]) => ({ name, value }));
}

/**
 * Retorna caminho relativo à base para exibir no HAR (ao invés de absoluto).
 */
function toRelative(baseDir: string, fullPath: string): string {
  try {
    return path.relative(baseDir, fullPath).replace(/\\/g, "/");
  } catch {
    return fullPath;
  }
}


/* ============================================================================
 * Classe principal
 * ========================================================================== */

/**
 * @class CaptureSession
 * @brief Sessão de gravação de artefatos de captura (HAR/NDJSON + bodies).
 */
export class CaptureSession {
  private baseDir: string;
  private harPath: string;
  private wsPath: string;
  private wsStream: fs.WriteStream;
  private har: HarFile;

  /** correlaciona última request por (method + url) */
  private lastReq: Map<string, RestReq> = new Map();

  /** bodies salvos correlacionados por (method + url) — sobrescreve o último */
  private savedBodies: Map<string, SavedBodyInfo> = new Map();

  /** subpasta onde os bodies ficam salvos (bodies-<timestamp>) */
  private bodiesDir: string;

  /** FD do arquivo NDJSON de txns; usar null como sentinela (evita undefined). */
  private ndjsonFd: number | null = null;

  /**
   * @constructor
   * Prepara diretórios e arquivos base da sessão.
   */
  constructor() {
    const t = timestamp();

    // Pasta base para artefatos
    this.baseDir = path.resolve(app.getAppPath(), "..", config.outputFolder);
    ensureDir(this.baseDir);

    // Subpasta para bodies
    this.bodiesDir = path.join(this.baseDir, `bodies-${t}`);
    ensureDir(this.bodiesDir);

    // Arquivos de saída
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

  /* ------------------------------------------------------------------------
   * NDJSON (CapTxn) — opcional
   * ---------------------------------------------------------------------- */

  /**
   * @method startNdjson
   * @brief Abre arquivo NDJSON para transações agregadas.
   */
  startNdjson(filePath: string): void {
    this.ndjsonFd = fs.openSync(filePath, "w");
  }

  /**
   * @method pushTxnNdjson
   * @brief Acrescenta uma transação agregada em linha NDJSON.
   */
  pushTxnNdjson(tx: CapTxn): void {
    const fd = this.ndjsonFd;
    if (fd == null) return;
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

  /* ------------------------------------------------------------------------
   * REST
   * ---------------------------------------------------------------------- */

  /**
   * @method onRestRequest
   * @brief Memoriza a última request por (method + url) para compor o HAR.
   */
  onRestRequest(d: RestReq): void {
    const key = reqKey(d.method, d.url);
    this.lastReq.set(key, d);
  }

  /**
   * @method saveBody
   * @brief Salva body bruto em arquivo e retorna o descriptor.
   */
  saveBody(idHint: string, buf: Uint8Array, contentType?: string): SavedBodyInfo {
    const safe = idHint.replace(/[^\w.-]+/g, "_").slice(0, 64);
    const fname = `${Date.now()}_${safe}.bin`;
    const full = path.join(this.bodiesDir, fname);
    fs.writeFileSync(full, Buffer.from(buf));

    // Não inclua contentType quando for undefined (por causa do exactOptionalPropertyTypes)
    const info: SavedBodyInfo = {
      path: full,
      size: buf.byteLength,
      ...(contentType ? { contentType } : {}),
    };
    return info;
  }

  /**
   * @method noteResponseBody
   * @brief Correlaciona um body previamente salvo ao par (method + url).
   *
   * @param method   Método HTTP.
   * @param url      URL exata da resposta.
   * @param info     Descriptor retornado por `saveBody`.
   *
   * @example
   *  const info = capSession.saveBody(url, bodyBytes, ct);
   *  capSession.noteResponseBody(method, url, info);
   */
  noteResponseBody(method: string, url: string, info: SavedBodyInfo): void {
    this.savedBodies.set(reqKey(method, url), info);
  }

  /**
   * @method onRestResponse
   * @brief Gera uma entry HAR a partir da response + última request correlata.
   *        Se houver `SavedBodyInfo` para esse (method+url), referencia o arquivo
   *        no campo customizado `content._file`.
   */
  onRestResponse(d: RestRes): void {
    const key = reqKey(d.method, d.url);
    const req = this.lastReq.get(key);

    // started/time 100% numérico (sem undefined)
    const startedTs: number = req?.ts !== undefined ? req.ts : (d.ts - d.timingMs);
    const totalTimeMs: number = d.timingMs;

    const requestHeaders: HarHeader[] = toHarHeaders(req?.reqHeaders);
    const responseHeaders: HarHeader[] = toHarHeaders(d.resHeaders);

    // Request body (apenas texto curto; redigido se ativado)
    const rawReqBody = req?.reqBody;
    const reqBodyText = rawReqBody ? redactText(rawReqBody) : undefined;

    const request: HarRequest = {
      method: d.method,
      url: d.url,
      httpVersion: "HTTP/2.0",
      headers: requestHeaders,
      headersSize: -1,
      bodySize: rawReqBody ? rawReqBody.length : 0,
      ...(reqBodyText
        ? {
          postData: {
            mimeType: (req?.reqHeaders["content-type"] ?? "text/plain"),
            text: reqBodyText,
          } as HarPostData,
        }
        : {}),
    };

    // Decide se há body salvo para esta resposta
    const saved = this.savedBodies.get(key);
    const ct = d.resHeaders["content-type"] ?? saved?.contentType ?? "";
    const canPersist = saved
      ? true
      : shouldPersistBody(ct, d.bodySize);

    // Monta content do HAR (referenciando arquivo quando houver)
    const content: HarContent = {
      size: d.bodySize,
      mimeType: ct,
      // por padrão, não colocamos texto do body no HAR para evitar explosão
      // de tamanho; o arquivo físico é referenciado em _file.
      text: "",
      ...(saved
        ? { _file: toRelative(this.baseDir, saved.path) }
        : {}),
    };

    const response: HarResponse = {
      status: d.status,
      statusText: d.statusText,
      httpVersion: "HTTP/2.0",
      headers: responseHeaders,
      headersSize: -1,
      bodySize: d.bodySize,
      content,
      ...(config.redactSecrets ? { _redacted: true } : {}),
    };

    // Se não havia arquivo salvo, mas a política permitir, criamos um *placeholder*.
    // OBS: salvar realmente os bytes deve ser feito onde você já tem `bodyBytes`.
    // Aqui apenas marcamos que "poderia" salvar (sem tocar no disco),
    // mantendo a implementação desacoplada.
    if (!saved && canPersist) {
      // Nada a fazer aqui por padrão; `saveBody` + `noteResponseBody` devem ser
      // chamados por quem possui os bytes (ex.: capture.ts).
      // Mantemos `content.text = ""` e sem `_file`.
    }

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

    // limpeza do correlacionamento (para evitar reaproveitar em outra resposta igual)
    this.lastReq.delete(key);
    this.savedBodies.delete(key);
  }

  /* ------------------------------------------------------------------------
   * WS → NDJSON
   * ---------------------------------------------------------------------- */
  /** @method onWsOpen */
  onWsOpen(d: WsOpen): void { writeJsonLine(this.wsStream, { type: "open", ...d }); }
  /** @method onWsMsg  */
  onWsMsg(d: WsMsg): void { writeJsonLine(this.wsStream, { type: "msg", ...d }); }
  /** @method onWsClose*/
  onWsClose(d: WsClose): void { writeJsonLine(this.wsStream, { type: "close", ...d }); }
  /** @method onWsError*/
  onWsError(d: WsError): void { writeJsonLine(this.wsStream, { type: "error", ...d }); }
}
