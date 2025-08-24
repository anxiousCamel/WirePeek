// src/main/session.profile.ts
import { app, session } from "electron";
import type { Session } from "electron";
import { config } from "./config";

export function createUserSession(): Session {
    const s = session.fromPartition("persist:wirepeek");
    if (config.userAgent) {
        s.setUserAgent(config.userAgent);
        app.userAgentFallback = config.userAgent;
    }
    return s;
}
