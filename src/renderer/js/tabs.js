/* eslint-env browser */
/**
 * @file src/renderer/js/tabs.js
 * @brief Gerencia as guias (tabs) e respectivos <webview>s da UI.
 *
 * Responsabilidades:
 *  - Criar/fechar/ativar/reordenar abas
 *  - Manter o <webview> ocupando a área útil (ajuste no shadow iframe)
 *  - Sincronizar título, favicon e barra de endereço
 *  - Adaptar o tema (cores) a partir do site ativo (sonda do topo da página)
 *  - Encaminhar eventos de captura vindos do guest (webview → main via preload)
 */

import { el } from "./dom.js";
import {
  applyChromeTheme,
  cssColorToHex,
  suitableInk,
  NEUTRAL_FALLBACK,
} from "./color.js";

/** URL padrão para a primeira navegação */
const START_URL =
  "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2";

/**
 * Script injetado no guest para “adivinhar” a cor base do site.
 * Estratégia:
 *  - Amostra vários pontos na faixa superior (y pequenos)
 *  - Para cada ponto, sobe na árvore compondo background-color com alpha
 *  - Se não há background-image, também examina `background` (shorthand) sólido
 *  - Vota na cor mais frequente, e devolve "#rrggbb" (ou null)
 *
 * Observação: é um IIFE (executa e retorna o valor imediatamente).
 */
const THEME_PROBE_SCRIPT = `
(() => {
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  const toHex2=n=>n.toString(16).padStart(2,'0');
  const hex=(r,g,b)=>'#'+toHex2(r)+toHex2(g)+toHex2(b);

  // ---- parsing de cores: #hex, rgb/rgba (vírgula ou CSS4), hsl/hsla ----
  const parseColor = (s) => {
    if (!s) return null;
    s = String(s).trim().toLowerCase();

    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      const h=m[1];
      const r=h.length===3?parseInt(h[0]+h[0],16):parseInt(h.slice(0,2),16);
      const g=h.length===3?parseInt(h[1]+h[1],16):parseInt(h.slice(2,4),16);
      const b=h.length===3?parseInt(h[2]+h[2],16):parseInt(h.slice(4,6),16);
      return {r,g,b,a:1};
    }

    m = s.match(/^rgba?\\(\\s*(-?\\d{1,3})\\s*,\\s*(-?\\d{1,3})\\s*,\\s*(-?\\d{1,3})(?:\\s*,\\s*([0-9]*\\.?[0-9]+))?\\s*\\)$/i)
     || s.match(/^rgba?\\(\\s*(-?\\d{1,3})\\s+(-?\\d{1,3})\\s+(-?\\d{1,3})(?:\\s*\\/\\s*([0-9]*\\.?[0-9]+))?\\s*\\)$/i);
    if (m) {
      const r=clamp(parseInt(m[1],10),0,255);
      const g=clamp(parseInt(m[2],10),0,255);
      const b=clamp(parseInt(m[3],10),0,255);
      const a=m[4]!=null?clamp(parseFloat(m[4]),0,1):1;
      return {r,g,b,a};
    }

    m = s.match(/^hsla?\\(\\s*(-?\\d*\\.?\\d+)\\s*(?:,|\\s)\\s*(-?\\d*\\.?\\d+)%(?:,|\\s)\\s*(-?\\d*\\.?\\d+)%(?:\\s*(?:,|\\/ )\\s*([0-9]*\\.?[0-9]+))?\\s*\\)$/i);
    if (m) {
      let h=((parseFloat(m[1])%360)+360)%360;
      const S=clamp(parseFloat(m[2]),0,100)/100;
      const L=clamp(parseFloat(m[3]),0,100)/100;
      const a=m[4]!=null?clamp(parseFloat(m[4]),0,1):1;
      const C=(1-Math.abs(2*L-1))*S, X=C*(1-Math.abs(((h/60)%2)-1)), m0=L-C/2;
      let rp=0,gp=0,bp=0;
      if (h<60){rp=C;gp=X;bp=0;} else if (h<120){rp=X;gp=C;bp=0;}
      else if (h<180){rp=0;gp=C;bp=X;} else if (h<240){rp=0;gp=X;bp=C;}
      else if (h<300){rp=X;gp=0;bp=C;} else {rp=C;gp=0;bp=X;}
      return {r:Math.round((rp+m0)*255), g:Math.round((gp+m0)*255), b:Math.round((bp+m0)*255), a};
    }
    return null;
  };

  // Extrai TODAS as cores encontradas numa string (gradientes, shorthand etc)
  const extractColors = (bg) => {
    if (!bg) return [];
    const out=[], re=/(#[0-9a-f]{3,6}|rgba?\\([^\\)]+\\)|hsla?\\([^\\)]+\\))/ig;
    let m; while ((m=re.exec(String(bg).toLowerCase()))) { const p=parseColor(m[0]); if (p) out.push(p); }
    return out;
  };

  const lum=(r,g,b)=>{r/=255;g/=255;b/=255;const a=[r,g,b].map(v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4));return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2];};
  const sat=(r,g,b)=>{const mx=Math.max(r,g,b), mn=Math.min(r,g,b); return mx? (mx-mn)/mx : 0;};

  // Escolhe 1 cor de um computed style (prioriza sólido; senão, 1a cor do gradiente)
  const pickFromStyle = (cs) => {
    const pc = parseColor(cs.backgroundColor);
    if (pc && pc.a>0.02) return pc;

    const imgs = (cs.backgroundImage||'') + ' ' + (cs.background||'');
    const cols = extractColors(imgs);
    if (cols.length) return cols[0]; // topo do gradiente por convenção
    return null;
  };

  // compõe alpha: top OVER under
  const composite = (top, under) => {
    if (!under) return top;
    const a = top.a + under.a*(1-top.a);
    const r = Math.round(top.r*top.a + under.r*under.a*(1-top.a));
    const g = Math.round(top.g*top.a + under.g*under.a*(1-top.a));
    const b = Math.round(top.b*top.a + under.b*under.a*(1-top.a));
    return {r,g,b,a};
  };

  // cor "efetiva" subindo nos ancestrais
  const effectiveColor = (start) => {
    let el=start, seen=new Set(), acc={r:0,g:0,b:0,a:0};
    while (el && !seen.has(el)) {
      seen.add(el);
      const cs=getComputedStyle(el);
      const picked = pickFromStyle(cs);
      if (picked) {
        acc = composite(picked, acc);
        if (acc.a>=0.999) break;
      }
      el = el.parentElement || el.parentNode;
    }
    if (acc.a===0) return null;
    return hex(acc.r, acc.g, acc.b);
  };

  // 0) tente header/nav/banner primeiro
  const cands = Array.from(document.querySelectorAll('header, nav, [role="banner"], .header, #header, .masthead, .site-header'))
    .filter(e=>e.offsetHeight>32 && e.offsetWidth>innerWidth*0.5);
  for (const el of cands) {
    const c = effectiveColor(el);
    if (c) return c;
  }

  // 1) votação na faixa superior
  const ys=[8,16,24,36,48,60,72];
  const cols=18, left=8, right=8;
  const w=Math.max(1, innerWidth-(left+right)), step=w/Math.max(1,cols-1);
  const votes=new Map(); const vote=c=>{ if(!c) return; c=c.toLowerCase(); votes.set(c,(votes.get(c)||0)+1); };

  for (const y of ys) {
    for (let i=0;i<cols;i++) {
      const x=Math.round(left+i*step);
      const el=document.elementFromPoint(x,y) || document.body || document.documentElement;
      vote(effectiveColor(el));
    }
    if (votes.size>0) break;
  }
  if (votes.size===0) { vote(effectiveColor(document.body)); vote(effectiveColor(document.documentElement)); }

  // 2) cluster por distância e pontue por frequência * saturação * (1 - luminância*0.3)
  const toRGB=h=>({r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16)});
  const dist=(a,b)=>{const da=a.r-b.r, db=a.g-b.g, dc=a.b-b.b; return Math.sqrt(da*da+db*db+dc*dc);};
  const clusters=[];
  for (const [h, count] of votes) {
    const rgb=toRGB(h);
    let bucket = clusters.find(c=>dist(c.rgb,rgb)<=24);
    if (!bucket) clusters.push({rgb, hex:h, score:0});
    const s = (1+count) * (0.8 + sat(rgb.r,rgb.g,rgb.b)) * (1.0 - 0.3*lum(rgb.r,rgb.g,rgb.b));
    bucket.score += s;
  }
  clusters.sort((a,b)=>b.score-a.score);
  return clusters.length? clusters[0].hex : null;
})();
`;


/* ───────────────────────────
 * Estado das abas
 * ─────────────────────────── */

let nextId = 1;
/** Map: id → { id, tabEl, viewEl, title, url, color, ink } */
const tabs = new Map();
/** Ordem visual/lógica das abas (ids) */
const order = [];
/** id da aba ativa (ou null) */
let activeId = null;

/** API de estado público para outros módulos (main.js, etc.) */
export const state = {
  get activeId() {
    return activeId;
  },
  /** @returns {Electron.WebviewTag|null} webview ativo */
  currentView() {
    const t = tabs.get(activeId);
    return t?.viewEl || null;
  },
  /** Atualiza botões Voltar/Avançar baseado no histórico do webview ativo. */
  updateNavButtons() {
    try {
      const v = this.currentView();
      el.btnBack.disabled = !v?.canGoBack?.();
      el.btnFwd.disabled = !v?.canGoForward?.();
    } catch { /* noop */ }
  },
};

/* ───────────────────────────
 * Helpers visuais e DOM
 * ─────────────────────────── */

/** Aplica as cores atuais na “pastilha” da aba. */
function paintTab(tab) {
  const eltab = tab.tabEl;
  if (!eltab) return;
  eltab.style.setProperty("--tab-col", tab.color || NEUTRAL_FALLBACK);
  eltab.style.setProperty("--tab-ink", tab.ink || "#ffffff");
  eltab.style.color = tab.ink || "#ffffff";
}

/** Atualiza título + favicon exibidos na aba. */
function updateTabTitleAndFavicon(tab, url, title) {
  const tabEl = tab.tabEl;
  tabEl.querySelector(".title").textContent = title || url || "Nova guia";
  try {
    const u = new URL(url);
    tabEl.querySelector(".fav").src = `${u.origin}/favicon.ico`;
  } catch {
    tabEl.querySelector(".fav").src = "favicon.ico";
  }
}

/**
 * Força o <iframe> interno do <webview> a ocupar 100% (Shadow DOM).
 * Útil porque o <webview> às vezes nasce com medidas mínimas.
 */
function applyIframeFullSize(webviewEl) {
  if (!webviewEl) return;
  const STYLE = "flex:1 1 auto;height:100%;width:100%;border:0px;";

  const tryApply = () => {
    const shadow = webviewEl.shadowRoot;
    if (!shadow) return false;
    const iframe = shadow.querySelector("iframe");
    if (!iframe) return false;
    iframe.setAttribute("style", STYLE);
    return true;
  };

  if (tryApply()) return;
  const id = setInterval(() => {
    if (tryApply()) clearInterval(id);
  }, 30);
  setTimeout(() => clearInterval(id), 3000);
}

/** Reaplica o ajuste de tamanho em momentos-chave do webview. */
function bindIframeFullSizeHooks(webviewEl) {
  if (!webviewEl) return;
  const apply = () => applyIframeFullSize(webviewEl);
  webviewEl.addEventListener("dom-ready", apply);
  webviewEl.addEventListener("did-attach", apply);
  webviewEl.addEventListener("did-stop-loading", apply);
  apply();
}

/* ───────────────────────────
 * Tema (sonda + aplicação)
 * ─────────────────────────── */

/**
 * Roda a sonda no guest, atualiza as cores da tab + aplica tema global
 * se a tab for a ativa.
 */
async function applyThemeColorToTab(view, tab) {
  try {
    const picked = await view.executeJavaScript(THEME_PROBE_SCRIPT, true);
    const baseHex = cssColorToHex(picked) || NEUTRAL_FALLBACK;
    tab.color = baseHex;
    tab.ink = suitableInk(baseHex);
    paintTab(tab);
    if (tab.id === activeId) applyChromeTheme(baseHex);
  } catch {
    const base = NEUTRAL_FALLBACK;
    tab.color = base;
    tab.ink = suitableInk(base);
    paintTab(tab);
    if (tab.id === activeId) applyChromeTheme(base);
  }
}

/* ───────────────────────────
 * Criação de elementos
 * ─────────────────────────── */

/** Cria o elemento visual da aba na strip. */
function createTabEl(tab) {
  const eltab = document.createElement("div");
  eltab.className = "tab";
  eltab.draggable = true;
  eltab.dataset.id = String(tab.id);
  eltab.innerHTML = `
    <img class="fav" alt="">
    <div class="title">Nova guia</div>
    <button class="close" title="Fechar">✕</button>
  `;

  eltab.onclick = (e) => {
    if (e.target.closest(".close")) return;
    activateTab(tab.id);
  };
  eltab.querySelector(".close").onclick = (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  };

  // Drag & Drop de abas
  eltab.addEventListener("dragstart", (e) => {
    eltab.classList.add("drag-ghost");
    e.dataTransfer.setData("text/plain", String(tab.id));
    e.dataTransfer.effectAllowed = "move";
  });
  eltab.addEventListener("dragend", () => eltab.classList.remove("drag-ghost"));
  eltab.addEventListener("dragover", (e) => {
    e.preventDefault();
    const r = eltab.getBoundingClientRect();
    const before = e.clientX - r.left < r.width / 2;
    eltab.classList.toggle("drop-before", before);
    eltab.classList.toggle("drop-after", !before);
  });
  eltab.addEventListener("dragleave", () =>
    eltab.classList.remove("drop-before", "drop-after")
  );
  eltab.addEventListener("drop", (e) => {
    e.preventDefault();
    eltab.classList.remove("drop-before", "drop-after");
    const fromId = Number(e.dataTransfer.getData("text/plain"));
    const toId = Number(eltab.dataset.id);
    const r = eltab.getBoundingClientRect();
    const before = e.clientX - r.left < r.width / 2;
    reorderTab(fromId, toId, before ? "before" : "after");
  });

  return eltab;
}

/* ───────────────────────────
 * Webview: criação e hooks
 * ─────────────────────────── */

let warnedEmptyPreload = false;

/**
 * Cria o <webview> para uma aba.
 * - Usa a mesma session (partition) do app principal (ex.: "persist:wirepeek")
 * - Define `preload` se recebido via `window.__wvPreloadPath` (file://…)
 * - Encaminha eventos de captura (cap:*) do guest para o main
 * - Ajusta tamanho (shadow iframe) e sincroniza metadados
 * - Faz “burst” de re-sondas de cor após carregamentos (pega UI que hidrata depois)
 */
function createWebview(tab, url) {
  /** @type {Electron.WebviewTag} */
  const view = document.createElement("webview");
  view.setAttribute("allowpopups", "");
  view.setAttribute("data-managed-size", "");
  view.setAttribute("width", "0");
  view.setAttribute("height", "0");

  // Mesma partition/sessão do app principal
  const part = window.__wvPartition || "persist:wirepeek";
  view.setAttribute("partition", part);

  // Preload do webview (file://)
  const wvPreload = window.__wvPreloadPath || "";
  if (!wvPreload) {
    if (!warnedEmptyPreload) {
      console.warn("[webview] preload path vazio; eventos de captura não serão emitidos");
      warnedEmptyPreload = true;
    }
  } else {
    view.setAttribute("preload", wvPreload);
  }

  // Definir src por último
  view.src = url || START_URL;

  // Debug do console do guest no host
  view.addEventListener("console-message", (e) => {
    console.debug(`[guest console] ${e.message}`);
  });

  // Encaminha eventos de captura enviados pelo guest → main
  view.addEventListener("ipc-message", (e) => {
    const { channel, args } = e;
    if (!channel || typeof channel !== "string") return;
    if (!channel.startsWith("cap:")) return;
    window.wirepeek?.emitCapture?.(channel, args?.[0] ?? {});
  });

  // Spinner do botão reload
  view.addEventListener("did-start-loading", () =>
    el.btnReload.classList.add("loading")
  );
  view.addEventListener("did-stop-loading", () =>
    el.btnReload.classList.remove("loading")
  );

  // Sincronização de URL/título + favicon
  const sync = () => {
    try {
      const u = (typeof view.getURL === "function" ? view.getURL() : tab.url) || tab.url;
      const t = (typeof view.getTitle === "function" ? view.getTitle() : tab.title) || tab.title || u || "Nova guia";
      tab.url = u;
      tab.title = t;
      if (tab.id === activeId) el.address.value = u || "";
      updateTabTitleAndFavicon(tab, u, t);
      state.updateNavButtons();
    } catch { /* noop */ }
  };
  ["did-navigate", "did-navigate-in-page", "page-title-updated"].forEach((ev) =>
    view.addEventListener(ev, sync)
  );
  view.addEventListener("page-favicon-updated", sync);

  // Tema adaptativo — vários gatilhos e um "burst" de re-sondas
  const reapplyTheme = () => applyThemeColorToTab(view, tab).catch(() => {});
  [
    "dom-ready",
    "did-frame-finish-load",
    "did-finish-load",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
    "did-redirect-navigation",
  ].forEach((ev) => view.addEventListener(ev, reapplyTheme));

  // Burst: várias tentativas por ~1.2s (pega quando o topo “assenta”)
  const burstProbe = () => {
    let tries = 0;
    const tick = () => {
      tries++;
      reapplyTheme();
      if (tries < 8) setTimeout(tick, 150);
    };
    tick();
  };
  view.addEventListener("dom-ready", burstProbe);
  view.addEventListener("did-finish-load", burstProbe);

  // Ocupa 100% da área útil
  bindIframeFullSizeHooks(view);
  view.addEventListener("dom-ready", () => window.__resizeWebviewsNow?.());

  // Links target=_blank → nova aba
  view.addEventListener("new-window", (e) => {
    try { if (e && e.url) addTab(e.url); } catch { /* noop */ }
  });

  return view;
}

/* ───────────────────────────
 * API pública (criar/ativar/fechar/reordenar)
 * ─────────────────────────── */

/** Cria uma nova aba e a ativa. */
export function addTab(url) {
  const id = nextId++;
  const tab = {
    id,
    title: "Nova guia",
    url: url || "",
    color: NEUTRAL_FALLBACK,
    ink: "#ffffff",
  };

  tab.tabEl = createTabEl(tab);
  tab.viewEl = createWebview(tab, url);

  el.tabstrip.insertBefore(tab.tabEl, el.btnNewTab);
  el.webviews.appendChild(tab.viewEl);

  tabs.set(id, tab);
  order.push(id);

  requestAnimationFrame(() => window.__resizeWebviewsNow?.());
  activateTab(id);
  return id;
}

/** Ativa a aba indicada. */
export function activateTab(id) {
  if (activeId === id) return;

  if (activeId != null) {
    const old = tabs.get(activeId);
    if (old) {
      old.tabEl.classList.remove("active");
      old.viewEl.classList.remove("active");
    }
  }

  activeId = id;
  const t = tabs.get(id);
  if (!t) return;

  t.tabEl.classList.add("active");
  t.viewEl.classList.add("active");

  el.address.value = t.url || "";
  state.updateNavButtons();
  paintTab(t);
  applyChromeTheme(t.color || NEUTRAL_FALLBACK);

  // Re-sonda ao ativar (caso tenha mudado depois)
  if (t.viewEl) applyThemeColorToTab(t.viewEl, t).catch(() => {});
}

/** Fecha a aba indicada. */
export function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;

  t.tabEl.remove();
  t.viewEl.remove();
  tabs.delete(id);

  const idx = order.indexOf(id);
  if (idx >= 0) order.splice(idx, 1);

  if (order.length === 0) {
    addTab(START_URL);
    return;
  }

  if (activeId === id) {
    const next = order[Math.max(0, idx - 1)];
    activateTab(next);
  }
}

/**
 * Reordena a aba `fromId` em relação à `toId`.
 * @param {number} fromId
 * @param {number} toId
 * @param {"before"|"after"} where
 */
export function reorderTab(fromId, toId, where) {
  if (fromId === toId) return;
  const from = tabs.get(fromId), to = tabs.get(toId);
  if (!from || !to) return;

  // Strip
  if (where === "before") el.tabstrip.insertBefore(from.tabEl, to.tabEl);
  else el.tabstrip.insertBefore(from.tabEl, to.tabEl.nextSibling);

  // Webviews
  if (where === "before") el.webviews.insertBefore(from.viewEl, to.viewEl);
  else el.webviews.insertBefore(from.viewEl, to.viewEl.nextSibling);

  // Ordem lógica
  const a = order.indexOf(fromId);
  if (a < 0) return;
  order.splice(a, 1);
  const b = order.indexOf(toId);
  order.splice(where === "before" ? b : b + 1, 0, fromId);
}

/* ───────────────────────────
 * Facilidades de debug no console da UI
 * ─────────────────────────── */
try {
  // aplica um tema manualmente
  window.themeApply = (hex) => applyChromeTheme(hex || NEUTRAL_FALLBACK);
  // roda a sonda no webview ativo e retorna o valor bruto detectado
  window.themeProbe = async () => {
    const v = state.currentView();
    if (!v) return null;
    try { return await v.executeJavaScript(THEME_PROBE_SCRIPT, true); }
    catch { return null; }
  };
} catch { /* noop */ }
