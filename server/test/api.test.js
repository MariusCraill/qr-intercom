const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, login, ADMIN_EMAIL } = require('./helpers');

let srv;
let request;
let adminToken;

// Resident created through the admin API; filled in by the first resident test.
const alice = { name: 'Alice Test', apartment: '9Z', email: 'alice@test.local', password: 'alice-password' };

test.before(async () => {
  srv = await startServer({ env: { LOGIN_RATE_LIMIT: '3' } });
  request = client(srv.baseUrl);
  adminToken = await login(request);
});

test.after(() => srv.close());

test('GET /healthz reports ready', async () => {
  const res = await request('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'ready');
  assert.equal(res.body.mqtt, false);
});

test('every response carries the security headers', async () => {
  const res = await request('GET', '/healthz');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('unknown routes return a JSON 404', async () => {
  const res = await request('GET', '/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found' });
});

test('pages are served for the dashboard, resident app, call link and known gates', async () => {
  for (const url of ['/', '/resident/', '/resident/some-call', '/call/anyone', '/gate/front-gate']) {
    const res = await request('GET', url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /text\/html/, url);
  }
  const missing = await request('GET', '/gate/no-such-gate');
  assert.equal(missing.status, 404);
  assert.equal(missing.text, 'Gate not found');
});

test('OPTIONS preflight is answered with 204 and no CORS grant by default', async () => {
  const res = await request('OPTIONS', '/api/auth/me', { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('login: missing fields, wrong password and success', async () => {
  assert.equal((await request('POST', '/api/auth/login', { body: {} })).status, 400);

  const success = await request('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'admin-test-password' } });
  assert.equal(success.status, 200);
  assert.equal(success.body.user.email, ADMIN_EMAIL);
  assert.equal(success.body.user.is_admin, 1);
  assert.equal(success.body.user.password, undefined);
  assert.match(success.headers.get('set-cookie'), /token=.*HttpOnly/i);
});

test('the seeded demo accounts do not share the admin password', async () => {
  const res = await request('POST', '/api/auth/login', { body: { email: 'alice@demo.com', password: 'admin-test-password' } });
  assert.equal(res.status, 401);
});

test('/api/auth/me needs a valid token, from a header or the cookie', async () => {
  assert.equal((await request('GET', '/api/auth/me')).status, 401);
  assert.equal((await request('GET', '/api/auth/me', { token: 'bogus' })).status, 401);

  const viaHeader = await request('GET', '/api/auth/me', { token: adminToken });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.body.user.email, ADMIN_EMAIL);

  const viaCookie = await request('GET', '/api/auth/me', { headers: { Cookie: `token=${adminToken}` } });
  assert.equal(viaCookie.status, 200);
});

test('self-registration is off by default', async () => {
  const res = await request('POST', '/api/auth/register', { body: { ...alice, email: 'new@test.local' } });
  assert.equal(res.status, 403);
});

test('admin can create a resident, with validation', async () => {
  const create = (body) => request('POST', '/api/residents', { token: adminToken, body });

  assert.equal((await create({ name: 'x' })).status, 400);
  const short = await create({ ...alice, password: 'short' });
  assert.equal(short.status, 400);
  assert.equal(short.body.error, 'Password must be at least 8 characters');

  const res = await create(alice);
  assert.equal(res.status, 201);
  assert.equal(res.body.email, alice.email);
  assert.equal(res.body.is_admin, 0);
  alice.id = res.body.id;

  assert.equal((await create(alice)).status, 409);
});

test('a new resident can sign in but cannot use admin routes', async () => {
  alice.token = await login(request, alice.email, alice.password);
  for (const [method, url] of [
    ['GET', '/api/residents'],
    ['GET', '/api/gates'],
    ['GET', '/api/logs/calls'],
    ['GET', '/api/logs/access'],
    ['GET', `/api/residents/${alice.id}/qr`],
    ['DELETE', `/api/residents/${alice.id}`]
  ]) {
    assert.equal((await request(method, url, { token: alice.token })).status, 403, `${method} ${url}`);
  }
  const mine = await request('GET', '/api/calls/mine', { token: alice.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body, []);
});

test('admin listing includes the new resident without password hashes', async () => {
  const res = await request('GET', '/api/residents', { token: adminToken });
  assert.equal(res.status, 200);
  const row = res.body.find((r) => r.id === alice.id);
  assert.equal(row.name, alice.name);
  assert.ok(res.body.every((r) => r.password === undefined));
});

test('updating a resident keeps the password unless a new one is given', async () => {
  const update = (body) => request('PUT', `/api/residents/${alice.id}`, { token: adminToken, body });
  const base = { name: 'Alice Renamed', apartment: '9Z', email: alice.email };

  assert.equal((await update({ name: 'x' })).status, 400);
  assert.equal((await update({ ...base, password: 'short' })).status, 400);
  assert.equal((await update({ ...base, email: ADMIN_EMAIL })).status, 409);
  assert.equal((await request('PUT', '/api/residents/missing', { token: adminToken, body: { ...base, email: 'nobody@test.local' } })).status, 404);

  assert.equal((await update(base)).status, 200);
  await login(request, alice.email, alice.password);

  assert.equal((await update({ ...base, password: 'a-new-password' })).status, 200);
  await login(request, alice.email, 'a-new-password');
  alice.password = 'a-new-password';

  const me = await request('GET', '/api/auth/me', { token: alice.token });
  assert.equal(me.body.user.name, 'Alice Renamed');
});

test('an admin cannot demote or delete themselves', async () => {
  const me = (await request('GET', '/api/auth/me', { token: adminToken })).body.user;
  const demote = await request('PUT', `/api/residents/${me.id}`, {
    token: adminToken,
    body: { name: me.name, apartment: me.apartment, email: me.email, is_admin: false }
  });
  assert.equal(demote.status, 400);
  assert.equal((await request('DELETE', `/api/residents/${me.id}`, { token: adminToken })).status, 400);
});

test('public resident and gate lookups expose only safe fields', async () => {
  const resident = await request('GET', `/api/public/resident/${alice.id}`);
  assert.equal(resident.status, 200);
  assert.deepEqual(Object.keys(resident.body).sort(), ['apartment', 'id', 'name']);
  assert.equal((await request('GET', '/api/public/resident/missing')).status, 404);

  const gate = await request('GET', '/api/public/gates/front-gate');
  assert.equal(gate.status, 200);
  assert.deepEqual(gate.body, { id: 'front-gate', name: 'Front Gate', location: 'Main entrance' });
  assert.equal((await request('GET', '/api/public/gates/missing')).status, 404);
});

test('QR codes link to the resident call page on the request host', async () => {
  const res = await request('GET', `/api/residents/${alice.id}/qr`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.url, `${srv.baseUrl}/call/${alice.id}`);
  assert.match(res.body.qr, /^data:image\/png;base64,/);
  assert.equal(res.body.resident.id, alice.id);

  assert.equal((await request('GET', '/api/residents/missing/qr', { token: adminToken })).status, 404);

  const all = await request('GET', '/api/residents/qr-all', { token: adminToken });
  assert.equal(all.status, 200);
  assert.ok(all.body.length >= 6);
  assert.ok(all.body.every((e) => e.url === `${srv.baseUrl}/call/${e.resident.id}` && e.qr.startsWith('data:image/png')));
});

test('PUBLIC_BASE_URL wins over the Host header, without a trailing slash', async () => {
  process.env.PUBLIC_BASE_URL = 'https://intercom.example/';
  try {
    const res = await request('GET', `/api/residents/${alice.id}/qr`, { token: adminToken });
    assert.equal(res.body.url, `https://intercom.example/call/${alice.id}`);
  } finally {
    process.env.PUBLIC_BASE_URL = '';
  }
});

test('gates: admin can add and remove one; it gets its own MQTT topic', async () => {
  assert.equal((await request('POST', '/api/gates', { token: adminToken, body: {} })).status, 400);

  const created = await request('POST', '/api/gates', { token: adminToken, body: { name: 'Side Gate', location: 'Alley' } });
  assert.equal(created.status, 201);
  const { id } = created.body;

  const list = await request('GET', '/api/gates', { token: adminToken });
  const gate = list.body.find((g) => g.id === id);
  assert.equal(gate.mqtt_topic, `gates/${id}/command`);

  assert.equal((await request('DELETE', `/api/gates/${id}`, { token: adminToken })).status, 200);
  assert.equal((await request('GET', `/api/public/gates/${id}`)).status, 404);
});

test('admin can delete a resident, which ends their session', async () => {
  assert.equal((await request('DELETE', `/api/residents/${alice.id}`, { token: adminToken })).status, 200);
  assert.equal((await request('GET', '/api/auth/me', { token: alice.token })).status, 401);
});

test('logout clears the cookie', async () => {
  const res = await request('POST', '/api/auth/logout');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /token=;/);
});

// Runs last: it locks this client's IP out of /api/auth/login.
test('repeated failed logins are rate limited', async () => {
  const attempt = () => request('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong' } });
  for (let i = 0; i < 3; i++) assert.equal((await attempt()).status, 401);

  const blocked = await attempt();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  // Even the right password is refused until the window passes.
  const right = await request('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'admin-test-password' } });
  assert.equal(right.status, 429);
});
