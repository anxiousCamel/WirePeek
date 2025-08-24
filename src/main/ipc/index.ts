import type { AppContext } from "../context";
import { registerCaptureIpc } from "./ipc.capture";
import { registerHistoryIpc } from "./ipc.history";
import { registerCredsIpc } from "./ipc.creds";
import { registerNavIpc } from "./ipc.nav";
import { registerWindowIpc } from "./ipc.window";

export function registerAllIpc(ctx: AppContext) {
    registerCaptureIpc(ctx);
    registerHistoryIpc(ctx);
    registerCredsIpc(ctx);
    registerNavIpc(ctx);
    registerWindowIpc(ctx);
}
