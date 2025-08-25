import { el} from "./dom.js";
import { applyChromeTheme, cssColorToHex, suitableInk, NEUTRAL_FALLBACK } from "./color.js";

let nextId = 1;
const tabs = new Map();      // id -> { id, tabEl, viewEl, title, url, color, ink }
const order = [];            // ids na ordem visual
let activeId = null;

export const state = {
    get activeId() { return activeId; },
    currentView() { const t = tabs.get(activeId); return t?.viewEl || null; },
    updateNavButtons() {
        try { const v = this.currentView(); el.btnBack.disabled = !v?.canGoBack(); el.btnFwd.disabled = !v?.canGoForward(); }
        catch { /* no-op */ }
    }
};

function paintTab(tab) {
    const eltab = tab.tabEl; if (!eltab) return;
    eltab.style.setProperty("--tab-col", tab.color || NEUTRAL_FALLBACK);
    eltab.style.setProperty("--tab-ink", tab.ink || "#ffffff");
    eltab.style.color = tab.ink || "#ffffff";
}

function updateTabTitleAndFavicon(tab, url, title) {
    const tabEl = tab.tabEl;
    tabEl.querySelector(".title").textContent = title || url || "Nova guia";
    try {
        const u = new URL(url); tabEl.querySelector(".fav").src = `${u.origin}/favicon.ico`;
    } catch { tabEl.querySelector(".fav").src = "favicon.ico"; }
}

function applyIframeFullSize(webviewEl) {
    if (!webviewEl) return;
    const STYLE = "flex:1 1 auto;height:100%;width:100%;border:0px;";
    const tryApply = () => {
        const shadow = webviewEl.shadowRoot; if (!shadow) return false;
        const iframe = shadow.querySelector("iframe"); if (!iframe) return false;
        iframe.setAttribute("style", STYLE); return true;
    };
    if (tryApply()) return;
    const id = setInterval(() => { if (tryApply()) clearInterval(id); }, 30);
    setTimeout(() => clearInterval(id), 3000);
}
function bindIframeFullSizeHooks(webviewEl) {
    if (!webviewEl) return;
    const apply = () => applyIframeFullSize(webviewEl);
    webviewEl.addEventListener("dom-ready", apply);
    webviewEl.addEventListener("did-attach", apply);
    webviewEl.addEventListener("did-stop-loading", apply);
    apply();
}

function createTabEl(tab) {
    const eltab = document.createElement("div");
    eltab.className = "tab"; eltab.draggable = true; eltab.dataset.id = String(tab.id);
    eltab.innerHTML = `<img class="fav" alt=""><div class="title">Nova guia</div><button class="close" title="Fechar">✕</button>`;
    eltab.onclick = (e) => { if (e.target.closest(".close")) return; activateTab(tab.id); };
    eltab.querySelector(".close").onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };

    // DnD
    eltab.addEventListener("dragstart", (e) => {
        eltab.classList.add("drag-ghost");
        e.dataTransfer.setData("text/plain", String(tab.id)); e.dataTransfer.effectAllowed = "move";
    });
    eltab.addEventListener("dragend", () => eltab.classList.remove("drag-ghost"));
    eltab.addEventListener("dragover", (e) => {
        e.preventDefault();
        const r = eltab.getBoundingClientRect(); const before = (e.clientX - r.left) < r.width / 2;
        eltab.classList.toggle("drop-before", before); eltab.classList.toggle("drop-after", !before);
    });
    eltab.addEventListener("dragleave", () => eltab.classList.remove("drop-before", "drop-after"));
    eltab.addEventListener("drop", (e) => {
        e.preventDefault(); eltab.classList.remove("drop-before", "drop-after");
        const fromId = Number(e.dataTransfer.getData("text/plain"));
        const toId = Number(eltab.dataset.id);
        const r = eltab.getBoundingClientRect();
        const before = (e.clientX - r.left) < r.width / 2;
        reorderTab(fromId, toId, before ? "before" : "after");
    });
    return eltab;
}

function createWebview(tab, url) {
    const view = document.createElement("webview");
    view.setAttribute("allowpopups", "");
    const wvPreload = window.__wvPreloadPath || "";
    if (wvPreload) view.setAttribute("preload", wvPreload);
    view.setAttribute("data-managed-size", ""); view.setAttribute("width", "0"); view.setAttribute("height", "0");
    view.src = url || "https://www.google.com";

    view.addEventListener("ipc-message", (e) => {
        const { channel, args } = e; if (!channel?.startsWith("cap:")) return;
        window.wirepeek?.emitCapture?.(channel, args?.[0] ?? {});
    });

    view.addEventListener("did-start-loading", () => el.btnReload.classList.add("loading"));
    view.addEventListener("did-stop-loading", () => el.btnReload.classList.remove("loading"));

    const sync = () => {
        const u = (view.getURL && view.getURL()) || tab.url;
        const t = (view.getTitle && view.getTitle()) || tab.title || u || "Nova guia";
        tab.url = u; tab.title = t;
        if (tab.id === activeId) el.address.value = u || "";
        updateTabTitleAndFavicon(tab, u, t);
        state.updateNavButtons();
    };
    ["did-navigate", "did-navigate-in-page", "page-title-updated"].forEach(ev => view.addEventListener(ev, sync));

    // Tema adaptativo: tenta meta theme-color / background visível
    const applyThemeColor = async () => {
        try {
            const picked = await view.executeJavaScript(`(()=>{const m=document.querySelector('meta[name="theme-color"]');if(m?.content)return m.content;const x=Math.max(1,Math.floor(innerWidth/2));const y=1;let el=elementFromPoint(x,y)||document.body||document.documentElement;const seen=new Set();while(el&&!seen.has(el)){seen.add(el);const cs=getComputedStyle(el);const bg=cs.backgroundColor||cs.background;if(bg&&bg!=="transparent"&&bg!=="rgba(0, 0, 0, 0)")return bg;el=el.parentElement||el.parentNode}const bb=getComputedStyle(document.body).backgroundColor;if(bb)return bb;const hb=getComputedStyle(document.documentElement).backgroundColor;if(hb)return hb;return null;})()`, true);
            const baseHex = cssColorToHex(picked) || NEUTRAL_FALLBACK;
            tab.color = baseHex; tab.ink = suitableInk(baseHex);
            paintTab(tab);
            if (tab.id === activeId) applyChromeTheme(baseHex);
        } catch {
            const base = NEUTRAL_FALLBACK;
            tab.color = base; tab.ink = suitableInk(base); paintTab(tab);
            if (tab.id === activeId) applyChromeTheme(base);
        }
    };
    view.addEventListener("did-finish-load", applyThemeColor);
    view.addEventListener("page-title-updated", applyThemeColor);
    view.addEventListener("did-navigate-in-page", applyThemeColor);

    bindIframeFullSizeHooks(view);
    view.addEventListener("dom-ready", () => window.__resizeWebviewsNow?.());

    return view;
}

export function addTab(url) {
    const id = nextId++;
    const tab = { id, title: "Nova guia", url: url || "", color: NEUTRAL_FALLBACK, ink: "#ffffff" };
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

export function activateTab(id) {
    if (activeId === id) return;
    if (activeId != null) {
        const old = tabs.get(activeId);
        if (old) { old.tabEl.classList.remove("active"); old.viewEl.classList.remove("active"); }
    }
    activeId = id;
    const t = tabs.get(id); if (!t) return;
    t.tabEl.classList.add("active"); t.viewEl.classList.add("active");
    el.address.value = t.url || "";
    state.updateNavButtons();
    paintTab(t);
    applyChromeTheme(t.color || NEUTRAL_FALLBACK);
}

export function closeTab(id) {
    const t = tabs.get(id); if (!t) return;
    t.tabEl.remove(); t.viewEl.remove();
    tabs.delete(id);
    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);
    if (order.length === 0) { addTab("https://www.google.com"); return; }
    if (activeId === id) {
        const next = order[Math.max(0, idx - 1)];
        activateTab(next);
    }
}

export function reorderTab(fromId, toId, where) {
    if (fromId === toId) return;
    const from = tabs.get(fromId), to = tabs.get(toId);
    if (!from || !to) return;

    if (where === "before") el.tabstrip.insertBefore(from.tabEl, to.tabEl);
    else el.tabstrip.insertBefore(from.tabEl, to.tabEl.nextSibling);

    if (where === "before") el.webviews.insertBefore(from.viewEl, to.viewEl);
    else el.webviews.insertBefore(from.viewEl, to.viewEl.nextSibling);

    const a = order.indexOf(fromId); if (a < 0) return;
    order.splice(a, 1);
    const b = order.indexOf(toId);
    order.splice(where === "before" ? b : b + 1, 0, fromId);
}
