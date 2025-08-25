import { el } from "./dom.js";

const ENGINES = [
    { id: "google", label: "Google", url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { id: "duckduckgo", label: "DuckDuckGo", url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
    { id: "bing", label: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { id: "brave", label: "Brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
    { id: "startpage", label: "Startpage", url: (q) => `https://www.startpage.com/sp/search?query=${encodeURIComponent(q)}` },
    { id: "ecosia", label: "Ecosia", url: (q) => `https://www.ecosia.org/search?q=${encodeURIComponent(q)}` },
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

export function initEngines() {
    if (!el.engineBtn) return; // nada a fazer (sem botão no HTML)
    updateBtn();

    el.engineBtn.addEventListener("click", () => {
        engineIdx = (engineIdx + 1) % ENGINES.length;
        localStorage.setItem("searchEngine", ENGINES[engineIdx].id);
        updateBtn();
    });

    el.engineBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = document.createElement("div");
        menu.className = "engine-menu";
        menu.style.top = e.clientY + "px";
        menu.style.left = e.clientX + "px";
        ENGINES.forEach((eng, i) => {
            const item = document.createElement("div");
            item.className = "engine-item" + (i === engineIdx ? " active" : "");
            item.textContent = eng.label;
            item.onclick = () => {
                engineIdx = i;
                localStorage.setItem("searchEngine", eng.id);
                updateBtn(); menu.remove();
            };
            menu.appendChild(item);
        });
        const close = () => { menu.remove(); window.removeEventListener("click", close, true); };
        window.addEventListener("click", close, true);
        document.body.appendChild(menu);
    });

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
    const looksLikeUrl = () => {
        if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(text)) return true;
        if (!/\s/.test(text) && (/\./.test(text) || /^localhost(:\d+)?$/.test(text))) return true;
        return false;
    };
    const toAbs = (s) => /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(s) ? s : `https://${s}`;

    if (looksLikeUrl()) return toAbs(text);
    return ENGINES[engineIdx].url(text);
}
