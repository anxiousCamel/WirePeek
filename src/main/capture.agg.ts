import { CapTxn, CapReq, CapResp } from "../common/capture.types";

/** Cache em memória das transações desta sessão (otimização) */
const txIndex = new Map<string, CapTxn>();
const ordered: CapTxn[] = []; // mantém ordem de chegada (para inspetor)

export function resetAgg(): void {
  txIndex.clear(); ordered.length = 0;
}

/** Normaliza path para um "routeKey" útil pra agrupar rotas. */
export function computeRouteKey(path: string): string {
  // UUID v4
  path = path.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ":uuid");
  // números longos
  path = path.replace(/\b\d{8,}\b/g, ":long");
  // inteiros curtos
  path = path.replace(/\b\d+\b/g, ":id");
  // datas ISO
  path = path.replace(/\b\d{4}-\d{2}-\d{2}(?:[tT ][\d:.-]+Z?)?\b/g, ":date");
  return path;
}

export function onReq(req: CapReq): CapTxn {
  const url = new URL(req.url);
  const routeKey = computeRouteKey(url.pathname);
  const txn: CapTxn = {
    id: req.id,
    method: req.method,
    host: url.host,
    path: url.pathname,
    routeKey,
    queryStr: url.search.slice(1),
    req
  };
  txIndex.set(req.id, txn);
  ordered.push(txn);
  return txn;
}

export function onResp(resp: CapResp): CapTxn | undefined {
  const txn = txIndex.get(resp.id);
  if (!txn) return undefined;
  txn.resp = resp;
  if (resp.timing.endTs && txn.req.timing.startTs) {
    txn.durationMs = Math.max(0, resp.timing.endTs - txn.req.timing.startTs);
  }
  return txn;
}

/** Acesso para o inspetor renderizar em lista */
export function getOrderedTx(): ReadonlyArray<CapTxn> { return ordered; }
