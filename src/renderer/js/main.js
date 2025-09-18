// src/renderer/js/main.js
/* eslint-env browser */

/**
 * @file main.js (renderer)
 * @brief Bootstrap da UI principal.
 *
 * Responsabilidades:
 *  - Aplicar tema inicial (antes da 1ª aba) para evitar “flash”
 *  - Ligar controles de janela ao preload (min/max/close)
 *  - Navegação (omnibox, voltar/avançar/recarregar)
 *  - Criar a primeira aba a partir da config enviada pelo main
 *  - Inicializar módulos (motores de busca, captura)
 */

import { el } from "./dom.js";
import { initEngines, resolveInputToUrlOrSearch } from "./engines.js";
import { addTab, state, closeTab } from "./tabs.js";
import { initCapture } from "./capture.js";
import { applyChromeTheme, NEUTRAL_FALLBACK } from "./color.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Tema inicial (evita “flash” até a 1ª navegação)
 * ──────────────────────────────────────────────────────────────────────── */
applyChromeTheme(NEUTRAL_FALLBACK);

/* ──────────────────────────────────────────────────────────────────────────
 * Controles de janela (via preload → IPC)
 * ──────────────────────────────────────────────────────────────────────── */

// Botões podem não existir (builds sem moldura nativa, etc.) → use ?.
el.winMin?.addEventListener("click", () => window.win?.minimize());
el.winClose?.addEventListener("click", () => window.win?.close());
el.winMax?.addEventListener("click", async () => {
    const res = await window.win?.toggleMaximize();
    if (res && "maximized" in res) setMaxButtonIcon(res.maximized);
});

// Atualiza ícone quando o main avisa mudança de maximização
window.win?.onMaximizedChange?.((isMax) => setMaxButtonIcon(isMax));
function setMaxButtonIcon(isMax) {
    const b = el.winMax;
    if (!b) return;
    // ❐ = restaurar, 🗖 = maximizar (troca conforme estado atual)
    b.textContent = isMax ? "❐" : "🗖";
}

// Duplo clique na titlebar alterna maximizar/restaurar (UX padrão)
document.querySelector("header.titlebar")?.addEventListener("dblclick", () => {
    void window.win?.toggleMaximize();
});

/* ──────────────────────────────────────────────────────────────────────────
 * Navegação (omnibox e botões)
 * ──────────────────────────────────────────────────────────────────────── */

// cria nova aba
el.btnNewTab?.addEventListener("click", () => {
    addTab(
        "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2"
    );
});

async function goFromAddress() {
    const value = el.address?.value ?? "";
    const url = resolveInputToUrlOrSearch(value);
    if (!url) return;
    const view = state.currentView();
    try {
        view?.loadURL(url);
    } catch {
        /* noop */
    }
}
el.btnGo?.addEventListener("click", goFromAddress);
el.address?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goFromAddress();
});

el.btnBack?.addEventListener("click", () => state.currentView()?.goBack());
el.btnFwd?.addEventListener("click", () => state.currentView()?.goForward());
el.btnReload?.addEventListener("click", () => state.currentView()?.reload());

/* ──────────────────────────────────────────────────────────────────────────
 * Atalhos de teclado
 * ──────────────────────────────────────────────────────────────────────── */
document.addEventListener("keydown", (e) => {
    const k = e.key?.toLowerCase?.() || "";
    // nova aba
    if (e.ctrlKey && k === "t") {
        e.preventDefault();
        el.btnNewTab?.click();
    }
    // fechar aba
    if (e.ctrlKey && k === "w") {
        e.preventDefault();
        if (state.activeId != null) closeTab(state.activeId);
    }
    // focar omnibox
    if ((e.ctrlKey || e.metaKey) && k === "l") {
        e.preventDefault();
        el.address?.focus();
        el.address?.select();
    }
});

/* ──────────────────────────────────────────────────────────────────────────
 * Bootstrap (1ª aba)
 *  - Em runtime “normal”, o main envia ui:config com targetUrl.
 *  - Se estiver abrindo o HTML direto (sem preload), fazemos um fallback.
 * ──────────────────────────────────────────────────────────────────────── */
window.wirepeek?.onConfig?.(({ targetUrl }) => {
    addTab(
        targetUrl ||
        "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2"
    );
    state.updateNavButtons();
});

// Fallback quando não houver preload (ex.: abrir HTML direto no navegador)
if (!window.wirepeek) {
    el.btnNewTab?.click();
    state.updateNavButtons();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Inicialização de módulos opcionais
 * ──────────────────────────────────────────────────────────────────────── */
initEngines();
initCapture();

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers de debug (opcionais)
 * ──────────────────────────────────────────────────────────────────────── */
// Ex.: no console da UI, chame window.debugActiveUrl()
try {
    window.debugActiveUrl = () => state.currentView()?.getURL?.() || null;
} catch {
    /* noop */
}
