import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

export function initializeDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS residents (
      id            TEXT PRIMARY KEY,
      unit          TEXT NOT NULL,
      name          TEXT NOT NULL,
      phone         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email         TEXT,
      push_endpoint TEXT,
      push_keys     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS call_logs (
      id                 TEXT PRIMARY KEY,
      visitor_session_id TEXT,
      resident_id        TEXT NOT NULL REFERENCES residents(id),
      started_at         TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at           TEXT,
      accepted           INTEGER NOT NULL DEFAULT 0,
      unlocked           INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_residents_phone ON residents(phone);
    CREATE INDEX IF NOT EXISTS idx_call_logs_resident ON call_logs(resident_id);
  `);

  return db;
}
