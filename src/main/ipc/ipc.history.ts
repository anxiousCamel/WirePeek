import { ipcMain } from "electron";
import { addHistory, listHistory, clearHistory } from "../history.store";
import type { AppContext } from "../context";

type HistoryNotePayload = { url: string; title: string | null; transition?: string };

export function registerHistoryIpc(_ctx: AppContext): void {
    ipcMain.on("history:note", (_e, p: HistoryNotePayload) => {
        if (!p?.url?.startsWith?.("http")) return;
        const title = typeof p.title === "string" ? p.title : null;
        const transition = typeof p.transition === "string" ? p.transition : "unknown";
        addHistory(p.url, title, transition);
    });

    ipcMain.handle("history:list", (_e, limit?: number) => {
        const lim = typeof limit === "number" && limit > 0 ? limit : 200;
        return listHistory(lim);
    });

    ipcMain.handle("history:clear", () => { clearHistory(); return { ok: true as const }; });
}
