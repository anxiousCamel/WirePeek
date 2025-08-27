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
el.btnNewTab.onclick = () => addTab("https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2");

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
    if (e.ctrlKey && k === "t") { e.preventDefault(); addTab("https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2"); }
    if (e.ctrlKey && k === "w") { e.preventDefault(); if (state.activeId != null) closeTab(state.activeId); }
    if ((e.ctrlKey || e.metaKey) && k === "l") { e.preventDefault(); el.address.focus(); el.address.select(); }
});

// bootstrap (start tab)
window.wirepeek?.onConfig?.(({ targetUrl }) => {
    addTab(targetUrl || "https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2");
    state.updateNavButtons();
});
if (!window.wirepeek) { addTab("https://www.startpage.com/do/mypage.pl?prfe=675ac300c7883b372bdef6447308d65a5b256c06ff6428a03e2b2dfc953937be198dbf6694c262e1de9988dc1255c9bff029ec42fe51adb3d956175a006d1f94f2fe7ea9e70939fb45969f46161728b2"); state.updateNavButtons(); }

// módulos opcionais
initEngines();
initCapture();
