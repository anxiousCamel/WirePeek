/**
 * @file src/main/fsutil.ts
 * @brief Utilitários de arquivo/tempo e gravação NDJSON.
 */
import fs from "fs";
import path from "path";

/** Garante pasta existente. */
export function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/** Timestamp seguro para nomes. */
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Cria um WriteStream de append. */
export function openAppendStream(filePath: string): fs.WriteStream {
  ensureDir(path.dirname(filePath));
  return fs.createWriteStream(filePath, { flags: "a", encoding: "utf8" });
}

/** Escreve uma linha JSON no stream. */
export function writeJsonLine(stream: fs.WriteStream, obj: unknown): void {
  stream.write(JSON.stringify(obj) + "\n");
}
