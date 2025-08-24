// src/main/context.ts
import type { BrowserWindow, Session } from "electron";

export type AppContext = {
    isDev: boolean;
    userSession: Session;            // persist:wirepeek
    mainWin: BrowserWindow | null;
    inspectorWin: BrowserWindow | null;
    wvPreloadUrl: string | null;     // file:// do preload do <webview>
    setMainWin: (w: BrowserWindow | null) => void;
    setInspectorWin: (w: BrowserWindow | null) => void;
};
