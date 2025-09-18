// src/preload/webview.preload.ts
/**
 * @file Preload do GUEST (<webview>), executa dentro do site carregado.
 * - Sanitiza qualquer payload antes de enviá-lo ao host (renderer) via sendToHost,
 *   evitando o clássico: "GUEST_VIEW_MANAGER_CALL: An object could not be cloned".
 * - Expõe uma função segura `window.__wirepeekEmit(channel, payload)` para
 *   scripts do site chamarem caso você deseje (opcional).
 *
 * Observações:
 * - Só encaminhamos canais que começam com "cap:" (whitelist por prefixo).
 * - Nunca lança no contexto do site: todos os handlers são embrulhados em try/catch.
 */

import { ipcRenderer, contextBridge } from "electron";

/* ========================================================================== */
/* Tipos globais (somente para o TS do projeto; não gera JS)                  */
/* ========================================================================== */
declare global {
  interface Window {
    /** Presença deste flag permite diagnosticar no devtools do convidado. */
    __cap_active?: boolean;
    /**
     * Canal opcional exposto ao site para emitir eventos customizados.
     * Uso: window.__wirepeekEmit?.("cap:meu-canal", { foo: 1 })
     */
    __wirepeekEmit?: (channel: string, payload: unknown) => void;
  }
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

/**
 * Transforma qualquer valor em um objeto/valor JSON-seguro:
 *  - remove funções, símbolos, referências circulares, etc.
 *  - se falhar a serialização, retorna um marcador leve (seguro).
 */
function toPlain(value: unknown): unknown {
  try {
    // JSON round-trip produz algo sempre clonável pelo IPC.
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { _unserializable: true };
  }
}

/** Whitelist simples de canais permitidos (prefixo "cap:"). */
function isAllowedChannel(channel: unknown): channel is string {
  return typeof channel === "string" && channel.startsWith("cap:");
}

/**
 * Emite do guest → host (renderer pai do <webview>) de forma resiliente.
 * Nunca propaga exceções para o site convidado.
 */
function emitToHost(channel: string, payload: unknown): void {
  try {
    if (!isAllowedChannel(channel)) return;
    ipcRenderer.sendToHost(channel, toPlain(payload));
  } catch {
    // silêncio: não queremos ruído no console do convidado
  }
}

/* ========================================================================== */
/* Exposição segura ao mundo do convidado                                     */
/* ========================================================================== */

/**
 * Opcional: expõe uma função global para que scripts do site possam emitir
 * eventos customizados para o host (apenas canais "cap:*" serão aceitos).
 */
try {
  contextBridge.exposeInMainWorld("__wirepeekEmit", (channel: string, payload: unknown) => {
    emitToHost(channel, payload);
  });
} catch {
  // Se o site bloquear o contextIsolation de algum modo, ignoramos.
}

/** Flag de diagnóstico: permite checar `window.__cap_active` no guest. */
try {
  contextBridge.exposeInMainWorld("__cap_active", true);
} catch {
  /* noop */
}

/* ========================================================================== */
/* Pequenos sinais automáticos do guest → host                                 */
/* ========================================================================== */

try {
  // Sinal básico quando o DOM ficou pronto
  document.addEventListener("DOMContentLoaded", () => {
    emitToHost("cap:guest:loaded", { title: String(document.title || "") });
  });

  // Em alguns sites o DOMContentLoaded não é um bom “marco” visual; pageshow ajuda
  window.addEventListener("pageshow", () => {
    emitToHost("cap:guest:pageshow", { url: String(location.href) });
  });
} catch {
  /* noop */
}
