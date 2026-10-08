import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * Non-destructive schema alignment.
 *
 * Replaces an earlier version of this script that dropped every table and kept
 * only the resident named "Marius" and the first admin. Running it would have
 * destroyed 6 of 7 residents, 1 of 2 admins and both gates. This version moves
 * data, it never deletes accounts.
 *
 * What it fixes. The live database had drifted away from src/db/schema.ts:
 *
 *   residents.gate_id          NOT NULL, but no code ever wrote it
 *                              -> POST /auth/resident-register failed 100%
 *   call_logs.resident_id      REFERENCES "residents_legacy"(id), a table that
 *                              does not exist (a hand-rolled rename that was
 *                              never completed)
 *                              -> POST /residents/me/unlock failed 100%
 *   call_logs.gate_id          NOT NULL, but the unlock INSERT omits it
 *   call_logs.visitor_session_id NOT NULL, but the unlock INSERT omits it
 *
 * Nothing in the codebase reads gate_id or the gates table - not the three web
 * clients, not the Android app, not one server route. The ESP32 firmware
 * hardcodes its own GATE_ID in firmware/config.h and never reads the database.
 * So the gate columns are vestigial and the database is brought in line with
 * the code, which is what schema.ts and seed.ts already describe.
 *
 * Safe to re-run: it detects the current shape and no-ops when already aligned.
 * Always take a copy first; the script refuses to run if it cannot account for
 * every row it is about to move.
 */

const DB_PATH = process.env.DATABASE_PATH || "./data/intercom.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
function columnsOf(table: string): string[] {
  if (!tableExists(table)) return [];
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
}
function count(table: string): number {
  return tableExists(table)
    ? (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as any).c
    : 0;
}

// ── Decide whether there is anything to do ───────────────────────────
const residentCols = columnsOf("residents");
const callLogCols = columnsOf("call_logs");

const needsWork =
  tableExists("gates") || residentCols.includes("gate_id") || callLogCols.includes("gate_id");

if (!needsWork) {
  console.log("[Migrate] Schema already aligned with src/db/schema.ts - nothing to do.");
  db.close();
  process.exit(0);
}

// ── Preserve the gates table before removing it ──────────────────────
// The rows are unused by the code but they are still somebody's data, so they
// are written to JSON next to the database rather than just deleted.
if (tableExists("gates")) {
  const gates = db.prepare("SELECT * FROM gates").all();
  const outFile = path.resolve(path.dirname(DB_PATH), "gates.removed.json");
  fs.writeFileSync(outFile, JSON.stringify(gates, null, 2));
  console.log(`[Migrate] Saved ${gates.length} row(s) from gates to ${outFile}`);
}

// ── Refuse to proceed if we would lose data ─────────────────────────
const residentsBefore = count("residents");
const adminsBefore = count("admins");
const callLogsBefore = count("call_logs");

console.log(
  `[Migrate] Current: ${residentsBefore} resident(s), ${adminsBefore} admin(s), ${callLogsBefore} call log(s)`,
);

// Every call log must reference a resident that still exists, or the FK would
// reject the copy. Check before touching anything.
const orphans = db
  .prepare(
    `SELECT COUNT(*) c FROM call_logs cl
     WHERE NOT EXISTS (SELECT 1 FROM residents r WHERE r.id = cl.resident_id)`,
  )
  .get() as any;
if (orphans.c > 0) {
  console.error(
    `[Migrate] ABORT: ${orphans.c} call log(s) reference a resident that does not exist.`,
  );
  console.error("[Migrate] Restore from a backup and reconcile by hand - not guessing.");
  db.close();
  process.exit(1);
}

db.exec("PRAGMA foreign_keys = OFF");
db.exec("BEGIN");

try {
  // ── residents: drop the vestigial gate_id ─────────────────────────
  db.exec(`
    CREATE TABLE residents_new (
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
  `);

  db.exec(`
    INSERT INTO residents_new
      (id, unit, name, phone, password_hash, email, push_endpoint, push_keys, created_at)
    SELECT
      id, unit, name, phone, password_hash, email, push_endpoint, push_keys, created_at
    FROM residents;
  `);

  const moved = count("residents_new") as number;
  if (moved !== residentsBefore) {
    throw new Error(`resident count changed during copy: ${residentsBefore} -> ${moved}`);
  }
  console.log(`[Migrate] Preserved all ${moved} resident(s)`);

  // call_logs still points at the old residents table, so it has to go before
  // the old residents table does. Its rows are staged first.
  if (tableExists("call_logs")) {
    db.exec(`
      CREATE TABLE call_logs_staged (
        id                 TEXT PRIMARY KEY,
        visitor_session_id TEXT,
        resident_id        TEXT NOT NULL,
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at           TEXT,
        accepted           INTEGER NOT NULL DEFAULT 0,
        unlocked           INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(`
      INSERT INTO call_logs_staged
        (id, visitor_session_id, resident_id, started_at, ended_at, accepted, unlocked)
      SELECT
        id, visitor_session_id, resident_id, started_at, ended_at, accepted, unlocked
      FROM call_logs;
    `);
    console.log(`[Migrate] Preserved all ${count("call_logs_staged")} call log(s)`);
  }

  db.exec("DROP TABLE IF EXISTS call_logs");
  db.exec("DROP TABLE IF EXISTS residents");
  db.exec("DROP TABLE IF EXISTS gates");
  db.exec("ALTER TABLE residents_new RENAME TO residents");

  // Recreated only now, so the foreign key names "residents" - the table that
  // actually exists. Building it earlier and renaming would make SQLite
  // rewrite the reference to the table we are dropping.
  if (tableExists("call_logs_staged")) {
    db.exec(`
      CREATE TABLE call_logs (
        id                 TEXT PRIMARY KEY,
        visitor_session_id TEXT,
        resident_id        TEXT NOT NULL REFERENCES residents(id),
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at           TEXT,
        accepted           INTEGER NOT NULL DEFAULT 0,
        unlocked           INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.exec(`
      INSERT INTO call_logs
        (id, visitor_session_id, resident_id, started_at, ended_at, accepted, unlocked)
      SELECT
        id, visitor_session_id, resident_id, started_at, ended_at, accepted, unlocked
      FROM call_logs_staged;
    `);
    const movedLogs = count("call_logs");
    if (movedLogs !== callLogsBefore) {
      throw new Error(`call log count changed during copy: ${callLogsBefore} -> ${movedLogs}`);
    }
    db.exec("DROP TABLE call_logs_staged");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_residents_phone ON residents(phone);
    CREATE INDEX IF NOT EXISTS idx_call_logs_resident ON call_logs(resident_id);
  `);

  db.exec("COMMIT");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("[Migrate] FAILED and rolled back:", (err as Error).message);
  db.close();
  process.exit(1);
}

db.pragma("foreign_keys = ON");

// ── Verify ───────────────────────────────────────────────────────────
const after = {
  residents: count("residents"),
  admins: count("admins"),
  callLogs: count("call_logs"),
  gates: count("gates"),
};
const fkProblems = db.pragma("foreign_key_check") as any[];

console.log(
  `[Migrate] After: ${after.residents} resident(s), ${after.admins} admin(s), ` +
    `${after.callLogs} call log(s), gates table ${after.gates ? "present" : "removed"}`,
);

if (after.residents !== residentsBefore) {
  console.error(`[Migrate] FAIL: resident count changed ${residentsBefore} -> ${after.residents}`);
  process.exit(1);
}
if (after.admins !== adminsBefore) {
  console.error(`[Migrate] FAIL: admin count changed ${adminsBefore} -> ${after.admins}`);
  process.exit(1);
}
if (fkProblems.length > 0) {
  console.error(`[Migrate] FAIL: ${fkProblems.length} foreign key violation(s) remain`);
  process.exit(1);
}

console.log("[Migrate] Done. Schema now matches src/db/schema.ts.");
db.close();
