// src/common/capture.types.ts
/**
 * Tipos compartilhados entre main/preload/inspector
 * para a captura e agregação de requisições/respostas.
 */

export type HttpMethod =
    | "GET"
    | "POST"
    | "PUT"
    | "PATCH"
    | "DELETE"
    | "HEAD"
    | "OPTIONS";

/** Marcação temporal da transação */
export interface CapTiming {
    /** Timestamp (ms) quando a request começou */
    startTs: number;
    /** Primeiro byte recebido (ms), se disponível */
    firstByteTs?: number;
    /** Timestamp (ms) quando a response terminou */
    endTs?: number;
}

/** Mapa simples de cabeçalhos normalizados (minúsculos) */
export type HeaderMap = Record<string, string>;

/** Request capturada (lado de saída) */
export interface CapReq {
    /** ID interno correlacionando req/resp (usa d.id do Electron convertido p/ string) */
    id: string;
    /** Método HTTP normalizado */
    method: HttpMethod;
    /** URL completa */
    url: string;
    /** host:porta (ex.: example.com:443) */
    host: string;
    /** apenas o pathname (ex.: /api/v1/users/123) */
    path: string;
    /** query string já parseada (use simples; se precisar array, evoluímos depois) */
    query: Record<string, string>;
    /** Cabeçalhos “seguros” (sem cookies/authorization, etc. — ver filtro no capture.ts) */
    headers: HeaderMap;
    /** Marcações de tempo (start é sempre preenchido) */
    timing: CapTiming;

    /** Corpo (bytes) quando capturado, opcional */
    bodyBytes?: Uint8Array;
    /** Trecho em texto do body (cortado), opcional e apenas para visualização rápida */
    bodyTextSnippet?: string;
}

/** Response capturada (lado de entrada) */
export interface CapResp {
    /** Mesmo id da request correspondente */
    id: string;
    /** Código HTTP (ex.: 200, 404, 500) */
    status: number;
    /** Texto de status se disponível (ex.: "OK") */
    statusText?: string;
    /** Cabeçalhos normalizados */
    headers: HeaderMap;
    /** Content-Type detectado */
    contentType?: string;
    /** Tamanho do corpo em bytes (depois de decodificar gzip/br), quando conhecido */
    sizeBytes?: number;

    /** Corpo (bytes) quando capturado, opcional */
    bodyBytes?: Uint8Array;
    /** Trecho em texto do body (cortado), opcional e apenas para visualização rápida */
    bodyTextSnippet?: string;

    /** Marcações de tempo (start, firstByte, end) */
    timing: CapTiming;

    /** Indica se veio do cache (quando fornecido pelo Electron) */
    fromCache?: boolean;
}

/** Transação agregada mostrada no Inspector (req + resp + metadados) */
export interface CapTxn {
    /** Mesmo id compartilhado entre req/resp */
    id: string;
    /** Método HTTP */
    method: HttpMethod;
    /** Host de destino */
    host: string;
    /** Path original (sem normalização) */
    path: string;
    /**
     * Chave de agrupamento (ex.: host + pathname normalizado via computeRouteKey)
     * usada para “juntar” rotas semelhantes sem perder o domínio.
     */
    routeKey: string;
    /** Query string crua (sem ‘?’), se você quiser exibir */
    queryStr?: string;

    /** Request completa */
    req: CapReq;
    /** Response (se já recebida) */
    resp?: CapResp;

    /** Duração total em ms (resp.endTs - req.startTs), quando disponível */
    durationMs?: number;
}
