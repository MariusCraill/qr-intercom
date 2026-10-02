const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/intercom.db');

async function initDatabase() {
  const SQL = await initSqlJs();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS residents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      apartment TEXT NOT NULL,
      phone TEXT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS gates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT,
      mqtt_topic TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      gate_id TEXT,
      resident_id TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT,
      ended_at TEXT,
      duration INTEGER,
      status TEXT DEFAULT 'pending',
      FOREIGN KEY (gate_id) REFERENCES gates(id),
      FOREIGN KEY (resident_id) REFERENCES residents(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gate_id TEXT,
      resident_id TEXT,
      action TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (gate_id) REFERENCES gates(id),
      FOREIGN KEY (resident_id) REFERENCES residents(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  seedDemoData();
  flushDatabase();
  console.log('[DB] Database initialized at', DB_PATH);
  return db;
}

function seedDemoData() {
  const bcrypt = require('bcryptjs');
  const { v4: uuid } = require('uuid');

  const existing = getOne('SELECT id FROM residents LIMIT 1');
  if (existing) return;

  const pw = bcrypt.hashSync('admin', 10);

  const residents = [
    { name: 'Admin', apartment: '1', email: 'admin@demo.com', phone: '555-0100', is_admin: 1 },
    { name: 'Alice Johnson', apartment: '2A', email: 'alice@demo.com', phone: '555-0101', is_admin: 0 },
    { name: 'Bob Smith', apartment: '3B', email: 'bob@demo.com', phone: '555-0102', is_admin: 0 },
    { name: 'Carol White', apartment: '4C', email: 'carol@demo.com', phone: '555-0103', is_admin: 0 },
    { name: 'David Brown', apartment: '5D', email: 'david@demo.com', phone: '555-0104', is_admin: 0 },
  ];

  for (const r of residents) {
    db.run(
      'INSERT INTO residents (id, name, apartment, phone, email, password, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), r.name, r.apartment, r.phone, r.email, pw, r.is_admin]
    );
  }

  const gateId = 'front-gate';
  db.run(
    'INSERT INTO gates (id, name, location, mqtt_topic) VALUES (?, ?, ?, ?)',
    [gateId, 'Front Gate', 'Main entrance', 'gates/' + gateId + '/command']
  );
  const gateId2 = 'parking-gate';
  db.run(
    'INSERT INTO gates (id, name, location, mqtt_topic) VALUES (?, ?, ?, ?)',
    [gateId2, 'Parking Gate', 'Underground parking', 'gates/' + gateId2 + '/command']
  );

  console.log('[DB] Demo data seeded (password: admin for all accounts)');
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ---------- persistence ----------
// sql.js keeps the whole DB in WASM memory, so every write used to mean a full
// re-serialise plus a synchronous disk write. Coalesce writes instead and flush on exit.
let saveTimer = null;
let dirty = false;

function writeToDisk() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function saveDatabase() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      writeToDisk();
    } catch (err) {
      console.error('[DB] Save failed:', err.message);
    }
  }, 250);
  if (saveTimer.unref) saveTimer.unref();
}

function flushDatabase() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty && db) {
    dirty = false;
    writeToDisk();
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    try { flushDatabase(); } catch { /* nothing left to do */ }
  });
}

// ---------- query helpers ----------
function run(sql, params = []) {
  getDb().run(sql, params);
  saveDatabase();
}

function getAll(sql, params = []) {
  const results = [];
  const stmt = getDb().prepare(sql);
  if (params.length) stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function getOne(sql, params = []) {
  const stmt = getDb().prepare(sql);
  if (params.length) stmt.bind(params);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

module.exports = { initDatabase, getDb, saveDatabase, flushDatabase, run, getAll, getOne };
