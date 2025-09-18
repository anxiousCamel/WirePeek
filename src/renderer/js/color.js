// src/renderer/js/color.js
/* eslint-env browser */
/**
 * @file color.js
 * @brief Utilitários de cor e aplicação de tema visual (Chrome-like).
 *
 * Observações:
 * - O preload principal deve expor window.win.setBackground(hex) → "ui:set-bg"
 *   para sincronizar a cor nativa da BrowserWindow no processo main.
 * - Este módulo apenas calcula e injeta CSS vars; quem decide *quando*
 *   aplicar é o gerenciador de abas (tabs.js), que chama applyChromeTheme
 *   quando o site ativo muda.
 */

import { setVars } from "./dom.js";

/** Cor neutra para fallback inicial e casos sem detecção. */
export const NEUTRAL_FALLBACK = "#24272b";

/* ───────────────────────── Helpers básicos ───────────────────────── */

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** @param {number} v → "00".."ff" */
function toHex2(v) { return clamp(v, 0, 255).toString(16).padStart(2, "0"); }

/** Normaliza #rgb → #rrggbb; mantém #rrggbb; retorna null se inválido. */
function normalizeHex(hex) {
    if (typeof hex !== "string") return null;
    const s = hex.trim().toLowerCase();
    const m3 = s.match(/^#([0-9a-f]{3})$/i);
    if (m3) {
        const [r, g, b] = m3[1];
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    const m6 = s.match(/^#([0-9a-f]{6})$/i);
    return m6 ? s : null;
}

/* ───────────────────────── Conversões e métricas ───────────────────────── */

/** @typedef {{r:number,g:number,b:number}} Rgb */

/** @param {string} hex "#rrggbb" | "#rgb" */
export function hexToRgb(hex) {
    const h = normalizeHex(hex);
    if (!h) return null;
    return {
        r: parseInt(h.slice(1, 3), 16),
        g: parseInt(h.slice(3, 5), 16),
        b: parseInt(h.slice(5, 7), 16),
    };
}

/** @param {Rgb} p */
export function rgbToHex({ r, g, b }) {
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
}

/** Luminância relativa (WCAG) de um RGB 0..255 */
export function luminance({ r, g, b }) {
    const lin = [r, g, b].map(v => {
        const x = clamp(v, 0, 255) / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Contraste (ratio) entre duas cores HEX (#rrggbb). Maior é melhor. */
export function contrastRatio(hexA, hexB) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    if (!a || !b) return 1;
    const L1 = luminance(a), L2 = luminance(b);
    const [lo, hi] = L1 < L2 ? [L1, L2] : [L2, L1];
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * Escolhe cor de texto (tinta) apropriada para um fundo.
 * Heurística + verificação de contraste contra branco/preto.
 * @param {string} bgHex
 * @returns {"#ffffff"|"#111111"}
 */
export function suitableInk(bgHex) {
    const rgb = hexToRgb(bgHex);
    if (!rgb) return "#ffffff";
    const heuristic = luminance(rgb) > 0.45 ? "#111111" : "#ffffff";
    const other = heuristic === "#ffffff" ? "#111111" : "#ffffff";
    const c1 = contrastRatio(bgHex, heuristic);
    const c2 = contrastRatio(bgHex, other);
    return c1 >= 4.5 || c1 >= c2 ? heuristic : other; // 4.5:1 alvo comum
}

/**
 * Mistura linear de duas cores HEX.
 * @param {string} a "#rrggbb"
 * @param {string} b "#rrggbb"
 * @param {number} t 0..1 (0 = a, 1 = b)
 */
export function mixHex(a, b, t) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    if (!ca || !cb) return normalizeHex(a) || NEUTRAL_FALLBACK;
    const mix = (x, y) => Math.round(x * (1 - t) + y * t);
    return rgbToHex({ r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b) });
}

/* ───────────────────────── Parser de cores CSS ───────────────────────── */

/**
 * Parser tolerante: converte strings CSS comuns para HEX #rrggbb.
 * Suporta:
 *  - "#rgb" / "#rrggbb"
 *  - "rgb(r,g,b)" / "rgba(r,g,b,a)"  (vírgulas)
 *  - "rgb(r g b / a)"                (espaços + barra, CSS Color 4)
 *  - "hsl(h,s%,l%)" / "hsla(...)"    (vírgulas)
 *  - "hsl(h s% l% / a)"              (espaços + barra)
 *  - *named colors* (ex.: "rebeccapurple") via engine do navegador
 * Transparências muito baixas (a < 0.05) → null.
 * @param {string} input
 * @returns {string|null} "#rrggbb" ou null
 */
export function cssColorToHex(input) {
    if (!input) return null;
    const s = String(input).trim();

    // 1) HEX (#rgb / #rrggbb)
    const h = normalizeHex(s);
    if (h) return h;

    // 2) rgb/rgba com vírgulas: rgb(12, 34, 56) / rgba(12, 34, 56, .5)
    let m = s.match(/^rgba?\(\s*(-?\d{1,3})\s*,\s*(-?\d{1,3})\s*,\s*(-?\d{1,3})(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i);
    if (m) {
        const r = clamp(parseInt(m[1], 10), 0, 255);
        const g = clamp(parseInt(m[2], 10), 0, 255);
        const b = clamp(parseInt(m[3], 10), 0, 255);
        if (m[4] != null) { const a = clamp(parseFloat(m[4]), 0, 1); if (a < 0.05) return null; }
        return rgbToHex({ r, g, b });
    }

    // 3) rgb “CSS4” com espaços e barra: rgb(12 34 56 / .5)
    m = s.match(/^rgba?\(\s*(-?\d{1,3})\s+(-?\d{1,3})\s+(-?\d{1,3})(?:\s*\/\s*([0-9]*\.?[0-9]+))?\s*\)$/i);
    if (m) {
        const r = clamp(parseInt(m[1], 10), 0, 255);
        const g = clamp(parseInt(m[2], 10), 0, 255);
        const b = clamp(parseInt(m[3], 10), 0, 255);
        if (m[4] != null) { const a = clamp(parseFloat(m[4]), 0, 1); if (a < 0.05) return null; }
        return rgbToHex({ r, g, b });
    }

    // 4) hsl/hsla com vírgulas: hsl(210, 50%, 40%) / hsla(210, 50%, 40%, .5)
    m = s.match(/^hsla?\(\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)%\s*,\s*(-?\d*\.?\d+)%(?:\s*,\s*([0-9]*\.?[0-9]+))?\s*\)$/i);
    if (m) {
        return hslToHex(m[1], m[2], m[3], m[4]);
    }

    // 5) hsl “CSS4” com espaços e barra: hsl(210 50% 40% / .5)
    m = s.match(/^hsla?\(\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)%\s+(-?\d*\.?\d+)%(?:\s*\/\s*([0-9]*\.?[0-9]+))?\s*\)$/i);
    if (m) {
        return hslToHex(m[1], m[2], m[3], m[4]);
    }

    // 6) named colors: deixa o engine do navegador resolver
    // (ex.: "rebeccapurple" → rgb(...) resolvido por getComputedStyle)
    try {
        const probe = document.createElement("span");
        probe.style.color = s;
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color; // "rgb(r, g, b)" se válido
        document.body.removeChild(probe);
        return cssColorToHex(resolved);
    } catch {
        /* noop */
    }

    return null;
}

/** Converte HSL (strings) para HEX, respeitando alpha. */
function hslToHex(hStr, sStr, lStr, aStr) {
    let h = parseFloat(hStr);
    const ss = clamp(parseFloat(sStr), 0, 100) / 100;
    const ll = clamp(parseFloat(lStr), 0, 100) / 100;
    if (aStr != null) { const a = clamp(parseFloat(aStr), 0, 1); if (a < 0.05) return null; }
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * ll - 1)) * ss;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m0 = ll - c / 2;
    let rp = 0, gp = 0, bp = 0;
    if (h < 60) { rp = c; gp = x; bp = 0; }
    else if (h < 120) { rp = x; gp = c; bp = 0; }
    else if (h < 180) { rp = 0; gp = c; bp = x; }
    else if (h < 240) { rp = 0; gp = x; bp = c; }
    else if (h < 300) { rp = x; gp = 0; bp = c; }
    else { rp = c; gp = 0; bp = x; }
    return rgbToHex({
        r: Math.round((rp + m0) * 255),
        g: Math.round((gp + m0) * 255),
        b: Math.round((bp + m0) * 255),
    });
}

/* ───────────────────────── Tema (Chrome-like) ───────────────────────── */

/** micro-cache pra evitar reaplicar o mesmo tema desnecessariamente */
let __lastApplied = "";

/**
 * Aplica tema global (CSS variables) a partir de uma cor base
 * e sincroniza a cor nativa da janela via window.win.setBackground(hex).
 *
 * @param {string} [baseHex=NEUTRAL_FALLBACK] cor base (aceita #rgb/#rrggbb)
 */
export function applyChromeTheme(baseHex = NEUTRAL_FALLBACK) {
    const base = normalizeHex(baseHex) || NEUTRAL_FALLBACK;

    // evita trabalho quando a cor não mudou
    if (base === __lastApplied) return;
    __lastApplied = base;

    // Escolhas de tinta/auxiliares a partir do background
    const ink = suitableInk(base);
    const lift = (ink === "#ffffff") ? "#ffffff" : "#000000"; // clarear/escurecer levemente
    const push = (ink === "#ffffff") ? "#000000" : "#ffffff"; // contraste "oposto"

    // Cores derivadas para UI (tabs, botões, campos, bordas)
    const tabHover = mixHex(base, lift, 0.08);
    const tabActive = mixHex(base, lift, 0.12);

    const btnBg = mixHex(base, push, 0.10);
    const btnHover = mixHex(btnBg, lift, 0.08);
    const btnInk = suitableInk(btnBg);
    const btnBorder = mixHex(btnBg, ink, 0.35);

    const fieldBg = mixHex(base, push, 0.18);
    const fieldInk = suitableInk(fieldBg);
    const fieldBorder = mixHex(fieldBg, ink, 0.35);

    const chromeBorder = mixHex(base, ink, 0.30);

    // 🔴 também setamos --win-bg, pois html/body usam isso como fundo
    setVars({
        "--win-bg": base,

        "--chrome-bg": base,
        "--chrome-ink": ink,
        "--chrome-border": chromeBorder,

        "--tab-bg": base,
        "--tab-hover": tabHover,
        "--tab-active": tabActive,

        "--btn-bg": btnBg,
        "--btn-ink": btnInk,
        "--btn-hover": btnHover,
        "--btn-border": btnBorder,

        "--field-bg": fieldBg,
        "--field-ink": fieldInk,
        "--field-border": fieldBorder,
    });

    // Sincroniza a cor nativa da janela (Electron → main.setBackgroundColor)
    try { window.win?.setBackground?.(base); } catch { /* noop */ }
}

/* ───────────────────────── Debug opcional ───────────────────────── */
/** Helper no DevTools: window.themeApply('#ff0066') */
try { window.themeApply = (hex) => applyChromeTheme(hex); } catch { /* noop */ }
