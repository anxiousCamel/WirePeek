import { el} from "./dom.js";
import { initEngines, resolveInputToUrlOrSearch } from "./engines.js";
import { addTab, state, closeTab } from "./tabs.js";
import { initCapture } from "./capture.js";

// window controls
el.winMin.onclick = () => window.win?.minimize();
el.winClose.onclick = () => window.win?.close();
el.winMax.onclick = async () => {
    const res = await window.win?.toggleMaximize();
    if (res && "maximized" in res) setMaxButtonIcon(res.maximized);
};
window.win?.onMaximizedChange?.((isMax) => setMaxButtonIcon(isMax));
function setMaxButtonIcon(isMax) { const b = el.winMax; if (!b) return; b.textContent = isMax ? "❐" : "🗖"; }

// eventos básicos
el.btnNewTab.onclick = () => addTab("https://www.google.com");

async function goFromAddress() {
    const url = resolveInputToUrlOrSearch(el.address.value);
    if (!url) return;
    const view = state.currentView();
    if (view) view.loadURL(url);
}
el.btnGo.onclick = goFromAddress;
el.address.addEventListener("keydown", (e) => e.key === "Enter" && goFromAddress());

el.btnBack.onclick = () => state.currentView()?.goBack();
el.btnFwd.onclick = () => state.currentView()?.goForward();
el.btnReload.onclick = () => state.currentView()?.reload();

// atalhos
document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === "t") { e.preventDefault(); addTab("https://www.google.com"); }
    if (e.ctrlKey && k === "w") { e.preventDefault(); if (state.activeId != null) closeTab(state.activeId); }
    if ((e.ctrlKey || e.metaKey) && k === "l") { e.preventDefault(); el.address.focus(); el.address.select(); }
});

// bootstrap (start tab)
window.wirepeek?.onConfig?.(({ targetUrl }) => {
    addTab(targetUrl || "https://www.google.com");
    state.updateNavButtons();
});
if (!window.wirepeek) { addTab("https://www.google.com"); state.updateNavButtons(); }

// módulos opcionais
initEngines();
initCapture();
