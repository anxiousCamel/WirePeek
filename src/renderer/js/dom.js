/* eslint-env browser */

// atalho
export const $ = (id) => document.getElementById(id);

// refs fixas
export const el = {
    tabstrip: $("tabstrip"),
    btnNewTab: $("tab-new"),
    webviews: $("webviews"),
    address: $("address"),
    btnGo: $("btn-go"),
    btnBack: $("btn-back"),
    btnFwd: $("btn-fwd"),
    btnReload: $("btn-reload"),
    btnCap: $("btn-capture"),
    winMin: $("win-min"),
    winMax: $("win-max"),
    winClose: $("win-close"),
    engineBtn: $("engine-btn"), // pode não existir
};

// CSS variables
const root = document.documentElement;
export const setVars = (obj) =>
    Object.entries(obj).forEach(([k, v]) => root.style.setProperty(k, v));
