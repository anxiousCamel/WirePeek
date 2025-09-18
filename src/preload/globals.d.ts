/**
 * @file src/preload/globals.d.ts
 * @brief Declarações globais do renderer (ambient types) para unificar `window.*`.
 *
 * Por que este arquivo?
 * - Evita conflitos TS2717 (“Subsequent property declarations…”) entre múltiplos preloads.
 * - Define uma *única* forma de `window.win` e `window.wirepeek` para todo o app.
 * - Permite que cada janela exponha sua própria variação de API (união de tipos).
 *
 * Notas:
 * - Importações são `type-only` (não geram JS).
 * - Com `exactOptionalPropertyTypes: true`, propriedades opcionais aqui aceitam
 *   tanto `delete window.__x` quanto `window.__x = undefined` (tipadas como `?: T | undefined`).
 */

export { }; // garante que isto é um módulo e permite augmentations de global

declare global {
    /** Função padrão de unsubscribe de listeners. */
    type Unsubscribe = () => void;

    // Tipos das APIs expostas por cada preload (principal e inspector).
    // ⚠️ Esses caminhos devem continuar apontando para os arquivos certos.
    type WirepeekMainAPI = import("./preload").WirepeekAPI;
    type WirepeekInspectorAPI = import("./preload.inspector").WirepeekInspectorAPI;
    type WinAPI = import("./preload").WinAPI;

    interface Window {
        /**
         * Controles de janela (mesma interface em ambas as janelas).
         * Exposto por: preload.ts e preload.inspector.ts
         */
        win?: WinAPI;

        /**
         * API da aplicação:
         *  - Na janela principal: WirepeekMainAPI
         *  - No Inspector: WirepeekInspectorAPI
         *
         * Usamos união para evitar conflito de tipos entre preloads diferentes.
         */
        wirepeek?: WirepeekMainAPI | WirepeekInspectorAPI;

        /**
         * Caminho `file://` do preload do <webview>, definido pelo main via "ui:config".
         * Marcado como opcional e também `| undefined` para compatibilidade com
         * `exactOptionalPropertyTypes` caso você faça `window.__wvPreloadPath = undefined`.
         */
        __wvPreloadPath?: string | undefined;

        /**
         * Partition a ser usada pelos <webview> (ex.: "persist:wirepeek").
         * Opcional e `| undefined` para compatibilidade com
         * `exactOptionalPropertyTypes` caso você faça `window.__wvPartition = undefined`.
         */
        __wvPartition?: string | undefined;
    }
}
