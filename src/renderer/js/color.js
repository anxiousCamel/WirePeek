import { setVars } from "./dom.js";

export const NEUTRAL_FALLBACK = "#24272b";

export function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
export function rgbToHex({ r, g, b }) {
    const to2 = (v) => v.toString(16).padStart(2, "0");
    return `#${to2(r)}${to2(g)}${to2(b)}`;
}
export function luminance({ r, g, b }) {
    const srgb = [r, g, b].map(v => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}
export function suitableInk(bgHex) {
    const rgb = hexToRgb(bgHex); if (!rgb) return "#ffffff";
    return luminance(rgb) > 0.45 ? "#111111" : "#ffffff";
}
export function mixHex(a, b, t) {
    const ca = hexToRgb(a), cb = hexToRgb(b); if (!ca || !cb) return a;
    const mix = (x, y) => Math.round(x * (1 - t) + y * t);
    return rgbToHex({ r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b) });
}
export function cssColorToHex(input) {
    if (!input) return null;
    const s = String(input).trim();
    const mhex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (mhex) {
        if (mhex[1].length === 3) {
            const [r, g, b] = mhex[1].split("");
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        return s.toLowerCase();
    }
    const mrgb = s.match(/^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(\d*\.?\d+))?\)$/i);
    if (mrgb) {
        const r = Math.max(0, Math.min(255, parseInt(mrgb[1], 10)));
        const g = Math.max(0, Math.min(255, parseInt(mrgb[2], 10)));
        const b = Math.max(0, Math.min(255, parseInt(mrgb[3], 10)));
        if (mrgb[4] != null) { const a = Math.max(0, Math.min(1, parseFloat(mrgb[4]))); if (a < 0.05) return null; }
        return rgbToHex({ r, g, b });
    }
    return null;
}

// aplica tema do chrome
export function applyChromeTheme(baseHex = NEUTRAL_FALLBACK) {
    const ink = suitableInk(baseHex);
    const lift = (ink === "#ffffff") ? "#ffffff" : "#000000";
    const push = (ink === "#ffffff") ? "#000000" : "#ffffff";

    const tabHover = mixHex(baseHex, lift, 0.08);
    const tabActive = mixHex(baseHex, lift, 0.12);

    const btnBg = mixHex(baseHex, push, 0.10);
    const btnHover = mixHex(btnBg, lift, 0.08);
    const btnInk = suitableInk(btnBg);
    const btnBorder = mixHex(btnBg, ink, 0.35);

    const fieldBg = mixHex(baseHex, push, 0.18);
    const fieldInk = suitableInk(fieldBg);
    const fieldBorder = mixHex(fieldBg, ink, 0.35);

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
