/**
 * @file src/main/config.ts
 * @brief Carrega variáveis de ambiente (.env) e expõe a configuração tipada do app.
 *
 * @details
 *  As variáveis abaixo podem ser definidas no ambiente ou em um arquivo `.env`
 *  na raiz do projeto. Quando ausentes, os valores padrão (indicados em cada
 *  item) são aplicados.
 *
 *  Variáveis suportadas:
 *   - TARGET_URL                : URL inicial aberta no webview.
 *   - OUTPUT_FOLDER             : Pasta onde artefatos (HAR, bodies, etc.) são salvos.
 *   - USER_AGENT                : User-Agent customizado; vazio => usar padrão do Electron.
 *   - WIN_WIDTH / WIN_HEIGHT    : Tamanho inicial da janela principal.
 *   - REDACT_SECRETS            : "1" (padrão) para mascarar segredos ao persistir/mostrar.
 *   - CAPTURE_BODIES            : "true" para gravar bodies de resposta (opt-in).
 *   - CAPTURE_BODY_MAX_BYTES    : Limite (bytes) para persistência do body (padrão 1 MiB).
 *   - CAPTURE_BODY_TYPES        : Regex para filtrar Content-Types aceitos na persistência.
 *   - ENABLE_CDP                : "true" para ligar CDP (initiator/redirects/etc.).
 *
 * @example
 *  # .env
 *  TARGET_URL=https://example.com
 *  OUTPUT_FOLDER=out
 *  USER_AGENT="WirePeek/1.0 (+Electron)"
 *  WIN_WIDTH=1440
 *  WIN_HEIGHT=900
 *  REDACT_SECRETS=1
 *  CAPTURE_BODIES=true
 *  CAPTURE_BODY_MAX_BYTES=524288
 *  CAPTURE_BODY_TYPES=^(application/json|text/)
 *  ENABLE_CDP=true
 */

import dotenv from "dotenv";
dotenv.config();

/**
 * Converte uma string de ambiente em número inteiro com fallback.
 * @param s Valor vindo do ambiente.
 * @param def Valor padrão caso `s` esteja ausente ou inválido.
 */
function envInt(s: string | undefined, def: number): number {
  const n = Number.parseInt(String(s ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * Converte uma string de ambiente em booleano com fallback.
 * @param s Valor vindo do ambiente.
 * @param def Valor padrão.
 * @note Valores "true"/"1" => true, "false"/"0" => false; outros => `def`.
 */
function envBool(s: string | undefined, def: boolean): boolean {
  if (s == null) return def;
  const v = s.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return def;
}

/**
 * Retorna string não vazia, ou `null` quando vazia/indefinida.
 */
function strOrNull(s: string | undefined): string | null {
  const v = (s ?? "").trim();
  return v.length ? v : null;
}

/**
 * @interface AppConfig
 * @brief Estrutura tipada da configuração global do aplicativo.
 */
export interface AppConfig {
  /**
   * URL inicial carregada no webview.
   * @env  TARGET_URL
   * @default https://www.startpage.com/… (link longo preservado do projeto)
   */
  targetUrl: string;

  /**
   * Pasta base onde artefatos são gravados (HAR, bodies, etc.).
   * @env  OUTPUT_FOLDER
   * @default "out"
   */
  outputFolder: string;

  /**
   * User-Agent customizado. Quando `null`, o Electron usa o UA padrão.
   * @env  USER_AGENT
   * @default null
   */
  userAgent: string | null;

  /**
   * Largura inicial da janela principal (px).
   * @env  WIN_WIDTH
   * @default 1366
   */
  winWidth: number;

  /**
   * Altura inicial da janela principal (px).
   * @env  WIN_HEIGHT
   * @default 768
   */
  winHeight: number;

  /**
   * Quando habilitado, valores sensíveis (ex.: Authorization, cookies, tokens)
   * são mascarados ao exportar/exibir.
   * @env  REDACT_SECRETS
   * @default true (qualquer valor diferente de "0" habilita)
   */
  redactSecrets: boolean;

  /**
   * Habilita a persistência de corpos de resposta (opt-in).
   * @env  CAPTURE_BODIES
   * @default false
   */
  captureBodies: boolean;

  /**
   * Limite de tamanho (em bytes) para salvar o body.
   * Respostas maiores que este valor não são persistidas.
   * @env  CAPTURE_BODY_MAX_BYTES
   * @default 1048576 (1 MiB)
   */
  captureBodyMaxBytes: number;

  /**
   * Expressão regular (string) aplicada ao Content-Type da resposta
   * para decidir se o body pode ser salvo (ex.: `^(application/json|text/)`).
   * @env  CAPTURE_BODY_TYPES
   * @default "^(application/json|text/)"
   */
  captureBodyTypes: string;

  /**
   * Liga o Chrome DevTools Protocol (CDP) para enriquecer os eventos:
   * initiator, cadeia de redirects, etc.
   * @env  ENABLE_CDP
   * @default true
   */
  enableCdp: boolean;
}

/**
 * @brief Configuração resolvida a partir do ambiente + padrões.
 */
export const config: AppConfig = {
  targetUrl:
    process.env.TARGET_URL ||
    "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2",
  outputFolder: process.env.OUTPUT_FOLDER || "out",
  userAgent: strOrNull(process.env.USER_AGENT),
  winWidth: envInt(process.env.WIN_WIDTH, 1366),
  winHeight: envInt(process.env.WIN_HEIGHT, 768),
  redactSecrets: (process.env.REDACT_SECRETS ?? "1") !== "0",
  captureBodies: envBool(process.env.CAPTURE_BODIES, false),
  captureBodyMaxBytes: envInt(process.env.CAPTURE_BODY_MAX_BYTES, 1048576),
  captureBodyTypes: process.env.CAPTURE_BODY_TYPES || "^(application/json|text/)",
  enableCdp: envBool(process.env.ENABLE_CDP, true),
};
