const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { configureEnv, quietConsole } = require('./helpers');

configureEnv();
quietConsole();
const db = require('../src/db');

test.before(() => db.initDatabase());

test('a new database is seeded with an admin, demo residents and two gates', () => {
  const admins = db.getAll('SELECT email FROM residents WHERE is_admin = 1');
  assert.deepEqual(admins, [{ email: 'admin' }]);
  assert.equal(db.getOne('SELECT COUNT(*) AS n FROM residents WHERE is_admin = 0').n, 4);
  assert.deepEqual(
    db.getAll('SELECT id, mqtt_topic FROM gates ORDER BY id'),
    [
      { id: 'front-gate', mqtt_topic: 'gates/front-gate/command' },
      { id: 'parking-gate', mqtt_topic: 'gates/parking-gate/command' }
    ]
  );
});

test('passwords are stored hashed, and admin and demo accounts differ', () => {
  const bcrypt = require('bcryptjs');
  const admin = db.getOne("SELECT password FROM residents WHERE email = 'admin'");
  const alice = db.getOne("SELECT password FROM residents WHERE email = 'alice@demo.com'");
  assert.notEqual(admin.password, process.env.ADMIN_PASSWORD);
  assert.ok(bcrypt.compareSync(process.env.ADMIN_PASSWORD, admin.password));
  assert.equal(bcrypt.compareSync(process.env.ADMIN_PASSWORD, alice.password), false);
});

test('getOne returns null when nothing matches; getAll returns []', () => {
  assert.equal(db.getOne('SELECT * FROM gates WHERE id = ?', ['nope']), null);
  assert.deepEqual(db.getAll('SELECT * FROM gates WHERE id = ?', ['nope']), []);
});

test('run writes, and flushDatabase persists the change to DB_PATH', async () => {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['k', 'v']);
  assert.deepEqual(db.getOne('SELECT value FROM settings WHERE key = ?', ['k']), { value: 'v' });

  db.flushDatabase();
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const onDisk = new SQL.Database(fs.readFileSync(process.env.DB_PATH));
  const rows = onDisk.exec("SELECT value FROM settings WHERE key = 'k'");
  assert.equal(rows[0].values[0][0], 'v');
  assert.equal(fs.existsSync(`${process.env.DB_PATH}.tmp`), false);
});

test('re-opening an existing database keeps its data and does not re-seed', async () => {
  const before = db.getOne('SELECT COUNT(*) AS n FROM residents').n;
  db.flushDatabase();
  await db.initDatabase();
  assert.equal(db.getOne('SELECT COUNT(*) AS n FROM residents').n, before);
  assert.deepEqual(db.getOne('SELECT value FROM settings WHERE key = ?', ['k']), { value: 'v' });
});
