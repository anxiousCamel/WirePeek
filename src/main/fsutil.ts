/**
 * @file src/main/fsutil.ts
 * @brief Utilitários para detecção, decodificação e redação de JWT (Base64URL).
 */

/**
 * @brief Tenta encontrar um JWT (3 partes base64url) dentro de uma string.
 * @param s Texto onde procurar (ex.: Authorization, cookie, body etc.)
 * @returns O token encontrado, se houver, senão null.
 */
export function findJwtInString(s: string): string | null {
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
  const [h, p] = token.split(".");
  const header = h ? decodeBase64Url(h) : null;
  const payload = p ? decodeBase64Url(p) : null;
  return { header, payload };
}

/**
 * @brief Redige a assinatura de um JWT, preservando header.payload.
 * @param token JWT completo
 * @returns Token com assinatura redigida e comprimento anotado
 */
export function redactJwt(token: string): string {
  const [h, p, s] = token.split(".");
  return `${h ?? ""}.${p ?? ""}.<redacted:${s?.length ?? 0}b>`;
}

/**
 * @brief Busca possíveis JWT em objetos JSON.
 * @param data Qualquer JSON (obj/array/string...)
 * @returns Primeiro token encontrado (string) ou null
function findJwtInJson(data: unknown): string | null {
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
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (keysLiked.has(k)) {
          if (typeof v === "string") {
            const hit = findJwtInString(v);
            if (hit) return hit;
          }
        }
        const deep = findJwtInJson(v);
        if (deep) return deep;
      }
    }
  } catch {
  }
  return null;
}
*/
