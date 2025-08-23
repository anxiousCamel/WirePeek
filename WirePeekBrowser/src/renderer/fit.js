// WirePeekBrowser/src/renderer/fit.js

/* eslint-env browser */
/**
 * Ajusta --header-h dinamicamente usando a altura real do header.
 * Funciona em Electron (com zoom, DPI, DevTools etc.).
 */
(function wireLayoutFix() {
    const root = document.documentElement;
    const header = document.getElementById('titlebar');
    const area = document.getElementById('webviews');

    if (!header || !area) return;

    function setHeaderVar() {
        // usar a base real do header em relação ao viewport
        const h = Math.ceil(header.getBoundingClientRect().bottom);
        root.style.setProperty('--header-h', `${h}px`);
    }

    // EXPÕE uma função para redimensionar imediatamente (UI chama após append)
    window.__resizeWebviewsNow = function __resizeWebviewsNow() {
        const cw = area.clientWidth;
        const ch = area.clientHeight;
        area.querySelectorAll('webview[data-managed-size]').forEach(wv => {
            if (wv.getAttribute('width') !== String(cw)) wv.setAttribute('width', String(cw));
            if (wv.getAttribute('height') !== String(ch)) wv.setAttribute('height', String(ch));
            wv.style.width = cw + 'px';
            wv.style.height = ch + 'px';
        });
    };


    function sizeWebviews() {
        const cw = area.clientWidth;
        const ch = area.clientHeight;
        // aplique em TODOS que tiverem a flag
        area.querySelectorAll('webview[data-managed-size]').forEach(wv => {
            // atributos **obrigatórios** para o convidado ocupar tudo
            if (wv.getAttribute('width') !== String(cw)) wv.setAttribute('width', String(cw));
            if (wv.getAttribute('height') !== String(ch)) wv.setAttribute('height', String(ch));
            // fallback de estilo (alguns temas exigem)
            wv.style.width = cw + 'px';
            wv.style.height = ch + 'px';
        });
    }

    // quando novas abas forem adicionadas
    const mo = new MutationObserver(sizeWebviews);
    mo.observe(area, { childList: true, subtree: false });

    const debounced = (fn, t = 16) => {
        let id; return () => { clearTimeout(id); id = setTimeout(fn, t); };
    };

    const applyAll = () => { setHeaderVar(); sizeWebviews(); };
    const applyAllDebounced = debounced(applyAll, 16);

    // eventos que mudam o layout
    new ResizeObserver(applyAllDebounced).observe(header);
    window.addEventListener('resize', applyAllDebounced, { passive: true });
    document.addEventListener('DOMContentLoaded', applyAll);
    applyAll();

    // sinais do main (resize, fullscreen, etc.) via preload
    if (window.electronAPI && typeof window.electronAPI.onWinResized === 'function') {
        window.electronAPI.onWinResized(applyAllDebounced);
    }
})();
