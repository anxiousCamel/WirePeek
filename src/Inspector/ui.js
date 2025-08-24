/* eslint-env browser */
/**
 * @file Inspector/ui.js
 * - Controles de janela custom (via window.win)
 * - Lista de logs com auto-scroll inteligente
 * - Recebe eventos via window.wirepeek.onCapEvent (cap-event do main)
 */

// ===== Janela =====
document.getElementById("win-close")?.addEventListener("click", () => window.win?.close());
document.getElementById("win-max")?.addEventListener("click", async () => {
  await window.win?.toggleMaximize();
});

// ===== Logs & Auto-scroll =====
const scroller = document.getElementById("scroller"); // <main id="scroller">
const loglist  = document.getElementById("loglist");  // <ul id="loglist">

let stickToBottom = true;         // se true, mantém preso ao fim
const BOTTOM_THRESHOLD = 8;       // px de tolerância

function isNearBottom(el) {
  return el.scrollTop >= (el.scrollHeight - el.clientHeight - BOTTOM_THRESHOLD);
}

scroller?.addEventListener("scroll", () => {
  // se o usuário rolou pra cima, desativa "prender no fundo"
  stickToBottom = isNearBottom(scroller);
});

// buffer para inserir em lote (performance)
let buf = document.createDocumentFragment();
let flushScheduled = false;

/** Cria e enfileira uma linha de log. */
function appendLogRow({ cls = "restrequest", text = "" }) {
  const li = document.createElement("li");
  li.className = cls;
  li.textContent = text;
  buf.appendChild(li);
  scheduleFlush();
}

/** Aplica o buffer e, se estiver no fim, mantém scroll no fim. */
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  const shouldStick = stickToBottom && isNearBottom(scroller);
  requestAnimationFrame(() => {
    loglist.appendChild(buf);
    flushScheduled = false;
    if (shouldStick) scroller.scrollTop = scroller.scrollHeight;
  });
}

/** Recebe envelopes do main (cap-event) e adiciona linhas. */
window.wirepeek?.onCapEvent?.(({ channel, payload }) => {
  const cls  = String(channel || "").replaceAll(":", "-");
  const text = (payload && payload.summary) ? String(payload.summary) : String(channel);
  appendLogRow({ cls, text });
});

// ===== Filtro & Limpar =====
document.getElementById("btn-clear")?.addEventListener("click", () => {
  loglist.textContent = "";
});

// ===== Estado no título =====
window.wirepeek?.onState?.((s) => {
  document.title = s.capturing ? "WirePeek Inspector • Capturando" : "WirePeek Inspector";
});
// refs
const tbody   = document.getElementById("tx-body");
const details = document.getElementById("details");
const detTitle= document.getElementById("det-title");
const tabReq  = document.getElementById("tab-req");
const tabResp = document.getElementById("tab-resp");
const tabCurl = document.getElementById("tab-curl");

function fmtTime(ts){ const d=new Date(ts); return d.toLocaleTimeString(); }
function fmtBytes(n){ if(!n && n!==0) return ""; const u=["B","KB","MB","GB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++;} return `${n.toFixed(1)} ${u[i]}`; }
function statusClass(s){ if(s>=500) return "status-5xx"; if(s>=400) return "status-4xx"; return "status-2xx"; }

/** Gera cURL para replay rápido (útil p/ automação) */
function buildCurl(tx){
  const h = Object.entries(tx.req.headers||{})
    // evita vazar cookies/authorization por padrão
    .filter(([k]) => !/^cookie$|^authorization$/i.test(k))
    .map(([k,v])=>`-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" ");
  const data = tx.req.bodyBytes ? `--data-raw ${JSON.stringify(new TextDecoder().decode(tx.req.bodyBytes))}` : "";
  return `curl -i -X ${tx.method} ${h} ${data} ${JSON.stringify(tx.req.url)}`;
}

/** Abre painel com detalhes formatados */
function openDetails(tx){
  detTitle.textContent = `${tx.method} ${tx.path} • ${tx.resp?.status ?? "-"} • ${tx.durationMs ?? "-"}ms`;
  tabReq.textContent  = JSON.stringify({ url: tx.req.url, headers: tx.req.headers, body: tx.req.bodyTextSnippet }, null, 2);
  tabResp.textContent = JSON.stringify({ status: tx.resp?.status, headers: tx.resp?.headers, body: tx.resp?.bodyTextSnippet }, null, 2);
  tabCurl.textContent = buildCurl(tx);
  details.classList.remove("hidden");
}

function appendTxnRow(tx){
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${fmtTime(tx.req.timing.startTs)}</td>
    <td>${tx.method}</td>
    <td class="${statusClass(tx.resp?.status ?? 0)}">${tx.resp?.status ?? ""}</td>
    <td>${tx.host}</td>
    <td title="${tx.routeKey}">${tx.path}</td>
    <td>${tx.durationMs ?? ""}</td>
    <td>${fmtBytes(tx.resp?.sizeBytes)}</td>
  `;
  tr.addEventListener("click", ()=> openDetails(tx));
  return tr;
}

// Recebe envelopes agregados e cria linhas
window.wirepeek?.onCapEvent?.(({ channel, payload }) => {
  // Se você enviar do main um "cap:txn" pronto, é só renderizar direto.
  if (channel === "cap:txn") {
    const tx = payload; // objeto CapTxn
    tbody.appendChild(appendTxnRow(tx));
    // auto-scroll se está no fim (reuso do seu 'stickToBottom' se quiser)
    return;
  }
  // Caso ainda esteja recebendo eventos granulares, ignore aqui ou trate separadamente.
});

// Estado no título
window.wirepeek?.onState?.((s) => {
  document.title = s.capturing ? "WirePeek Inspector • Capturando" : "WirePeek Inspector";
});

// Tabs simples
document.querySelectorAll(".tabs button").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    const id = btn.dataset.tab;
    document.querySelectorAll(".tab").forEach(t => t.classList.add("hidden"));
    document.getElementById(`tab-${id}`).classList.remove("hidden");
  });
});
