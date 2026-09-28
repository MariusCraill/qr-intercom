import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const DB_PATH = "./data/intercom.db";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function tableExists(name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return cols.some((c) => c.name === column);
}

const needsMigration = tableExists("gates") || (tableExists("residents") && hasColumn("residents", "gate_id"));

if (!needsMigration) {
  console.log("[Migrate] Schema already current (no gates).");
  db.close();
  process.exit(0);
}

console.log("[Migrate] Old schema with gates detected — rebuilding without gates (preserving Marius + admin)...");

// Snapshot the accounts we must keep before dropping anything.
const marius = db
  .prepare("SELECT * FROM residents WHERE name = 'Marius' ORDER BY created_at ASC LIMIT 1")
  .get() as any;
const admin = db
  .prepare("SELECT * FROM admins ORDER BY created_at ASC LIMIT 1")
  .get() as any;

db.exec("PRAGMA foreign_keys = OFF");
db.exec("BEGIN");

db.exec(`
  DROP TABLE IF EXISTS call_logs;
  DROP TABLE IF EXISTS residents;
  DROP TABLE IF EXISTS gates;
  DROP TABLE IF EXISTS admins;

  CREATE TABLE admins (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE residents (
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

  CREATE TABLE call_logs (
    id                 TEXT PRIMARY KEY,
    visitor_session_id TEXT,
    resident_id        TEXT NOT NULL REFERENCES residents(id),
    started_at         TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at           TEXT,
    accepted           INTEGER NOT NULL DEFAULT 0,
    unlocked           INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX idx_residents_phone ON residents(phone);
  CREATE INDEX idx_call_logs_resident ON call_logs(resident_id);
`);

if (admin) {
  db.prepare("INSERT INTO admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(admin.id, admin.name, admin.email, admin.password_hash, admin.created_at);
  console.log(`[Migrate] Preserved admin: ${admin.email}`);
} else {
  const adminHash = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO admins (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
    .run("a1b2c3d4-0000-4000-8000-000000000001", "Admin", "admin@example.com", adminHash);
  console.log("[Migrate] Recreated default admin: admin@example.com / admin123");
}

if (marius) {
  db.prepare(
    "INSERT INTO residents (id, unit, name, phone, password_hash, email, push_endpoint, push_keys, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    marius.id,
    marius.unit,
    marius.name,
    marius.phone,
    marius.password_hash,
    marius.email || null,
    marius.push_endpoint || null,
    marius.push_keys || null,
    marius.created_at
  );
  console.log(`[Migrate] Preserved resident: ${marius.name} (${marius.phone})`);
} else {
  console.warn("[Migrate] No resident named 'Marius' found to preserve.");
}

db.exec("COMMIT");
db.exec("PRAGMA foreign_keys = ON");
db.close();
console.log("[Migrate] Done.");