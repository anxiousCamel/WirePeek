/* eslint-env browser */

/**
 * UI principal: abas, navegação e dimensionamento dos webviews.
 * - Força o iframe interno do <webview> a ter:
 *   style="flex: 1 1 auto; height: 100%; width: 100%; border: 0px;"
 */

// ---------------------- DOM refs ----------------------
const $ = (id) => document.getElementById(id);

const tabstrip   = $("tabstrip");
const btnNewTab  = $("tab-new");
const webviewsEl = $("webviews");

const address   = $("address");
const btnGo     = $("btn-go");
const btnBack   = $("btn-back");
const btnFwd    = $("btn-fwd");
const btnReload = $("btn-reload");
const btnCap    = $("btn-capture");

// ---------------------- Window controls ----------------------
$("win-min").addEventListener("click", () => window.win?.minimize());
$("win-close").addEventListener("click", () => window.win?.close());
$("win-max").addEventListener("click", async () => {
  const res = await window.win?.toggleMaximize();
  if (res && "maximized" in res) setMaxButtonIcon(res.maximized);
});
window.win?.onMaximizedChange((isMax) => setMaxButtonIcon(isMax));
function setMaxButtonIcon(isMax) {
  const b = $("win-max"); if (!b) return;
  b.textContent = isMax ? "❐" : "🗖";
}

// ---------------------- Tabs state ----------------------
let nextId = 1;
const tabs = new Map(); // id -> { id, tabEl, viewEl, title, url }
let activeId = null;

// ---------------------- Helpers: WebView/iframe ----------------------

/** Atribui o estilo exato ao iframe dentro do shadowRoot do webview. */
function applyIframeFullSize(webviewEl) {
  if (!webviewEl) return;

  const STYLE_VALUE = "flex: 1 1 auto; height: 100%; width: 100%; border: 0px;";

  const tryApply = () => {
    const shadow = webviewEl.shadowRoot;
    if (!shadow) return false;
    const iframe = shadow.querySelector("iframe");
    if (!iframe) return false;
    iframe.setAttribute("style", STYLE_VALUE);
    return true;
  };

  // tenta imediatamente; se não conseguir, faz pequenos retries
  if (tryApply()) return;

  const id = setInterval(() => {
    if (tryApply()) clearInterval(id);
  }, 30);
  setTimeout(() => clearInterval(id), 3000);
}

/** Liga eventos que podem recriar o iframe e reaplica o estilo quando necessário. */
function bindIframeFullSizeHooks(webviewEl) {
  if (!webviewEl) return;
  const apply = () => applyIframeFullSize(webviewEl);
  webviewEl.addEventListener("dom-ready", apply);
  webviewEl.addEventListener("did-attach", apply);
  webviewEl.addEventListener("did-stop-loading", apply);
  apply(); // aplica já na criação
}

// ---------------------- UI: criação de elementos ----------------------

function createTabEl(tab) {
  const el = document.createElement("div");
  el.className = "tab";
  el.draggable = true;
  el.dataset.id = String(tab.id);
  el.innerHTML = `
    <img class="fav" alt="">
    <div class="title">Nova guia</div>
    <button class="close" title="Fechar">✕</button>
  `;

  el.addEventListener("click", (e) => {
    if (e.target.closest(".close")) return;
    activateTab(tab.id);
  });

  el.querySelector(".close").addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab.id);
  });

  // drag & drop de abas
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", String(tab.id));
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragover", (e) => e.preventDefault());
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    const fromId = Number(e.dataTransfer.getData("text/plain"));
    const toId   = Number(el.dataset.id);
    reorderTab(fromId, toId);
  });

  return el;
}

function createWebview(tab, url) {
  const view = document.createElement("webview");
  //view.setAttribute("partition", "persist:wirepeek"); //POR ENQUANTO EU VOU COMENTAR ISSO ENQUANTO NÃO ARRUMO A JANELA...
  view.setAttribute("allowpopups", "");
  view.setAttribute("preload", window.__wvPreloadPath || "");
  view.setAttribute("data-managed-size", ""); // usado pelo fit.js se existir
  view.setAttribute("width", "0");
  view.setAttribute("height", "0");
  view.src = url || "https://www.google.com";

  const wvPreload = window.__wvPreloadPath; // já preenchido no preload.ts
  if (wvPreload) view.setAttribute("preload", wvPreload);

  // ---- encaminhar eventos de captura do convidado para o main ----
  view.addEventListener("ipc-message", (e) => {
    const { channel, args } = e;
    if (!channel?.startsWith("cap:")) return;
    window.wirepeek?.emitCapture?.(channel, args?.[0] ?? {});
  });

  // Loader no botão recarregar
  view.addEventListener("did-start-loading", () => btnReload.classList.add("loading"));
  view.addEventListener("did-stop-loading",  () => btnReload.classList.remove("loading"));

  // Sincroniza título/URL da aba ativa
  const sync = () => {
    const u = (view.getURL && view.getURL()) || tab.url;
    const t = (view.getTitle && view.getTitle()) || tab.title || u || "Nova guia";
    tab.url = u; tab.title = t;
    if (tab.id === activeId) address.value = u || "";
    updateTabTitleAndFavicon(tab, u, t);
    updateNavButtons();
  };
  ["did-navigate", "did-navigate-in-page", "page-title-updated"].forEach(ev =>
    view.addEventListener(ev, sync)
  );

  // Força o iframe do shadowRoot a 100%
  bindIframeFullSizeHooks(view);

  // Garante ajuste de tamanho do webview (se usar fit.js)
  view.addEventListener("dom-ready", () => window.__resizeWebviewsNow?.());

  return view;
}

// ---------------------- UI: ações sobre abas ----------------------

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

function addTab(url) {
  const id  = nextId++;
  const tab = { id, title: "Nova guia", url: url || "" };
  tab.tabEl  = createTabEl(tab);
  tab.viewEl = createWebview(tab, url);

  tabstrip.insertBefore(tab.tabEl, btnNewTab);
  webviewsEl.appendChild(tab.viewEl);

  // força dimensionamento antes do primeiro paint (se fit.js estiver presente)
  requestAnimationFrame(() => window.__resizeWebviewsNow?.());

  tabs.set(id, tab);
  activateTab(id);
  return id;
}

function activateTab(id) {
  if (activeId === id) return;

  if (activeId != null) {
    const old = tabs.get(activeId);
    if (old) { old.tabEl.classList.remove("active"); old.viewEl.classList.remove("active"); }
  }

  activeId = id;
  const t = tabs.get(id);
  if (!t) return;
  t.tabEl.classList.add("active");
  t.viewEl.classList.add("active");
  address.value = t.url || "";
  updateNavButtons();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.tabEl.remove();
  t.viewEl.remove();
  tabs.delete(id);

  if (tabs.size === 0) { addTab("https://www.google.com"); return; }
  if (activeId === id) {
    const first = [...tabs.keys()][0];
    activateTab(first);
  }
}

function reorderTab(fromId, toId) {
  if (fromId === toId) return;
  const from = tabs.get(fromId), to = tabs.get(toId);
  if (!from || !to) return;
  tabstrip.insertBefore(from.tabEl, to.tabEl);
}

// ---------------------- Navegação ----------------------

function normalizeInputToUrlOrSearch(text) {
  const raw = (text || "").trim();
  if (!raw) return "";
  if (/\s/.test(raw)) return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return `https://${raw}`;
  return raw;
}

function currentView() {
  const t = tabs.get(activeId);
  return t?.viewEl || null;
}

function updateNavButtons() {
  try {
    const v = currentView();
    btnBack.disabled = !v?.canGoBack();
    btnFwd.disabled  = !v?.canGoForward();
  } catch { /* noop */ }
}

btnNewTab.addEventListener("click", () => addTab("https://www.google.com"));
btnGo.addEventListener("click", goFromAddress);
address.addEventListener("keydown", (e) => e.key === "Enter" && goFromAddress());
btnBack.addEventListener("click", () => currentView()?.goBack());
btnFwd.addEventListener("click",  () => currentView()?.goForward());
btnReload.addEventListener("click", () => currentView()?.reload());

function goFromAddress() {
  const url = normalizeInputToUrlOrSearch(address.value);
  if (!url) return;
  const v = currentView();
  if (v) v.loadURL(url);
}

// ---------------------- Captura (toggle) ----------------------
let capturing = false;
function renderCaptureState() {
  btnCap.textContent = capturing ? "Parar captura" : "Iniciar captura";
  btnCap.classList.toggle("cap-on",  capturing);
  btnCap.classList.toggle("cap-off", !capturing);
}
btnCap.addEventListener("click", async () => {
  try {
    if (!capturing) { await window.wirepeek?.start(); capturing = true; }
    else { await window.wirepeek?.stop(); capturing = false; }
    renderCaptureState();
  } catch (err) { console.error("Erro ao alternar captura:", err); }
});

// ---------------------- Bootstrap ----------------------
window.wirepeek?.onConfig?.(({ targetUrl }) => {
  addTab(targetUrl || "https://www.google.com");
  renderCaptureState();
  updateNavButtons();
});

// fallback se preload não mandar nada
if (!window.wirepeek) {
  addTab("https://www.google.com");
  renderCaptureState();
  updateNavButtons();
}

// ---------------------- Atalhos ----------------------
document.addEventListener("keydown",(e)=>{
  if (e.ctrlKey && e.key.toLowerCase()==="t"){ e.preventDefault(); addTab("https://www.google.com"); }
  if (e.ctrlKey && e.key.toLowerCase()==="w"){ e.preventDefault(); if (activeId!=null) closeTab(activeId); }
  if (e.ctrlKey && e.key.toLowerCase()==="l"){ e.preventDefault(); address.select(); }
});
