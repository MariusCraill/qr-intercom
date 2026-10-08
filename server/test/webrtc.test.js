const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { startServer, client, login } = require('./helpers');

const RING_TIMEOUT_MS = 400;

let srv;
let request;
const tokens = {};
const ids = {};
const sockets = [];

function socket(token) {
  const s = connect(srv.baseUrl, { transports: ['websocket'], auth: token ? { token } : {}, forceNew: true });
  sockets.push(s);
  return s;
}

function connected(s) {
  return new Promise((resolve, reject) => {
    if (s.connected) return resolve(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function next(s, event, ms = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    s.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });
}

// Resolves if the event does NOT arrive within the window.
function silence(s, event, ms = 150) {
  return new Promise((resolve, reject) => {
    const handler = (data) => reject(new Error(`unexpected ${event}: ${JSON.stringify(data)}`));
    s.once(event, handler);
    setTimeout(() => { s.off(event, handler); resolve(); }, ms);
  });
}

// One visitor, two signed-in residents and an anonymous bystander.
async function cast() {
  const [visitor, alice, bob, bystander] = await Promise.all([
    connected(socket()),
    connected(socket(tokens.alice)),
    connected(socket(tokens.bob)),
    connected(socket())
  ]);
  return { visitor, alice, bob, bystander };
}

async function ringGate(visitor, residents) {
  const incoming = residents.map((r) => next(r, 'call:incoming'));
  const requested = next(visitor, 'call:requested');
  visitor.emit('call:request', { gateId: 'front-gate', visitorId: 'v-1' });
  const { callId } = await requested;
  await Promise.all(incoming);
  return callId;
}

async function answer(resident, visitor, callId) {
  const answered = next(visitor, 'call:answered');
  resident.emit('call:answer', { callId });
  await answered;
}

const callLog = (id) => require('../src/db').getOne('SELECT * FROM call_logs WHERE id = ?', [id]);

test.before(async () => {
  srv = await startServer({ webrtc: true, env: { RING_TIMEOUT_MS: String(RING_TIMEOUT_MS) } });
  request = client(srv.baseUrl);
  const admin = await login(request);
  tokens.admin = admin;
  for (const name of ['alice', 'bob']) {
    const res = await request('POST', '/api/residents', {
      token: admin,
      body: { name, apartment: name, email: `${name}@test.local`, password: `${name}-password` }
    });
    ids[name] = res.body.id;
    tokens[name] = await login(request, `${name}@test.local`, `${name}-password`);
  }
});

test.afterEach(() => {
  for (const s of sockets.splice(0)) s.disconnect();
});

test.after(() => srv.close());

test('a bad handshake token is rejected', async () => {
  await assert.rejects(connected(socket('bogus')), /invalid token/);
});

test('ringing an unknown gate is an error', async () => {
  const visitor = await connected(socket());
  const error = next(visitor, 'call:error');
  visitor.emit('call:request', { gateId: 'no-such-gate' });
  assert.deepEqual(await error, { error: 'Gate not found' });
});

test('a gate call rings every resident but no anonymous socket', async () => {
  const { visitor, alice, bob, bystander } = await cast();
  const quiet = silence(bystander, 'call:incoming');
  const aliceRing = next(alice, 'call:incoming');
  const bobRing = next(bob, 'call:incoming');
  const requested = next(visitor, 'call:requested');
  visitor.emit('call:request', { gateId: 'front-gate', visitorId: 'v-1' });

  const { callId, gateId } = await requested;
  assert.equal(gateId, 'front-gate');
  for (const ring of [await aliceRing, await bobRing]) {
    assert.equal(ring.callId, callId);
    assert.equal(ring.visitorId, 'v-1');
  }
  await quiet;
  assert.equal(callLog(callId).status, 'ringing');
});

test('only a signed-in resident may answer, and only once', async () => {
  const { visitor, alice, bob, bystander } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);

  const anonError = next(bystander, 'call:error');
  bystander.emit('call:answer', { callId });
  assert.deepEqual(await anonError, { error: 'Authentication required' });

  const bobStops = next(bob, 'call:ended');
  await answer(alice, visitor, callId);
  assert.deepEqual(await bobStops, { callId, reason: 'answered-elsewhere' });

  const log = callLog(callId);
  assert.equal(log.status, 'active');
  assert.equal(log.resident_id, ids.alice);

  const late = next(bob, 'call:error');
  bob.emit('call:answer', { callId });
  assert.deepEqual(await late, { error: 'Call already answered' });
});

test('WebRTC signalling flows only between the two ends of a call', async () => {
  const { visitor, alice, bob, bystander } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);
  await answer(alice, visitor, callId);

  const offer = next(alice, 'webrtc:offer');
  visitor.emit('webrtc:offer', { callId, offer: { sdp: 'v-offer' }, extra: 'dropped' });
  assert.deepEqual(await offer, { callId, offer: { sdp: 'v-offer' } });

  const reply = next(visitor, 'webrtc:answer');
  alice.emit('webrtc:answer', { callId, answer: { sdp: 'a-answer' } });
  assert.deepEqual(await reply, { callId, answer: { sdp: 'a-answer' } });

  const candidate = next(alice, 'webrtc:ice-candidate');
  visitor.emit('webrtc:ice-candidate', { callId, candidate: { c: 1 } });
  assert.deepEqual(await candidate, { callId, candidate: { c: 1 } });

  // Neither another resident nor a bystander can inject into the call.
  const visitorQuiet = silence(visitor, 'webrtc:offer');
  const aliceQuiet = silence(alice, 'webrtc:offer');
  bob.emit('webrtc:offer', { callId, offer: { sdp: 'bob' } });
  bystander.emit('webrtc:offer', { callId, offer: { sdp: 'bystander' } });
  await Promise.all([visitorQuiet, aliceQuiet]);
});

test('only the answering resident (or an admin) can unlock, once, and only after answering', async (t) => {
  const mqtt = require('../src/mqtt');
  const unlocks = [];
  t.mock.method(mqtt, 'unlockGate', (gateId, residentId) => { unlocks.push({ gateId, residentId }); return true; });

  const { visitor, alice, bob } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);

  // While it rings, anyone who taps unlock is told to answer first.
  const early = next(alice, 'call:error');
  alice.emit('call:unlock', { callId });
  assert.deepEqual(await early, { error: 'Answer the call before unlocking' });

  const admin = await connected(socket(tokens.admin));
  const adminEarly = next(admin, 'call:error');
  admin.emit('call:unlock', { callId });
  assert.deepEqual(await adminEarly, { error: 'Answer the call before unlocking' });

  await answer(alice, visitor, callId);

  const denied = next(bob, 'call:error');
  bob.emit('call:unlock', { callId });
  assert.deepEqual(await denied, { error: 'Not authorized to unlock' });

  const unlocked = next(visitor, 'gate:unlocked');
  alice.emit('call:unlock', { callId });
  assert.deepEqual(await unlocked, { callId });
  assert.deepEqual(unlocks, [{ gateId: 'front-gate', residentId: ids.alice }]);

  const again = next(alice, 'call:error');
  alice.emit('call:unlock', { callId });
  assert.deepEqual(await again, { error: 'Gate already unlocked for this call' });
  assert.equal(unlocks.length, 1);
});

test('an unreachable gate controller is reported and does not use up the unlock', async (t) => {
  const mqtt = require('../src/mqtt');
  const unlockGate = t.mock.method(mqtt, 'unlockGate', () => false);

  const { visitor, alice, bob } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);
  await answer(alice, visitor, callId);

  const error = next(alice, 'call:error');
  alice.emit('call:unlock', { callId });
  assert.deepEqual(await error, { error: 'Gate controller unreachable' });

  unlockGate.mock.mockImplementation(() => true);
  const unlocked = next(visitor, 'gate:unlocked');
  alice.emit('call:unlock', { callId });
  await unlocked;
});

test('ending a call notifies both ends and logs it', async () => {
  const { visitor, alice, bob, bystander } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);
  await answer(alice, visitor, callId);

  // A bystander cannot hang up someone else's call.
  bystander.emit('call:end', { callId });
  await silence(visitor, 'call:ended');

  const visitorEnded = next(visitor, 'call:ended');
  const aliceEnded = next(alice, 'call:ended');
  visitor.emit('call:end', { callId });
  assert.deepEqual(await visitorEnded, { callId });
  assert.deepEqual(await aliceEnded, { callId });

  const log = callLog(callId);
  assert.equal(log.status, 'ended');
  assert.ok(log.ended_at);
  assert.ok(log.duration >= 0);
});

test('a resident disconnecting ends the call', async () => {
  const { visitor, alice, bob } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);
  await answer(alice, visitor, callId);

  const ended = next(visitor, 'call:ended');
  alice.disconnect();
  assert.deepEqual(await ended, { callId });
  assert.equal(callLog(callId).status, 'ended');
});

test('a direct call rings only its resident, and nobody else may answer it', async () => {
  const { visitor, alice, bob } = await cast();
  const bobQuiet = silence(bob, 'call:direct-incoming');
  const ring = next(alice, 'call:direct-incoming');
  const requested = next(visitor, 'call:requested');
  visitor.emit('call:direct-request', { residentId: ids.alice });

  const { callId, residentId } = await requested;
  assert.equal(residentId, ids.alice);
  const incoming = await ring;
  assert.equal(incoming.callId, callId);
  assert.equal(incoming.residentName, 'alice');
  assert.match(incoming.visitorId, /^visitor-/);
  await bobQuiet;

  const denied = next(bob, 'call:error');
  bob.emit('call:answer', { callId });
  assert.deepEqual(await denied, { error: 'Not your call' });

  await answer(alice, visitor, callId);

  // A direct call has no gate, so there is nothing to unlock.
  const noGate = next(alice, 'call:error');
  alice.emit('call:unlock', { callId });
  assert.deepEqual(await noGate, { error: 'This call has no gate attached' });
});

test('a direct call to an unknown resident is an error', async () => {
  const visitor = await connected(socket());
  const error = next(visitor, 'call:error');
  visitor.emit('call:direct-request', { residentId: 'missing' });
  assert.deepEqual(await error, { error: 'Resident not found' });
});

test('a resident may only join their own room', async () => {
  const { alice, bystander } = await cast();
  const anon = next(bystander, 'call:error');
  bystander.emit('call:resident-join', { residentId: ids.alice });
  assert.deepEqual(await anon, { error: 'Authentication required' });

  const other = next(alice, 'call:error');
  alice.emit('call:resident-join', { residentId: ids.bob });
  assert.deepEqual(await other, { error: 'Not allowed to join this room' });
});

test('an unanswered call is closed out as missed', async () => {
  const { visitor, alice, bob } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);

  const visitorEnded = next(visitor, 'call:ended', RING_TIMEOUT_MS * 5);
  const aliceEnded = next(alice, 'call:ended', RING_TIMEOUT_MS * 5);
  assert.deepEqual(await visitorEnded, { callId, reason: 'no-answer' });
  assert.deepEqual(await aliceEnded, { callId, reason: 'no-answer' });

  const log = callLog(callId);
  assert.equal(log.status, 'missed');
  assert.equal(log.duration, 0);
});

test('a visitor can ring only one call at a time', async () => {
  const { visitor, alice, bob } = await cast();
  const callId = await ringGate(visitor, [alice, bob]);

  const refused = next(visitor, 'call:error');
  visitor.emit('call:request', { gateId: 'front-gate' });
  assert.deepEqual(await refused, { error: 'A call is already in progress' });

  const refusedDirect = next(visitor, 'call:error');
  visitor.emit('call:direct-request', { residentId: ids.alice });
  assert.deepEqual(await refusedDirect, { error: 'A call is already in progress' });

  // Once the first call is over the visitor can ring again.
  const ended = next(visitor, 'call:ended');
  visitor.emit('call:end', { callId });
  await ended;
  const requested = next(visitor, 'call:requested');
  visitor.emit('call:request', { gateId: 'front-gate' });
  const again = await requested;
  assert.notEqual(again.callId, callId);
  visitor.emit('call:end', { callId: again.callId });
});

test('deleting a resident drops their open sockets', async () => {
  const created = await request('POST', '/api/residents', {
    token: tokens.admin,
    body: { name: 'Erin', apartment: '6E', email: 'erin@example.com', password: 'erin-password' }
  });
  const erinToken = await login(request, 'erin@example.com', 'erin-password');
  const erin = await connected(socket(erinToken));

  const dropped = next(erin, 'disconnect');
  const res = await request('DELETE', `/api/residents/${created.body.id}`, { token: tokens.admin });
  assert.equal(res.status, 200);
  assert.equal(await dropped, 'io server disconnect');
});
