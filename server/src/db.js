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
  if (existing) {
    warnIfDefaultPassword(bcrypt);
    return;
  }

  // A fixed, published password would let anyone who has read this repo log in
  // and open the gates, so every fresh install gets its own.
  const randomPassword = () => require('crypto').randomBytes(9).toString('base64url');
  const adminLogin = (process.env.ADMIN_USERNAME || '').trim() || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || randomPassword();
  // The demo residents can unlock gates too, so they never share a password set in .env.
  const demoPassword = randomPassword();
  const adminHash = bcrypt.hashSync(adminPassword, 10);
  const demoHash = bcrypt.hashSync(demoPassword, 10);

  const residents = [
    { name: 'Admin', apartment: '1', email: adminLogin, phone: '555-0100', is_admin: 1 },
    { name: 'Alice Johnson', apartment: '2A', email: 'alice@demo.com', phone: '555-0101', is_admin: 0 },
    { name: 'Bob Smith', apartment: '3B', email: 'bob@demo.com', phone: '555-0102', is_admin: 0 },
    { name: 'Carol White', apartment: '4C', email: 'carol@demo.com', phone: '555-0103', is_admin: 0 },
    { name: 'David Brown', apartment: '5D', email: 'david@demo.com', phone: '555-0104', is_admin: 0 },
  ];

  for (const r of residents) {
    db.run(
      'INSERT INTO residents (id, name, apartment, phone, email, password, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), r.name, r.apartment, r.phone, r.email, r.is_admin ? adminHash : demoHash, r.is_admin]
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

  if (process.env.ADMIN_PASSWORD) {
    console.log(`[DB] Demo data seeded. Sign in as "${adminLogin}" with ADMIN_PASSWORD from .env.`);
  } else {
    console.log(`[DB] Demo data seeded. Sign in as "${adminLogin}" with password:`, adminPassword);
  }
  console.log('[DB] Demo residents (alice@demo.com etc.) share the password:', demoPassword);
}

// Databases seeded by older versions used the password "admin" for every account.
function warnIfDefaultPassword(bcrypt) {
  const weak = getAll("SELECT email, password FROM residents WHERE email LIKE '%@demo.com' OR email = 'admin'")
    .filter((r) => bcrypt.compareSync('admin', r.password))
    .map((r) => r.email);
  if (weak.length) {
    console.warn(`[DB] WARNING: these accounts still use the password "admin": ${weak.join(', ')}`);
    console.warn('[DB]          Anyone who knows it can open the gates. Change them in the dashboard.');
  }
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

// Write to a temp file and rename it over the old one, so a crash or power cut
// mid-write leaves the previous database intact instead of a truncated file.
function writeToDisk() {
  if (!db) return;
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(db.export()));
  fs.renameSync(tmp, DB_PATH);
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

// Only 'exit' here: a SIGINT/SIGTERM listener would stop Node's default
// behaviour of exiting, so Ctrl+C did nothing until index.js finished booting.
// index.js installs the signal handlers and they exit through this one.
process.on('exit', () => {
  try { flushDatabase(); } catch { /* nothing left to do */ }
});

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
