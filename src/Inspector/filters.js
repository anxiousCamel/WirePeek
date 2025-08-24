/**
 * Sintaxe:  method:GET status:2xx host:api.meu.com took>500 path:/v1/* has:auth
 * Campos: method, status (2xx/3xx/4xx/5xx ou num exato), host, path (glob simples), took (ms), size (bytes), has (auth|cookie|json)
 */
export function match(tx, q){
  if(!q) return true;
  const parts = q.trim().split(/\s+/);
  for(const p of parts){
    if(/^method:/i.test(p)){
      const m = p.split(":")[1]?.toUpperCase(); if (tx.method !== m) return false;
    } else if(/^status:/i.test(p)){
      const s = p.split(":")[1];
      if (/^\dxx$/.test(s)) {
        const cl = parseInt(s[0],10); if (!tx.resp?.status || Math.floor(tx.resp.status/100)!==cl) return false;
      } else if (/^\d+$/.test(s)) {
        if (tx.resp?.status !== parseInt(s,10)) return false;
      }
    } else if(/^host:/i.test(p)){
      const h = p.split(":")[1]; if (!tx.host.includes(h)) return false;
    } else if(/^path:/i.test(p)){
      const g = p.split(":")[1].replace(/\*/g,".*"); if (!new RegExp("^"+g+"$").test(tx.path)) return false;
    } else if(/^took[><]=?/i.test(p)){
      const [,op,num] = p.match(/^took(>=|<=|>|<)(\d+)$/i)||[]; if (!num) continue;
      const n = parseInt(num,10), d = tx.durationMs ?? 0;
      if (op === ">" && !(d>n)) return false;
      if (op === ">=" && !(d>=n)) return false;
      if (op === "<" && !(d<n)) return false;
      if (op === "<=" && !(d<=n)) return false;
    } else if(/^size[><]=?/i.test(p)){
      const [,op,num] = p.match(/^size(>=|<=|>|<)(\d+)$/i)||[]; if (!num) continue;
      const n = parseInt(num,10), s = tx.resp?.sizeBytes ?? 0;
      if (op === ">" && !(s>n)) return false;
      if (op === ">=" && !(s>=n)) return false;
      if (op === "<" && !(s<n)) return false;
      if (op === "<=" && !(s<=n)) return false;
    } else if(/^has:/i.test(p)){
      const k = p.split(":")[1];
      if (k==="auth" && !/authorization/i.test(JSON.stringify(tx.req.headers||{}))) return false;
      if (k==="cookie" && !/cookie/i.test(JSON.stringify(tx.req.headers||{}))) return false;
      if (k==="json" && !/application\/json/i.test(tx.req.contentType||tx.resp?.contentType||"")) return false;
    }
  }
  return true;
}
