/* eslint-env browser */
import { el } from "./dom.js";

const svg = {
    google: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#4285F4" d="M21.8 10.23h-9.6v3.54h5.6c-.24 1.43-1.68 4.2-5.6 4.2-3.37 0-6.13-2.78-6.13-6.2s2.76-6.2 6.13-6.2c1.92 0 3.2.82 3.94 1.52l2.68-2.6C17.18 2.32 15.07 1.3 12.2 1.3 6.98 1.3 2.7 5.58 2.7 10.77S6.98 20.23 12.2 20.23c7.34 0 9.1-6.17 8.6-9.99z"/></svg>',
    ddg: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#DE5833" d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><path fill="#fff" d="M9.4 8.4c.6-1.3 2-2.2 3.6-2.2 1.9 0 3.5 1.3 3.8 3.1.2 1.1-.2 1.5-.7 1.5-.7 0-.9-.6-1-1-.2-.8-.8-1.4-1.7-1.4-1.2 0-2 .9-2 2.1v5.7h-2V8.4z"/></svg>',
    bing: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#008373" d="M7 2l4.7 1.7v10.1L17 16l-6 3.7L7 17V2z"/></svg>',
    brave: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="#fb542b" d="M12 2l6 2 2 6-8 12L4 10l2-6 6-2z"/></svg>',
    startpage: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#4b6cfb"/><path fill="#fff" d="M8 12h8v2H8zM8 9h8v2H8z"/></svg>',
    ecosia: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10" fill="#23b05b"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>',
};

const ENGINES = [
    { id: "google", label: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`, icon: svg.google },
    { id: "duckduckgo", label: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, icon: svg.ddg },
    { id: "bing", label: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, icon: svg.bing },
    { id: "brave", label: "Brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, icon: svg.brave },
    { id: "startpage", label: "Startpage", url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}`, icon: svg.startpage },
    { id: "ecosia", label: "Ecosia", url: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}`, icon: svg.ecosia },
];

let engineIdx = (() => {
    const id = localStorage.getItem("searchEngine") || "google";
    const i = ENGINES.findIndex(e => e.id === id);
    return i >= 0 ? i : 0;
})();

function updateBtn() {
    if (!el.engineBtn) return;
    el.engineBtn.textContent = `${ENGINES[engineIdx].label} ▾`;
    el.engineBtn.title = `Motor de busca: ${ENGINES[engineIdx].label} (Alt+S alterna)`;
}

/* ===== Dropdown ===== */
let menuEl = null;

function closeMenu() {
    if (!menuEl) return;
    menuEl.remove(); menuEl = null;
    window.removeEventListener("click", onGlobalClick, true);
    window.removeEventListener("keydown", onMenuKeydown, true);
    window.removeEventListener("resize", closeMenu, true);
    window.removeEventListener("scroll", closeMenu, true);
}
function onGlobalClick(ev) {
    if (!menuEl) return;
    if (ev.target === el.engineBtn || menuEl.contains(ev.target)) return;
    closeMenu();
}
function onMenuKeydown(ev) {
    if (!menuEl) return;
    const items = [...menuEl.querySelectorAll(".engine-item")];
    let idx = items.findIndex(i => i.getAttribute("aria-checked") === "true");
    if (idx < 0) idx = 0;

    if (ev.key === "Escape") { closeMenu(); return; }
    if (ev.key === "ArrowDown") { ev.preventDefault(); idx = Math.min(items.length - 1, idx + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); idx = Math.max(0, idx - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); items[idx]?.click(); return; }
    else return;

    items.forEach(i => i.setAttribute("aria-checked", "false"));
    items[idx].setAttribute("aria-checked", "true");
    items[idx].focus();
}

function openMenu() {
    closeMenu();
    if (!el.engineBtn) return;

    const rect = el.engineBtn.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "engine-menu";
    menu.style.top = rect.bottom + 6 + "px";
    menu.style.left = Math.max(8, Math.min(window.innerWidth - 260, rect.left)) + "px";
    menu.setAttribute("role", "menu");

    ENGINES.forEach((eng, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "engine-item";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", i === engineIdx ? "true" : "false");
        item.innerHTML = `
      <span class="ico">${eng.icon}</span>
      <span class="lbl">${eng.label}</span>
      <span class="tick">✓</span>
    `;
        item.addEventListener("click", () => {
            engineIdx = i;
            localStorage.setItem("searchEngine", eng.id);
            updateBtn();
            closeMenu();
        });
        menu.appendChild(item);
    });

    document.body.appendChild(menu);
    menuEl = menu;

    // foco inicial
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector(".engine-item"))?.focus();

    // listeners globais
    window.addEventListener("click", onGlobalClick, true);
    window.addEventListener("keydown", onMenuKeydown, true);
    window.addEventListener("resize", closeMenu, true);
    window.addEventListener("scroll", closeMenu, true);
}

export function initEngines() {
    if (!el.engineBtn) return;
    updateBtn();

    // clique abre dropdown (não alterna mais)
    el.engineBtn.addEventListener("click", (e) => { e.preventDefault(); openMenu(); });

    // atalho Alt+S ainda alterna rápido
    window.addEventListener("keydown", (e) => {
        if (e.altKey && e.key.toLowerCase() === "s") {
            e.preventDefault();
            engineIdx = (engineIdx + 1) % ENGINES.length;
            localStorage.setItem("searchEngine", ENGINES[engineIdx].id);
            updateBtn();
        }
    });
}

export function resolveInputToUrlOrSearch(raw) {
    const text = (raw || "").trim();
    if (!text) return "";
    // URL?
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(text)) return text;
    if (!/\s/.test(text) && (/\./.test(text) || /^localhost(:\d+)?$/.test(text))) return `https://${text}`;
    // Busca no engine atual
    return ENGINES[engineIdx].url(text);
}
