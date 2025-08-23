// WirePeekBrowser/src/preload/preload.inspector.ts
/**
 * Preload do Inspector
 * Expõe um listener seguro para eventos vindos do main: "cap-event"
 */
import { contextBridge, ipcRenderer } from "electron";

type CapEventEnvelope = {
    channel: string;
    payload: unknown;
};

type CapHandler = (channel: string, payload: unknown) => void;

contextBridge.exposeInMainWorld("wirepeekInspector", {
    onCapEvent: (handler: CapHandler): void => {
        ipcRenderer.on("cap-event", (_evt, { channel, payload }: CapEventEnvelope) => {
            handler(channel, payload);
        });
    },
});
