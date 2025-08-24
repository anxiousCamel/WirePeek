// src/renderer/global.d.ts
export { };

type UiConfig = { targetUrl?: string; isDev?: boolean };

type WirepeekStartResp = { capturing: boolean };
type WirepeekStopResp = { capturing: boolean; out?: { ok: boolean; reason?: string } };
type NavigateOk = { ok: true };
type NavigateErr = { ok: false; error: string };

type WirepeekAPI = {
    start: () => Promise<WirepeekStartResp>;
    stop: () => Promise<WirepeekStopResp>;
    navigate: (url: string) => Promise<NavigateOk | NavigateErr>;
    onConfig: (cb: (cfg: UiConfig) => void) => () => void; // retorna unsubscribe
};

type WinAPI = {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<{ maximized: boolean } | void>;
    close: () => Promise<void>;
    onMaximizedChange: (cb: (maximized: boolean) => void) => () => void; // unsubscribe
};

type ElectronAPI = {
    onWinResized: (cb: () => void) => () => void; // unsubscribe
};

declare global {
    interface Window {
        wirepeek?: WirepeekAPI;
        win?: WinAPI;
        electronAPI?: ElectronAPI;
    }
}
