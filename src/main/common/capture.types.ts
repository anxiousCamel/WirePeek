/**
 * @file src/common/capture.types.ts
 * @brief Tipos compartilhados entre main / preload / inspector para captura e agregação.
 */

/**
 * @typedef {"GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS"} HttpMethod
 */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/**
 * @typedef CapTiming
 * @brief Marcações temporais da transação.
 * @property {number} startTs       Epoch ms do início da request
 * @property {number} [firstByteTs] Epoch ms do 1º byte recebido (quando disponível)
 * @property {number} [endTs]       Epoch ms do término da response
 */
export interface CapTiming {
  startTs: number;
  firstByteTs?: number;
  endTs?: number;
}

/**
 * @typedef HeaderMap
 * @brief Mapa simples de cabeçalhos normalizados (chaves minúsculas).
 */
export type HeaderMap = Record<string, string>;

/**
 * @typedef CapReqCors
 * @brief Metadados CORS ligados à *request* (lado de saída).
 * @property {boolean} preflight  true se correlacionada a um preflight recente
 * @property {string}  [origin]   Origin visto no preflight (quando presente)
 */
export interface CapReqCors {
  preflight: boolean;
  origin?: string;
}

/**
 * @typedef CapCorsAllow
 * @brief Conjunto dos cabeçalhos *Access-Control-Allow-** da *response*.
 * @property {string}  [origin]       Valor de Access-Control-Allow-Origin
 * @property {string}  [methods]      Valor de Access-Control-Allow-Methods
 * @property {string}  [headers]      Valor de Access-Control-Allow-Headers
 * @property {boolean} [credentials]  true se Access-Control-Allow-Credentials="true"
 */
export interface CapCorsAllow {
  origin?: string;
  methods?: string;
  headers?: string;
  credentials?: boolean;
}

/**
 * @typedef CapCookieSet
 * @brief Representa um cookie vindo de `Set-Cookie` na resposta HTTP.
 * @property {string} name   Nome do cookie
 * @property {string} value  Valor do cookie (pode ser redigido conforme política)
 * @property {Record<string,string|boolean>} flags  Atributos (Max-Age, Path, Secure, HttpOnly, SameSite etc.)
 */
export interface CapCookieSet {
  name: string;
  value: string;
  flags: Record<string, string | boolean>;
}

/**
 * @typedef CapJwtDecoded
 * @brief Estrutura decodificada (header/payload) de um JWT.
 * Os campos são `unknown` para não acoplar ao formato do app.
 * @property {unknown} [header]
 * @property {unknown} [payload]
 */
export interface CapJwtDecoded {
  header?: unknown;
  payload?: unknown;
}

/**
 * @typedef CapJwtInfo
 * @brief Informações de um JWT detectado (redigido + decodificado).
 * @property {string} token            Token redigido (ex.: "ey...<redacted:XXb>")
 * @property {CapJwtDecoded} decoded   Partes decodificadas (header/payload)
 */
export interface CapJwtInfo {
  token: string;
  decoded: CapJwtDecoded;
}

/**
 * @typedef CapReq
 * @brief Request capturada (lado de saída).
 * @property {string} id                 ID interno correlacionando req/resp (ex.: d.id do Electron em string)
 * @property {HttpMethod} method         Método HTTP normalizado
 * @property {string} url                URL completa
 * @property {string} host               host:porta (ex.: "example.com:443")
 * @property {string} path               Apenas o pathname (ex.: "/api/v1/users/123")
 * @property {Record<string,string>} query Query string já parseada (simples; evolui se precisar arrays)
 * @property {HeaderMap} headers         Cabeçalhos “seguros” (sem cookies/authorization — ver filtro no capture)
 * @property {CapTiming} timing          Marcações de tempo (start sempre preenchido)
 * @property {Uint8Array} [bodyBytes]    Corpo bruto quando capturado (opcional)
 * @property {string} [bodyTextSnippet]  Trecho UTF-8 para visualização rápida (opcional)
 * @property {CapReqCors} [cors]         Metadados CORS (preflight correlacionado, origin)
 * @property {CapJwtInfo} [jwt]          JWT detectado em Authorization (Bearer) ou corpo
 */
export interface CapReq {
  id: string;
  method: HttpMethod;
  url: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: HeaderMap;
  timing: CapTiming;

  bodyBytes?: Uint8Array;
  bodyTextSnippet?: string;

  cors?: CapReqCors;
  jwt?: CapJwtInfo;
}

/**
 * @typedef CapResp
 * @brief Response capturada (lado de entrada).
 * @property {string} id                 Mesmo id da request correspondente
 * @property {number} status             Código HTTP (ex.: 200, 404, 500)
 * @property {string} [statusText]       Texto de status (ex.: "OK")
 * @property {HeaderMap} headers         Cabeçalhos normalizados
 * @property {string} [contentType]      Content-Type detectado (ex.: "application/json; charset=utf-8")
 * @property {number} [sizeBytes]        Tamanho do corpo em bytes (após decodificar gzip/br), quando conhecido
 * @property {Uint8Array} [bodyBytes]    Corpo bruto quando capturado (opcional)
 * @property {string} [bodyTextSnippet]  Trecho UTF-8 para visualização rápida (opcional)
 * @property {CapTiming} timing          Marcações de tempo (start, firstByte, end)
 * @property {boolean} [fromCache]       Indica se veio do cache (quando fornecido pelo Electron)
 * @property {string} [bodyFile]         Caminho absoluto do arquivo em disco (quando persistido)
 * @property {CapCorsAllow} [corsAllow]  Cabeçalhos Access-Control-Allow-* destacados
 * @property {CapCookieSet[]} [setCookies] Cookies definidos via Set-Cookie
 * @property {CapJwtInfo} [jwt]          JWT detectado na resposta (ex.: body JSON ou Set-Cookie)
 */
export interface CapResp {
  id: string;
  status: number;
  statusText?: string;
  headers: HeaderMap;
  contentType?: string;
  sizeBytes?: number;

  bodyBytes?: Uint8Array;
  bodyTextSnippet?: string;

  timing: CapTiming;
  fromCache?: boolean;

  bodyFile?: string;
  corsAllow?: CapCorsAllow;
  setCookies?: CapCookieSet[];
  jwt?: CapJwtInfo;
}

/**
 * @typedef CapTxn
 * @brief Transação agregada mostrada no Inspector (req + resp + metadados).
 * @property {string} id                 Mesmo id compartilhado entre req/resp
 * @property {HttpMethod} method         Método HTTP
 * @property {string} host               Host de destino
 * @property {string} path               Path original (sem normalização)
 * @property {string} routeKey           Chave p/ agrupar rotas semelhantes (ex.: host + pathname normalizado)
 * @property {string} [queryStr]         Query string crua (sem ‘?’), se desejar exibir
 * @property {CapReq} req                Request completa
 * @property {CapResp} [resp]            Response (se já recebida)
 * @property {number} [durationMs]       Duração total (endTs - startTs)
 * @property {number} [ttfbMs]           Time To First Byte (firstByteTs - startTs)
 * @property {number} [receiveMs]        Tempo de recebimento (durationMs - ttfbMs)
 */
export interface CapTxn {
  id: string;
  method: HttpMethod;
  host: string;
  path: string;
  routeKey: string;
  queryStr?: string;

  req: CapReq;
  resp?: CapResp;

  durationMs?: number;
  ttfbMs?: number;
  receiveMs?: number;
}
