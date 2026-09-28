import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import { initializeDatabase } from "./schema.js";

const db = initializeDatabase("./data/intercom.db");

db.exec(`
  DROP TABLE IF EXISTS call_logs;
  DROP TABLE IF EXISTS residents;
  DROP TABLE IF EXISTS admins;
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