import Database from "better-sqlite3";
import * as path from "path";
import { app } from "electron";

const dbPath = path.join(app.getPath("userData"), "history.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  ts INTEGER NOT NULL,
  transition TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts DESC);
`);

const insert = db.prepare<{ url: string; title: string | null; ts: number; transition: string }>(
    "INSERT INTO history (url, title, ts, transition) VALUES (@url, @title, @ts, @transition)"
);

export function addHistory(url: string, title: string | null, transition: string): void {
    insert.run({ url, title, ts: Date.now(), transition });
}

export type HistoryRow = { id: number; url: string; title: string | null; ts: number; transition: string };

export function listHistory(limit = 200): HistoryRow[] {
    // 1 parâmetro posicional: LIMIT ?
    const stmt = db.prepare<[number], HistoryRow>(
        "SELECT * FROM history ORDER BY ts DESC LIMIT ?"
    );
    return stmt.all(limit);
}


export function clearHistory(): void {
    db.exec("DELETE FROM history");
}
