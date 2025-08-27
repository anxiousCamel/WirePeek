// src/renderer/js/tabs.js
/* eslint-env browser */
/**
 * @file tabs.js
 * @brief Gerencia as guias (tabs) e respectivos <webview>s da UI.
 *
 * Responsabilidades:
 *  - Criar/fechar/ativar/reordenar abas
 *  - Manter o <webview> sempre ocupando a área útil
 *  - Sincronizar título, favicon e barra de endereço
 *  - Adaptar tema (cores) a partir do site ativo
 *  - Encaminhar eventos de captura vindos do guest (webview → main)
 */

import { el } from "./dom.js";
import {
    applyChromeTheme,
    cssColorToHex,
    suitableInk,
    NEUTRAL_FALLBACK,
} from "./color.js";

/** @const {string} URL padrão para a primeira navegação */
const START_URL =
    "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2";

/** Script injetado no guest para “adivinhar” a cor base do site */
const THEME_PROBE_SCRIPT = `
(() => {
  // 1) meta theme-color
  const m = document.querySelector('meta[name="theme-color"]');
  if (m && m.content) return m.content;

  // 2) pixel da chrome-area (metade superior da página)
  const x = Math.max(1, Math.floor(innerWidth / 2));
  const y = 1;
  let el = document.elementFromPoint(x, y) || document.body || document.documentElement;

  // 3) sobe na árvore procurando um background não-transparente
  const seen = new Set();
  while (el && !seen.has(el)) {
    seen.add(el);
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor || cs.background;
    if (bg && bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") return bg;
    el = el.parentElement || el.parentNode;
  }

  // 4) fallback body / html
  const bb = getComputedStyle(document.body).backgroundColor;
  if (bb) return bb;
  const hb = getComputedStyle(document.documentElement).backgroundColor;
  if (hb) return hb;

  return null;
})
`;

/* ──────────────────────────────────────────────
 * Estado
 * ──────────────────────────────────────────── */

let nextId = 1;
/** @type {Map<number, {id:number, tabEl:HTMLElement, viewEl<HTMLElement>, title:string, url:string, color:string, ink:string}>} */
const tabs = new Map();
/** @type {number[]} */
const order = [];
/** @type {number|null} */
let activeId = null;

/**
 * Estado público da barra (para outros módulos).
 * @namespace state
 */
export const state = {
    /** @returns {number|null} id da guia ativa */
    get activeId() {
        return activeId;
    },

    /** @returns {Electron.WebviewTag|null} o webview da guia ativa */
    currentView() {
        const t = tabs.get(activeId);
        return t?.viewEl || null;
    },

    /** Atualiza botões Voltar/Avançar baseado no histórico do webview ativo. */
    updateNavButtons() {
        try {
            const v = this.currentView();
            el.btnBack.disabled = !v?.canGoBack();
            el.btnFwd.disabled = !v?.canGoForward();
        } catch {
            /* noop */
        }
    },
};

/* ──────────────────────────────────────────────
 * Helpers visuais
 * ──────────────────────────────────────────── */

/**
 * Pinta a aba com as cores atuais do site.
 * @param {object} tab
 */
function paintTab(tab) {
    const eltab = tab.tabEl;
    if (!eltab) return;
    eltab.style.setProperty("--tab-col", tab.color || NEUTRAL_FALLBACK);
    eltab.style.setProperty("--tab-ink", tab.ink || "#ffffff");
    eltab.style.color = tab.ink || "#ffffff";
}

/**
 * Atualiza o título e favicon exibidos na aba.
 * @param {object} tab
 * @param {string} url
 * @param {string} title
 */
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
 * Força o <iframe> interno do <webview> a ocupar 100% (aplica direto no shadow DOM).
 * @param {Electron.WebviewTag} webviewEl
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

/**
 * Reaplica o ajuste de tamanho em eventos que o webview emite.
 * @param {Electron.WebviewTag} webviewEl
 */
function bindIframeFullSizeHooks(webviewEl) {
    if (!webviewEl) return;
    const apply = () => applyIframeFullSize(webviewEl);
    webviewEl.addEventListener("dom-ready", apply);
    webviewEl.addEventListener("did-attach", apply);
    webviewEl.addEventListener("did-stop-loading", apply);
    apply();
}

/* ──────────────────────────────────────────────
 * Criação de elementos
 * ──────────────────────────────────────────── */

/**
 * Cria o elemento visual da aba (na strip).
 * @param {{id:number}} tab
 * @returns {HTMLDivElement}
 */
function createTabEl(tab) {
    const eltab = document.createElement("div");
    eltab.className = "tab";
    eltab.draggable = true;
    eltab.dataset.id = String(tab.id);
    eltab.innerHTML =
        `<img class="fav" alt="">
     <div class="title">Nova guia</div>
     <button class="close" title="Fechar">✕</button>`;

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

/**
 * Aplica a cor de tema detectada ao objeto de tab e à UI.
 * @param {Electron.WebviewTag} view
 * @param {object} tab
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

/**
 * Cria o <webview> para uma aba.
 * - Usa a mesma session (partition) do app principal;
 * - Só define `src` depois de `partition` e `preload`;
 * - Encaminha eventos de captura (cap:*) do guest para o main.
 *
 * @param {{id:number,title:string,url:string,color:string,ink:string}} tab
 * @param {string} url
 * @returns {Electron.WebviewTag}
 */
function createWebview(tab, url) {
    /** @type {Electron.WebviewTag} */
    const view = document.createElement("webview");
    view.setAttribute("allowpopups", "");
    view.setAttribute("data-managed-size", "");
    view.setAttribute("width", "0");
    view.setAttribute("height", "0");

    // ⭐ Mesma session (partition) da janela principal (ex.: "persist:wirepeek")
    const part = window.__wvPartition || "persist:wirepeek";
    view.setAttribute("partition", part);

    // ⭐ Preload do webview (file://...); o onConfig do preload principal define window.__wvPreloadPath
    const wvPreload = window.__wvPreloadPath || "";
    if (!wvPreload) {
        console.warn(
            "[webview] preload path vazio; eventos de captura não serão emitidos"
        );
    } else {
        view.setAttribute("preload", wvPreload);
    }

    // src sempre por último
    view.src = url || START_URL;

    // Debug do console do guest no host
    view.addEventListener("console-message", (e) => {
        console.debug(`[guest console] ${e.message}`);
    });

    // Eventos de captura enviados pelo guest → main
    view.addEventListener("ipc-message", (e) => {
        const { channel, args } = e;
        if (!channel || typeof channel !== "string") return;
        if (!channel.startsWith("cap:")) return;
        window.wirepeek?.emitCapture?.(channel, args?.[0] ?? {});
    });

    // UI de loading
    view.addEventListener("did-start-loading", () =>
        el.btnReload.classList.add("loading")
    );
    view.addEventListener("did-stop-loading", () =>
        el.btnReload.classList.remove("loading")
    );

    // Sincronização de URL/título
    const sync = () => {
        try {
            const u =
                (typeof view.getURL === "function" ? view.getURL() : tab.url) || tab.url;
            const t =
                (typeof view.getTitle === "function" ? view.getTitle() : tab.title) ||
                tab.title ||
                u ||
                "Nova guia";
            tab.url = u;
            tab.title = t;
            if (tab.id === activeId) el.address.value = u || "";
            updateTabTitleAndFavicon(tab, u, t);
            state.updateNavButtons();
        } catch {
            /* noop */
        }
    };
    ["did-navigate", "did-navigate-in-page", "page-title-updated"].forEach((ev) =>
        view.addEventListener(ev, sync)
    );

    // Tema adaptativo
    view.addEventListener("did-finish-load", () =>
        applyThemeColorToTab(view, tab).catch(() => { })
    );
    view.addEventListener("page-title-updated", () =>
        applyThemeColorToTab(view, tab).catch(() => { })
    );
    view.addEventListener("did-navigate-in-page", () =>
        applyThemeColorToTab(view, tab).catch(() => { })
    );

    // Ocupa 100% da área útil
    bindIframeFullSizeHooks(view);
    view.addEventListener("dom-ready", () => window.__resizeWebviewsNow?.());

    return view;
}

/* ──────────────────────────────────────────────
 * API pública
 * ──────────────────────────────────────────── */

/**
 * Cria uma nova aba e a ativa.
 * @param {string} url
 * @returns {number} id da aba criada
 */
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

/**
 * Ativa a aba indicada.
 * @param {number} id
 */
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
}

/**
 * Fecha a aba indicada.
 * - Se for a ativa, ativa a anterior (ou cria uma nova se for a última).
 * @param {number} id
 */
export function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;

    t.tabEl.remove();
    t.viewEl.remove();
    tabs.delete(id);

    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);

    if (order.length === 0) {
        addTab("https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2");
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
    const from = tabs.get(fromId),
        to = tabs.get(toId);
    if (!from || !to) return;

    // Strip
    if (where === "before")
        el.tabstrip.insertBefore(from.tabEl, to.tabEl);
    else el.tabstrip.insertBefore(from.tabEl, to.tabEl.nextSibling);

    // Webviews
    if (where === "before")
        el.webviews.insertBefore(from.viewEl, to.viewEl);
    else el.webviews.insertBefore(from.viewEl, to.viewEl.nextSibling);

    // Ordem lógica
    const a = order.indexOf(fromId);
    if (a < 0) return;
    order.splice(a, 1);
    const b = order.indexOf(toId);
    order.splice(where === "before" ? b : b + 1, 0, fromId);
}
