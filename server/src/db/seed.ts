import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import { initializeDatabase } from "./schema.js";

const db = initializeDatabase("./data/intercom.db");

// This script DROPs the residents, admins and call_logs tables before
// recreating them. Against a populated database that is silent total data
// loss, and the README tells people to run `npm run db:seed` as a setup step.
// Refuse unless the caller opts in, so a stray run cannot wipe real accounts.
const FORCE = process.argv.includes("--force") || process.env.SEED_FORCE === "true";

const existing = db
  .prepare(
    `SELECT (SELECT COUNT(*) FROM residents) + (SELECT COUNT(*) FROM admins) AS n`,
  )
  .get() as any;

if (existing.n > 0 && !FORCE) {
  console.error(
    `[Seed] REFUSING: this database already holds ${existing.n} account(s).`,
  );
  console.error("[Seed] This script drops and recreates every table, so it is destructive.");
  console.error("[Seed] If you are setting up a fresh database, re-run with --force:");
  console.error("[Seed]     npm run db:seed -- --force");
  console.error("[Seed] To move an existing database onto the current schema, use:");
  console.error("[Seed]     npm run db:migrate        (that one preserves data)");
  db.close();
  process.exit(1);
}

if (existing.n > 0) {
  console.warn(
    `[Seed] --force given: destroying ${existing.n} existing account(s). This cannot be undone.`,
  );
}

db.exec(`
  DROP TABLE IF EXISTS call_logs;
  DROP TABLE IF EXISTS residents;
  DROP TABLE IF EXISTS admins;
  DROP TABLE IF EXISTS gates;
`);

db.exec(`
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
  CREATE TABLE admins (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
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

const hash = bcrypt.hashSync("password123", 10);

const residents = [
  { unit: "101", name: "Alice Chen", phone: "+65 9001 0001" },
  { unit: "102", name: "Bob Patel", phone: "+65 9002 0002" },
  { unit: "201", name: "Carol Zhang", phone: "+65 9003 0003" },
  { unit: "202", name: "David Kim", phone: "+65 9004 0004" },
  { unit: "301", name: "Eve Johnson", phone: "+65 9005 0005" },
];

const insertResident = db.prepare(`
  INSERT INTO residents (id, unit, name, phone, password_hash)
  VALUES (?, ?, ?, ?, ?)
`);

for (const r of residents) {
  insertResident.run(uuid(), r.unit, r.name, r.phone, hash);
}

console.log("Database seeded:");
console.log(`  Residents: ${residents.length} (password: "password123")`);

const adminHash = bcrypt.hashSync("admin123", 10);
db.prepare("INSERT INTO admins (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
  .run(uuid(), "Admin", "admin@example.com", adminHash);
console.log(`  Admin: admin@example.com / admin123`);

db.close();