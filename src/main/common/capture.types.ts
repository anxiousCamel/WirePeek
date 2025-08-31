// src/common/capture.types.ts
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
 * @property {string} [bodyFile]         **NOVO**: caminho absoluto do arquivo em disco (quando persistido)
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

    // Quando onCompleted decidir persistir o corpo em disco (opt-in + políticas),
    // este campo carrega o caminho para carregamento sob demanda no Inspector.
    bodyFile?: string;
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
 * @property {number} [durationMs]       Duração total em ms (resp.endTs - req.startTs), quando disponível
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
}
