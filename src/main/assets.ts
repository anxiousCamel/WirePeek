// src/main/assets.ts
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const exists = (p: string) => fs.existsSync(p);

export function mainAssets(isDev: boolean) {
    const devHtml = path.resolve(__dirname, "../../src/renderer/index.html");
    const prodHtml = path.join(__dirname, "../renderer/index.html");
    const devPreload = path.resolve(__dirname, "../../dist/preload/preload.js");
    const prodPreload = path.join(__dirname, "../preload/preload.js");
    return {
        html: isDev && exists(devHtml) ? devHtml : prodHtml,
        preload: isDev && exists(devPreload) ? devPreload : prodPreload,
    };
}

export function inspectorAssets() {
    const devHtml = path.resolve(__dirname, "../../src/inspector/index.html");
    const prodHtml = path.join(__dirname, "../inspector/index.html");
    const devPreload = path.resolve(__dirname, "../../dist/preload/preload.inspector.js");
    const prodPreload = path.join(__dirname, "../preload/preload.inspector.js");
    return {
        html: exists(devHtml) ? devHtml : prodHtml,
        preload: exists(devPreload) ? devPreload : prodPreload,
    };
}

export function webviewPreloadUrl(): string {
    const dev = path.resolve(__dirname, "../../dist/webview/preload.capture.js");
    const prod = path.join(__dirname, "../webview/preload.capture.js");
    const p = exists(dev) ? dev : prod;
    return pathToFileURL(p).href;
}
