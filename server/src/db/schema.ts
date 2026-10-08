import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { normalizePhone } from "../auth/phone.js";

/** Additive column add. SQLite has no "ADD COLUMN IF NOT EXISTS". */
function addColumn(db: Database.Database, table: string, column: string, decl: string): boolean {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
  if (cols.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

/**
 * Creates a UNIQUE index, but never at the cost of refusing to boot.
 *
 * A duplicate here means the table already holds two accounts whose phone
 * numbers differ only by punctuation - "+65 9001 0001" next to "6590010001".
 * Those are a data problem for an operator to reconcile, not a reason to take
 * every resident's intercom offline, so it is reported loudly and the index is
 * skipped until the duplicates are gone.
 */
function createUniqueIndex(
  db: Database.Database,
  name: string,
  table: string,
  column: string,
): boolean {
  const collision = db
    .prepare(
      `SELECT ${column} AS k, COUNT(*) c FROM ${table}
       WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING c > 1`,
    )
    .all() as any[];
  if (collision.length > 0) {
    console.warn(
      `[DB] ${name} NOT created: ${collision.length} duplicated ${table}.${column} ` +
        `value(s) (${collision.slice(0, 3).map((r) => r.k).join(", ")}` +
        `${collision.length > 3 ? ", ..." : ""}). Those accounts cannot be told apart ` +
        `by phone until an operator merges or re-numbers them.`,
    );
    return false;
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`);
  return true;
}

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
      phone         TEXT,
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

  // ── Additive migrations ────────────────────────────────────────────────
  // CREATE TABLE IF NOT EXISTS above cannot widen a table that already exists,
  // so new columns land here. Both statements are idempotent, which is what
  // lets this run on every boot instead of needing a separate migration step.
  addColumn(db, "residents", "phone_norm", "TEXT");
  addColumn(db, "admins", "phone", "TEXT");
  addColumn(db, "admins", "phone_norm", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id           TEXT PRIMARY KEY,
      account_type TEXT NOT NULL,
      account_id   TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      expires_at   TEXT NOT NULL,
      used_at      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_account
      ON password_resets(account_type, account_id);
  `);

  // Backfill phone_norm from the formatted phone, in place. Written as an
  // UPDATE rather than a table rebuild so no row is ever dropped or re-keyed.
  const backfill = db
    .prepare("SELECT id, phone FROM residents WHERE phone_norm IS NULL")
    .all() as any[];
  if (backfill.length > 0) {
    const set = db.prepare("UPDATE residents SET phone_norm = ? WHERE id = ?");
    const run = db.transaction(() => {
      for (const row of backfill) set.run(normalizePhone(row.phone) || null, row.id);
    });
    run();
    console.log(`[DB] Normalised phone for ${backfill.length} existing resident(s).`);
  }

  createUniqueIndex(db, "idx_residents_phone_norm", "residents", "phone_norm");

  // Admins have no phone until one is set. Backfill before the unique index
  // exists, so a genuine duplicate is reported by createUniqueIndex rather
  // than thrown as a constraint violation out of the UPDATE above.
  const adminBackfill = db
    .prepare("SELECT id, phone FROM admins WHERE phone_norm IS NULL AND phone IS NOT NULL")
    .all() as any[];
  if (adminBackfill.length > 0) {
    const set = db.prepare("UPDATE admins SET phone_norm = ? WHERE id = ?");
    const run = db.transaction(() => {
      for (const row of adminBackfill) set.run(normalizePhone(row.phone) || null, row.id);
    });
    run();
  }

  createUniqueIndex(db, "idx_admins_phone_norm", "admins", "phone_norm");

  return db;
}