/* eslint-env browser */
/**
 * @file src/renderer/js/dom.js
 * @brief Helpers mínimos de DOM + utilitário para definir CSS variables.
 *
 * Por que este módulo existe?
 *  - Centraliza as referências fixas da UI (em `el`) para evitar repetição de
 *    `document.getElementById` pelo app todo.
 *  - Fornece `setVars()` para aplicar temas via CSS Custom Properties de forma
 *    segura e simples.
 *
 * Observações importantes:
 *  - Este arquivo é carregado no renderer (janela principal).
 *  - Assumimos que o <script> é incluído após o HTML (ou com `defer`),
 *    de modo que os elementos já existam no momento do import.
 *  - Se algum elemento não existir, o valor correspondente em `el` será `null`.
 *    Use checagens/optional chaining ao acessar (como você já faz em partes do app).
 */

/* -------------------------------------------------------------------------- */
/* Atalhos de seleção                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Seleciona um elemento por ID.
 * @template {HTMLElement} T
 * @param {string} id - ID do elemento (sem o '#').
 * @returns {T|null} - Elemento encontrado ou `null`.
 */
export const $ = (id) => /** @type {HTMLElement|null} */(document.getElementById(id));

/* -------------------------------------------------------------------------- */
/* Referências fixas da UI                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Referências "estáticas" do layout. Podem ser `null` caso o elemento
 * não exista no DOM (ex.: componentes opcionais).
 *
 * Dica: ao usar, prefira optional chaining:
 *   `el.winMin?.addEventListener('click', ...)`
 * ou faça checagem:
 *   `if (el.engineBtn) { ... }`
 */
export const el = {
    tabstrip:  /** @type {HTMLDivElement|null}   */ ($("tabstrip")),
    btnNewTab: /** @type {HTMLButtonElement|null}*/ ($("tab-new")),
    webviews:  /** @type {HTMLDivElement|null}   */ ($("webviews")),
    address:   /** @type {HTMLInputElement|null} */ ($("address")),
    btnGo:     /** @type {HTMLButtonElement|null}*/ ($("btn-go")),
    btnBack:   /** @type {HTMLButtonElement|null}*/ ($("btn-back")),
    btnFwd:    /** @type {HTMLButtonElement|null}*/ ($("btn-fwd")),
    btnReload: /** @type {HTMLButtonElement|null}*/ ($("btn-reload")),
    btnCap:    /** @type {HTMLButtonElement|null}*/ ($("btn-capture")),
    winMin:    /** @type {HTMLButtonElement|null}*/ ($("win-min")),
    winMax:    /** @type {HTMLButtonElement|null}*/ ($("win-max")),
    winClose:  /** @type {HTMLButtonElement|null}*/ ($("win-close")),
    engineBtn: /** @type {HTMLButtonElement|null}*/ ($("engine-btn")), // pode não existir
};

/* -------------------------------------------------------------------------- */
/* CSS Variables                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Define múltiplas CSS variables no :root de forma segura.
 *
 * Regras:
 *  - Chaves que não comecem com "--" são ignoradas.
 *  - Valores `null` ou `undefined` removem a variável.
 *  - Números são convertidos para string automaticamente.
 *
 * @param {Record<string, string | number | null | undefined>} obj
 */
export function setVars(obj) {
    const root = document.documentElement;
    if (!root || !obj) return;

    for (const [k, v] of Object.entries(obj)) {
        if (typeof k !== "string" || !k.startsWith("--")) continue;

        if (v == null) {
            root.style.removeProperty(k);
            continue;
        }

        // Evita "NaN" ou valores estranhos indo parar no CSS.
        const val = typeof v === "number" ? String(v) : String(v).trim();
        if (val.length === 0) {
            root.style.removeProperty(k);
        } else {
            root.style.setProperty(k, val);
        }
    }
}
