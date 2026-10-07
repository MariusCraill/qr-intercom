const test = require('node:test');
const assert = require('node:assert/strict');
const { configureEnv, quietConsole } = require('./helpers');

configureEnv();
quietConsole();
const auth = require('../src/auth');

function withSecret(value, fn) {
  const saved = process.env.JWT_SECRET;
  if (value === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = value;
  try { return fn(); } finally { process.env.JWT_SECRET = saved; }
}

test('resolveJwtSecret refuses a missing secret', () => {
  withSecret(undefined, () => assert.throws(auth.resolveJwtSecret, /JWT_SECRET is not set/));
  withSecret('   ', () => assert.throws(auth.resolveJwtSecret, /JWT_SECRET is not set/));
});

test('resolveJwtSecret refuses the placeholders, case-insensitively', () => {
  for (const placeholder of ['dev-secret', 'SECRET', 'changeme', 'change-me-to-a-real-secret-in-production']) {
    withSecret(placeholder, () => assert.throws(auth.resolveJwtSecret, /placeholder/));
  }
});

test('resolveJwtSecret refuses a short secret and accepts a long one', () => {
  withSecret('a'.repeat(31), () => assert.throws(auth.resolveJwtSecret, /too short \(31 chars/));
  withSecret(`  ${'a'.repeat(32)}  `, () => assert.equal(auth.resolveJwtSecret(), 'a'.repeat(32)));
});

test('a generated token verifies and carries its payload', () => {
  const decoded = auth.verifyToken(auth.generateToken({ id: 'r1', email: 'r1@example.com' }));
  assert.equal(decoded.id, 'r1');
  assert.equal(decoded.email, 'r1@example.com');
});

test('verifyToken returns null for garbage and for a token signed with another key', () => {
  const jwt = require('jsonwebtoken');
  assert.equal(auth.verifyToken('not-a-token'), null);
  assert.equal(auth.verifyToken(jwt.sign({ id: 'r1' }, 'y'.repeat(48))), null);
});

test('cookieOptions follows COOKIE_SECURE', () => {
  process.env.COOKIE_SECURE = 'true';
  assert.equal(auth.cookieOptions().secure, true);
  process.env.COOKIE_SECURE = 'false';
  const opts = auth.cookieOptions();
  assert.equal(opts.secure, false);
  assert.equal(opts.httpOnly, true);
  assert.equal(opts.sameSite, 'lax');
});

test('requireAdmin lets admins through and rejects everyone else', () => {
  const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

  let called = false;
  auth.requireAdmin({ user: { is_admin: 1 } }, res(), () => { called = true; });
  assert.equal(called, true);

  for (const req of [{ user: { is_admin: 0 } }, {}]) {
    const r = res();
    auth.requireAdmin(req, r, () => assert.fail('next should not be called'));
    assert.equal(r.code, 403);
  }
});
