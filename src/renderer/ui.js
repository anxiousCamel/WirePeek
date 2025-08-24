/* eslint-env browser */
const $ = (id)=>document.getElementById(id);

const tabstrip   = $("tabstrip");
const btnNewTab  = $("tab-new");
const webviewsEl = $("webviews");

const address   = $("address");
const btnGo     = $("btn-go");
const btnBack   = $("btn-back");
const btnFwd    = $("btn-fwd");
const btnReload = $("btn-reload");
const btnCap    = $("btn-capture");

const NEUTRAL_FALLBACK = "#24272b";

/* ======= helpers globais ======= */
// === ADAPTIVE THEME ===
const $root = document.documentElement;
const setVars = (obj) => Object.entries(obj).forEach(([k,v])=> $root.style.setProperty(k, v));

function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if(!m) return null;
  return {r:parseInt(m[1],16), g:parseInt(m[2],16), b:parseInt(m[3],16)};
}
function rgbToHex({r,g,b}){
  const to2=(v)=>v.toString(16).padStart(2,"0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}
function luminance({r,g,b}){
  const srgb=[r,g,b].map(v=>{
    const x=v/255;
    return x<=0.03928? x/12.92 : Math.pow((x+0.055)/1.055,2.4);
  });
  return 0.2126*srgb[0]+0.7152*srgb[1]+0.0722*srgb[2];
}
function suitableInk(bgHex){
  const rgb=hexToRgb(bgHex); if(!rgb) return "#ffffff";
  return luminance(rgb) > 0.45 ? "#111111" : "#ffffff";
}
function mixHex(a,b,t){ // t: 0..1
  const ca=hexToRgb(a), cb=hexToRgb(b); if(!ca||!cb) return a;
  const mix=(x,y)=>Math.round(x*(1-t)+y*t);
  return rgbToHex({r:mix(ca.r,cb.r), g:mix(ca.g,cb.g), b:mix(ca.b,cb.b)});
}
// converte "rgb(...)" ou "#abc/abcdef" em "#rrggbb"
function cssColorToHex(input){
  if(!input) return null;
  const s=String(input).trim();
  const mhex=s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if(mhex){
    if(mhex[1].length===3){
      const [r,g,b]=mhex[1].split("");
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return s.toLowerCase();
  }
  const mrgb=s.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d*\.?\d+))?\)$/i);
  if(mrgb){
    const r=Math.max(0,Math.min(255,parseInt(mrgb[1],10)));
    const g=Math.max(0,Math.min(255,parseInt(mrgb[2],10)));
    const b=Math.max(0,Math.min(255,parseInt(mrgb[3],10)));
    if(mrgb[4]!=null){ const a=Math.max(0,Math.min(1,parseFloat(mrgb[4]))); if(a<0.05) return null; }
    return rgbToHex({r,g,b});
  }
  return null;
}

/* ======= título/janela ======= */
// === ADAPTIVE THEME ===
function applyChromeTheme(baseHex){
  if(!baseHex) baseHex = NEUTRAL_FALLBACK;

  const ink = suitableInk(baseHex);
  // regra: se fundo é escuro -> clarear hover/active; se claro -> escurecer
  const lift = (ink==="#ffffff") ? "#ffffff" : "#000000";
  const push = (ink==="#ffffff") ? "#000000" : "#ffffff";

  const tabHover  = mixHex(baseHex, lift, 0.08);
  const tabActive = mixHex(baseHex, lift, 0.12);

  const btnBg     = mixHex(baseHex, push, 0.10);
  const btnHover  = mixHex(btnBg,   lift, 0.08);
  const btnInk    = suitableInk(btnBg);
  const btnBorder = mixHex(btnBg,   ink,  0.35);

  const fieldBg     = mixHex(baseHex, push, 0.18);
  const fieldInk    = suitableInk(fieldBg);
  const fieldBorder = mixHex(fieldBg,  ink,  0.35);

  const chromeBorder = mixHex(baseHex, ink, 0.30);

  setVars({
    "--chrome-bg": baseHex,
    "--chrome-ink": ink,
    "--chrome-border": chromeBorder,

    "--tab-bg": baseHex,
    "--tab-hover": tabHover,
    "--tab-active": tabActive,

    "--btn-bg": btnBg,
    "--btn-ink": btnInk,
    "--btn-hover": btnHover,
    "--btn-border": btnBorder,

    "--field-bg": fieldBg,
    "--field-ink": fieldInk,
    "--field-border": fieldBorder
  });
}

/* ======= janela (ícones) ======= */
$("win-min").addEventListener("click",()=>window.win?.minimize());
$("win-close").addEventListener("click",()=>window.win?.close());
$("win-max").addEventListener("click",async()=>{
  const res=await window.win?.toggleMaximize();
  if(res&&"maximized"in res) setMaxButtonIcon(res.maximized);
});
window.win?.onMaximizedChange((isMax)=>setMaxButtonIcon(isMax));
function setMaxButtonIcon(isMax){const b=$("win-max"); if(!b) return; b.textContent=isMax?"❐":"🗖";}

/** ======= estado ======= */
let nextId=1;
const tabs=new Map(); // id -> { id, tabEl, viewEl, title, url, color, ink }
let order=[];         // array de ids na ordem visual
let activeId=null;

/** ======= WebView/iframe ======= */
function applyIframeFullSize(webviewEl){
  if(!webviewEl) return;
  const STYLE="flex:1 1 auto;height:100%;width:100%;border:0px;";
  const tryApply=()=>{
    const shadow=webviewEl.shadowRoot; if(!shadow) return false;
    const iframe=shadow.querySelector("iframe"); if(!iframe) return false;
    iframe.setAttribute("style", STYLE); return true;
  };
  if(tryApply()) return;
  const id=setInterval(()=>{ if(tryApply()) clearInterval(id); },30);
  setTimeout(()=>clearInterval(id),3000);
}
function bindIframeFullSizeHooks(webviewEl){
  if(!webviewEl) return;
  const apply=()=>applyIframeFullSize(webviewEl);
  webviewEl.addEventListener("dom-ready",apply);
  webviewEl.addEventListener("did-attach",apply);
  webviewEl.addEventListener("did-stop-loading",apply);
  apply();
}

/** ======= criar elementos ======= */
function createTabEl(tab){
  const el=document.createElement("div");
  el.className="tab";
  el.draggable=true;
  el.dataset.id=String(tab.id);
  el.innerHTML=`
    <img class="fav" alt="">
    <div class="title">Nova guia</div>
    <button class="close" title="Fechar">✕</button>
  `;

  el.addEventListener("click",(e)=>{
    if(e.target.closest(".close")) return;
    activateTab(tab.id);
  });

  el.querySelector(".close").addEventListener("click",(e)=>{
    e.stopPropagation();
    closeTab(tab.id);
  });

  /* DnD – visual e reordenação */
  el.addEventListener("dragstart",(e)=>{
    el.classList.add("drag-ghost");
    e.dataTransfer.setData("text/plain", String(tab.id));
    e.dataTransfer.effectAllowed="move";
  });
  el.addEventListener("dragend",()=>el.classList.remove("drag-ghost"));
  el.addEventListener("dragover",(e)=>{ e.preventDefault();
    const rect=el.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    el.classList.toggle("drop-before", before);
    el.classList.toggle("drop-after", !before);
  });
  el.addEventListener("dragleave",()=>{ el.classList.remove("drop-before","drop-after"); });
  el.addEventListener("drop",(e)=>{
    e.preventDefault();
    el.classList.remove("drop-before","drop-after");
    const fromId = Number(e.dataTransfer.getData("text/plain"));
    const toId   = Number(el.dataset.id);
    const rect=el.getBoundingClientRect();
    const before = (e.clientX - rect.left) < rect.width/2;
    reorderTab(fromId, toId, before ? "before":"after");
  });

  return el;
}

function createWebview(tab, url){
  const view=document.createElement("webview");
  view.setAttribute("allowpopups","");
  const wvPreload=window.__wvPreloadPath || "";
  if(wvPreload) view.setAttribute("preload", wvPreload);
  view.setAttribute("data-managed-size","");
  view.setAttribute("width","0"); view.setAttribute("height","0");
  view.src = url || "https://www.google.com";

  // encaminhar captura do convidado → main
  view.addEventListener("ipc-message",(e)=>{
    const {channel,args}=e; if(!channel?.startsWith("cap:")) return;
    window.wirepeek?.emitCapture?.(channel, args?.[0] ?? {});
  });

  // loader
  view.addEventListener("did-start-loading",()=>btnReload.classList.add("loading"));
  view.addEventListener("did-stop-loading", ()=>btnReload.classList.remove("loading"));

  // título/url
  const sync=()=>{
    const u=(view.getURL&&view.getURL()) || tab.url;
    const t=(view.getTitle&&view.getTitle()) || tab.title || u || "Nova guia";
    tab.url=u; tab.title=t;
    if(tab.id===activeId) address.value=u || "";
    updateTabTitleAndFavicon(tab,u,t);
    updateNavButtons();
  };
  ["did-navigate","did-navigate-in-page","page-title-updated"].forEach(ev=>view.addEventListener(ev,sync));

  // === ADAPTIVE THEME ===
  const applyThemeColor = async () => {
    try {
      const script = `
        (() => {
          // 1) meta theme-color
          const m = document.querySelector('meta[name="theme-color"]');
          if (m && m.content) return m.content;

          // 2) cor visível perto do topo
          const x = Math.max(1, Math.floor(window.innerWidth / 2));
          const y = 1;
          let el = document.elementFromPoint(x, y) || document.body || document.documentElement;
          const seen = new Set();
          while (el && !seen.has(el)) {
            seen.add(el);
            const cs = getComputedStyle(el);
            const bg = cs.backgroundColor || cs.background;
            if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
            el = el.parentElement || el.parentNode;
          }
          // 3) fallback: body/html
          const bodyBg = getComputedStyle(document.body).backgroundColor;
          if (bodyBg) return bodyBg;
          const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
          if (htmlBg) return htmlBg;
          return null;
        })();
      `;
      const picked = await view.executeJavaScript(script, true);
      let baseHex = cssColorToHex(picked) || NEUTRAL_FALLBACK;

      const ink = suitableInk(baseHex);
      tab.color = baseHex;
      tab.ink   = ink;

      paintTab(tab);
      if (tab.id === activeId) applyChromeTheme(baseHex);
    } catch {
      const base = NEUTRAL_FALLBACK;
      tab.color = base; tab.ink = suitableInk(base); paintTab(tab);
      if (tab.id === activeId) applyChromeTheme(base);
    }
  };
  view.addEventListener("did-finish-load",  applyThemeColor);
  view.addEventListener("page-title-updated", applyThemeColor);
  view.addEventListener("did-navigate-in-page", applyThemeColor);

  bindIframeFullSizeHooks(view);
  view.addEventListener("dom-ready",()=>window.__resizeWebviewsNow?.());

  return view;
}

/** ======= UI e estado ======= */
function paintTab(tab){
  const el = tab.tabEl;
  if(!el) return;
  const col = tab.color || NEUTRAL_FALLBACK;
  const ink = tab.ink  || "#ffffff";
  el.style.setProperty("--tab-col", col);
  el.style.setProperty("--tab-ink", ink);
  el.style.color = ink;
}
function updateTabTitleAndFavicon(tab, url, title){
  const tabEl=tab.tabEl;
  tabEl.querySelector(".title").textContent = title || url || "Nova guia";
  try{
    const u=new URL(url);
    tabEl.querySelector(".fav").src = `${u.origin}/favicon.ico`;
  }catch{
    tabEl.querySelector(".fav").src = "favicon.ico";
  }
}

function addTab(url){
  const id=nextId++;
  const tab={ id, title:"Nova guia", url:url||"", color:NEUTRAL_FALLBACK, ink:"#ffffff" };
  tab.tabEl = createTabEl(tab);
  tab.viewEl = createWebview(tab, url);

  tabstrip.insertBefore(tab.tabEl, btnNewTab);
  webviewsEl.appendChild(tab.viewEl);

  tabs.set(id, tab);
  order.push(id);

  requestAnimationFrame(()=>window.__resizeWebviewsNow?.());
  activateTab(id);
  return id;
}

function activateTab(id){
  if(activeId===id) return;

  if(activeId!=null){
    const old=tabs.get(activeId);
    if(old){ old.tabEl.classList.remove("active"); old.viewEl.classList.remove("active"); }
  }
  activeId=id;
  const t=tabs.get(id); if(!t) return;
  t.tabEl.classList.add("active"); t.viewEl.classList.add("active");
  address.value=t.url || "";
  updateNavButtons();
  paintTab(t);

  // === ADAPTIVE THEME ===
  applyChromeTheme(t.color || NEUTRAL_FALLBACK);
}

function closeTab(id){
  const t=tabs.get(id); if(!t) return;
  t.tabEl.remove(); t.viewEl.remove();
  tabs.delete(id);
  const idx=order.indexOf(id);
  if(idx>=0) order.splice(idx,1);

  if(order.length===0){ addTab("https://www.google.com"); return; }

  if(activeId===id){
    const next = order[Math.max(0, idx-1)];
    activateTab(next);
  }
}

function reorderTab(fromId, toId, where){
  if(fromId===toId) return;
  const from=tabs.get(fromId), to=tabs.get(toId);
  if(!from||!to) return;

  if(where==="before") tabstrip.insertBefore(from.tabEl, to.tabEl);
  else tabstrip.insertBefore(from.tabEl, to.tabEl.nextSibling);

  if(where==="before") webviewsEl.insertBefore(from.viewEl, to.viewEl);
  else webviewsEl.insertBefore(from.viewEl, to.viewEl.nextSibling);

  const a=order.indexOf(fromId); if(a<0) return;
  order.splice(a,1);
  const b=order.indexOf(toId);
  order.splice(where==="before"?b:b+1, 0, fromId);
}

/** ======= navegação ======= */
function normalizeInputToUrlOrSearch(text){
  const raw=(text||"").trim(); if(!raw) return "";
  if(/\s/.test(raw)) return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  if(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return `https://${raw}`;
  return raw;
}
function currentView(){ const t=tabs.get(activeId); return t?.viewEl || null; }
function updateNavButtons(){
  try{ const v=currentView(); btnBack.disabled=!v?.canGoBack(); btnFwd.disabled=!v?.canGoForward(); }
  catch{ /* empty */ }
}
btnNewTab.addEventListener("click",()=>addTab("https://www.google.com"));
btnGo.addEventListener("click",goFromAddress);
address.addEventListener("keydown",(e)=>e.key==="Enter"&&goFromAddress());
btnBack.addEventListener("click",()=>currentView()?.goBack());
btnFwd.addEventListener("click", ()=>currentView()?.goForward());
btnReload.addEventListener("click",()=>currentView()?.reload());

function goFromAddress(){
  const url=normalizeInputToUrlOrSearch(address.value); if(!url) return;
  const v=currentView(); if(v) v.loadURL(url);
}

// ======= captura =======
let capturing = false;

/** Atualiza o visual do botão de captura. */
function renderCaptureState(){
  btnCap.classList.toggle("cap-on",  capturing);
  btnCap.classList.toggle("cap-off", !capturing);
  btnCap.setAttribute("aria-pressed", capturing ? "true" : "false");
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const s = await window.wirepeek?.getState?.();
    capturing = !!s?.capturing;
    renderCaptureState();
  } catch {
    // sem ação
  }

  // Mantém sincronizado quando o main broadcastar cap:state
  window.wirepeek?.onState?.((s) => {
    capturing = !!s.capturing;
    renderCaptureState();
  });
});

/** Clique do botão: usa start/stop (não existe mais 'toggle'). */
btnCap.addEventListener("click", async () => {
  try {
    const s = capturing
      ? await window.wirepeek?.stop?.()
      : await window.wirepeek?.start?.(); // o main abre o Inspetor ao iniciar
    capturing = !!s?.capturing;
    renderCaptureState();
  } catch (e) {
    console.error("[cap] erro ao alternar:", e);
  }
});

/** ======= bootstrap ======= */
window.wirepeek?.onConfig?.(({targetUrl})=>{
  addTab(targetUrl || "https://www.google.com");
  renderCaptureState(); updateNavButtons();
});
if(!window.wirepeek){
  addTab("https://www.google.com");
  renderCaptureState(); updateNavButtons();
}

/** ======= atalhos ======= */
document.addEventListener("keydown",(e)=>{
  if(e.ctrlKey && e.key.toLowerCase()==="t"){ e.preventDefault(); addTab("https://www.google.com"); }
  if(e.ctrlKey && e.key.toLowerCase()==="w"){ e.preventDefault(); if(activeId!=null) closeTab(activeId); }
  if(e.ctrlKey && e.key.toLowerCase()==="l"){ e.preventDefault(); address.select(); }
});
