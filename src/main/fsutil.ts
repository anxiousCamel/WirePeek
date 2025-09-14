/**
 * @file src/main/fsutil.ts
 * @brief Utilitários gerais para:
 *   - Detecção/decodificação/redação de JWT (Base64URL)
 *   - Operações de arquivo usadas pela captura (ensureDir, openAppendStream, writeJsonLine)
 *   - Geração de timestamp seguro para nomes de arquivo/pasta
 *
 * Observações:
 * - Este arquivo roda no processo "main" do Electron.
 * - Exporte apenas funções/valores serializáveis (nada de objetos complexos via IPC).
 */

import { promises as fsp } from "fs";
import { createWriteStream, WriteStream } from "fs";
import * as path from "path";

/* =======================================================================================
 *                               JWT / BASE64URL UTILITIES
 * =======================================================================================
 */

/**
 * @brief Tenta encontrar um JWT (3 partes base64url) dentro de uma string.
 * @param s Texto onde procurar (ex.: Authorization, cookie, body etc.)
 * @returns O token encontrado, se houver, senão null.
 */
export function findJwtInString(s: string): string | null {
  if (!s) return null;
  const m = s.match(/ey[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

/**
 * @brief Decodifica Base64URL em JSON.
 * @param s String em Base64URL
 * @returns Objeto JSON parseado ou null se falhar
 */
export function decodeBase64Url<T = unknown>(s: string): T | null {
  try {
    const pad = s.length % 4 ? s + "=".repeat(4 - (s.length % 4)) : s;
    const b64 = pad.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * @brief Decodifica um JWT em { header, payload } (ambos podem ser null).
 * @param token JWT completo (header.payload.signature)
 */
export function decodeJwt(token: string): { header: unknown | null; payload: unknown | null } {
  if (!token) return { header: null, payload: null };
  const [h, p] = token.split(".");
  const header = h ? decodeBase64Url(h) : null;
  const payload = p ? decodeBase64Url(p) : null;
  return { header, payload };
}

/**
 * @brief Redige a assinatura de um JWT, preservando header.payload.
 * @param token JWT completo
 * @returns Token com assinatura redigida e comprimento anotado
 *
 * Ex.: "aaa.bbb.cccccc" → "aaa.bbb.<redacted:6b>"
 */
export function redactJwt(token: string): string {
  const [h, p, s] = token.split(".");
  return `${h ?? ""}.${p ?? ""}.<redacted:${s?.length ?? 0}b>`;
}

/**
 * @brief Busca recursivamente possíveis JWT em um JSON (objeto/array/string).
 * @param data Qualquer JSON (obj/array/string...)
 * @returns Primeiro token encontrado (string) ou null
 */
export function findJwtInJson(data: unknown): string | null {
  const keysLiked = new Set([
    "access_token",
    "id_token",
    "token",
    "jwt",
    "accessToken",
    "idToken",
  ]);

  try {
    if (typeof data === "string") return findJwtInString(data);

    if (Array.isArray(data)) {
      for (const it of data) {
        const hit = findJwtInJson(it);
        if (hit) return hit;
      }
      return null;
    }

    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;

      for (const k of Object.keys(obj)) {
        if (keysLiked.has(k)) {
          const v = obj[k];
          if (typeof v === "string") {
            const hit = findJwtInString(v);
            if (hit) return hit;
          }
        }
      }

      for (const [, v] of Object.entries(obj)) {
        const deep = findJwtInJson(v);
        if (deep) return deep;
      }
    }
  } catch {
    // noop — best-effort
  }
  return null;
}

/* =======================================================================================
 *                           FILE / STREAM UTILITIES (CAPTURA)
 * =======================================================================================
 */

/**
 * @brief Garante que um diretório exista (recursivo).
 * @param dir Caminho do diretório
 */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/**
 * @brief Gera um timestamp seguro para nomes de arquivo/pasta.
 * @param d Data (opcional; default = agora)
 * @returns String no formato "yyyy-mm-dd_hh-mm-ss"
 */
export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * @brief Abre um WriteStream em modo append, garantindo o diretório.
 * @param filePath Caminho do arquivo de saída
 * @returns WriteStream aberto em modo append
 */
export function openAppendStream(filePath: string): WriteStream {
  // garantir diretório (best-effort, sem bloquear retorno)
  fsp.mkdir(path.dirname(filePath), { recursive: true }).catch(() => {});
  return createWriteStream(filePath, { flags: "a" });
}

/**
 * @brief Escreve uma linha NDJSON (JSON + "\n") em um WriteStream.
 * @param ws WriteStream aberto
 * @param obj Objeto a serializar (deve ser JSON-serializável)
 */
export async function writeJsonLine(ws: WriteStream, obj: unknown): Promise<void> {
  let line: string;
  try {
    line = JSON.stringify(obj) + "\n";
  } catch {
    line = JSON.stringify({ _error: "Non-serializable object" }) + "\n";
  }
  await new Promise<void>((resolve, reject) => {
    ws.write(line, (err) => (err ? reject(err) : resolve()));
  });
}
