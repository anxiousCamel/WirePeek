import { ipcMain } from "electron";
import { saveCred, listCreds, deleteCred } from "../creds";
import type { AppContext } from "../context";

type SaveP = { origin: string; username: string; password: string };
type ListP = { origin: string };
type DelP = { origin: string; username: string };

export function registerCredsIpc(_ctx: AppContext): void {
    ipcMain.handle("cred:save", async (_e, p: SaveP) => {
        if (!p?.origin || !p?.username || !p?.password) return { ok: false as const };
        await saveCred(p.origin, p.username, p.password);
        return { ok: true as const };
    });

    ipcMain.handle("cred:list", async (_e, p: ListP) => (!p?.origin ? [] : listCreds(p.origin)));

    ipcMain.handle("cred:delete", async (_e, p: DelP) => {
        if (!p?.origin || !p?.username) return { ok: false as const };
        return { ok: await deleteCred(p.origin, p.username) };
    });
}
