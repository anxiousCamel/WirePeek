/**
 * @file src/main/capture.agg.ts
 * @brief Agregador de transações (req + resp) para o Inspector.
 *        - Mantém um índice por id e uma lista ordenada (para render).
 *        - Gera uma routeKey normalizada (host + pathname normalizado).
 *        - Calcula métricas (duration, TTFB, Receive).
 */

import type { CapTxn, CapReq, CapResp } from "../common/capture.types";

/** Tipo local para JWT (evita depender do export do módulo de tipos) */
type LocalCapJwtInfo = {
  token: string;
  decoded: { header?: unknown; payload?: unknown };
};

/** Cache em memória das transações desta sessão */
const txIndex = new Map<string, CapTxn>();
const ordered: CapTxn[] = []; // mantém ordem de chegada (para o Inspector)

/** Reset do agregador (quando iniciar/terminar uma sessão) */
export function resetAgg(): void {
  txIndex.clear();
  ordered.length = 0;
}

/**
 * Normaliza o pathname para agrupar rotas semelhantes (com ids/uuids/datas).
 * Mantém o host para não colapsar sites diferentes.
 */
export function computeRouteKey(path: string): string {
  // UUID v4
  path = path.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    ":uuid"
  );
  // números longos
  path = path.replace(/\b\d{8,}\b/g, ":long");
  // inteiros curtos
  path = path.replace(/\b\d+\b/g, ":id");
  // datas ISO
  path = path.replace(
    /\b\d{4}-\d{2}-\d{2}(?:[tT ][\d:.-]+Z?)?\b/g,
    ":date"
  );
  return path;
}

/**
 * @brief onReq: cria a transação parcial e indexa.
 * A routeKey inclui o host para diferenciar domínios.
 */
export function onReq(req: CapReq): CapTxn {
  const url = new URL(req.url);
  let routeKey = `${url.host}${computeRouteKey(url.pathname)}`;

  // Se for GraphQL, tenta extrair operationName do body (quando texto)
  try {
    const mime = req.headers?.["content-type"] || "";
    if (/graphql|json/i.test(mime) && req.bodyBytes) {
      const txt = new TextDecoder().decode(req.bodyBytes);
      // aceita {"operationName": "..."} ou {"extensions":{"persistedQuery":{...}}}
      const mOp = txt.match(/"operationName"\s*:\s*"([^"]+)"/);
      if (mOp?.[1]) routeKey += `#${mOp[1]}`;
      else {
        const mHash = txt.match(/"sha256Hash"\s*:\s*"([0-9a-f]{16,})"/i);
        if (mHash?.[1]) routeKey += `#persisted:${mHash[1].slice(0, 8)}`;
      }
    }
  } catch {
    /* noop */
  }

  const txn: CapTxn = {
    id: req.id,
    method: req.method,
    host: url.host,
    path: url.pathname,
    routeKey,
    queryStr: url.search.slice(1),
    req,
  };
  txIndex.set(req.id, txn);
  ordered.push(txn);
  return txn;
}

/**
 * @brief Aplica (de forma tolerante) um patch de JWT ao CapReq depois que a transação foi criada.
 * @param id  ID da transação (igual ao id da request)
 * @param jwt Objeto de info de JWT (token redigido + decodificado)
 *
 * Observação: usamos type-cast para não depender do CapReq.jwt estar
 * “visível” no ambiente do compilador (evita erro TS2339).
 */
export function patchReqJwt(id: string, jwt: LocalCapJwtInfo): void {
  const txn = txIndex.get(id);
  if (!txn) return;
  (txn.req as CapReq & { jwt?: LocalCapJwtInfo }).jwt = jwt;
}

/**
 * @brief onResp: completa a transação com a resposta e calcula métricas.
 */
export function onResp(resp: CapResp): CapTxn | undefined {
  const txn = txIndex.get(resp.id);
  if (!txn) return undefined;

  txn.resp = resp;

  const t0 = txn.req.timing.startTs;
  const tEnd = resp.timing.endTs;
  const tFB = resp.timing.firstByteTs;

  if (tEnd) {
    const total = Math.max(0, tEnd - t0);
    txn.durationMs = total;

    if (tFB) {
      const tfb = Math.max(0, tFB - t0);
      // Type-cast local caso o CapTxn ainda não “exponha” esses campos no ambiente
      (txn as CapTxn & { ttfbMs?: number; receiveMs?: number }).ttfbMs = tfb;
      (txn as CapTxn & { ttfbMs?: number; receiveMs?: number }).receiveMs = Math.max(0, total - tfb);
    }
  }
  return txn;
}

/** Lista ordenada para o Inspector */
export function getOrderedTx(): ReadonlyArray<CapTxn> {
  return ordered;
}
