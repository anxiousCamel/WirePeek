import { el } from "./dom.js";

let capturing = false;

function render() {
    el.btnCap.classList.toggle("cap-on", capturing);
    el.btnCap.classList.toggle("cap-off", !capturing);
    el.btnCap.setAttribute("aria-pressed", capturing ? "true" : "false");
}

export function initCapture() {
    // estado inicial
    window.addEventListener("DOMContentLoaded", async () => {
        try {
            const s = await window.wirepeek?.getState?.();
            capturing = !!s?.capturing; render();
        } catch { /* ignore */ }
        window.wirepeek?.onState?.((s) => { capturing = !!s.capturing; render(); });
    });

    // clique
    el.btnCap.addEventListener("click", async () => {
        try {
            const s = capturing ? await window.wirepeek?.stop?.() : await window.wirepeek?.start?.();
            capturing = !!s?.capturing; render();
        } catch (e) { console.error("[cap] erro:", e); }
    });
}
