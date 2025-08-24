// src/common/capture.types.ts

export type HttpMethod = "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS";

export interface CapTiming {
  startTs: number;
  firstByteTs?: number;  // <- opcional p/ exactOptionalPropertyTypes
  endTs?: number;        // <- opcional
}

export interface CapReq {
  id: string;
  method: HttpMethod;
  url: string;
  host: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string,string>;
  bodyBytes?: Uint8Array;          // <- padroniza em Uint8Array
  bodyTextSnippet?: string;
  contentType?: string;
  timing: CapTiming;
}

export interface CapResp {
  id: string;
  status: number;
  statusText?: string;
  headers: Record<string,string>;
  bodyBytes?: Uint8Array;          // <- padroniza em Uint8Array
  bodyTextSnippet?: string;
  contentType?: string;
  sizeBytes?: number;
  timing: CapTiming;
  fromCache?: boolean;
}

export interface CapTxn {
  id: string;
  method: HttpMethod;
  host: string;
  path: string;
  routeKey: string;
  queryStr: string;
  req: CapReq;
  resp?: CapResp;
  durationMs?: number;
}
