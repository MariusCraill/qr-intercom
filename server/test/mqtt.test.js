const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { configureEnv, quietConsole } = require('./helpers');

configureEnv();
quietConsole();
const db = require('../src/db');
const gateMqtt = require('../src/mqtt');

// Stands in for the mqtt package's client.
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.subscriptions = [];
    this.published = [];
    this.publishError = null;
  }
  subscribe(topic, opts, cb) { this.subscriptions.push(topic); cb(null); }
  publish(topic, payload, opts, cb) { this.published.push({ topic, payload: JSON.parse(payload) }); cb(this.publishError); }
}

const lastAccess = () => db.getOne('SELECT gate_id, resident_id, action FROM access_logs ORDER BY id DESC LIMIT 1');

test.before(() => db.initDatabase());

test('without a broker, MQTT stays off and commands are refused', () => {
  assert.equal(gateMqtt.initMQTT(null), null);
  assert.equal(gateMqtt.isConnected(), false);
  assert.equal(gateMqtt.unlockGate('front-gate', 'r1'), false);
});

test('with a broker: subscribes to status, relays it, and publishes unlocks', async (t) => {
  const fake = new FakeClient();
  const connect = t.mock.fn(() => fake);
  const emitted = [];
  const io = { to: (room) => ({ emit: (event, data) => emitted.push({ room, event, data }) }) };

  process.env.MQTT_BROKER = 'mqtt://broker.test:1883';
  process.env.MQTT_GATE_USERNAME = 'gate-user';
  process.env.MQTT_GATE_PASSWORD = 'gate-pass';
  assert.equal(gateMqtt.initMQTT(io, { connect }), fake);

  const [broker, options] = connect.mock.calls[0].arguments;
  assert.equal(broker, 'mqtt://broker.test:1883');
  assert.equal(options.username, 'gate-user');
  assert.equal(options.password, 'gate-pass');

  assert.equal(gateMqtt.isConnected(), false);
  fake.emit('connect');
  assert.equal(gateMqtt.isConnected(), true);
  assert.deepEqual(fake.subscriptions, ['gates/+/status']);

  // Status updates go to signed-in residents only; anything else is ignored.
  fake.emit('message', 'gates/front-gate/status', Buffer.from('open'));
  fake.emit('message', 'gates/front-gate/command', Buffer.from('{}'));
  fake.emit('message', 'other/topic', Buffer.from('x'));
  assert.deepEqual(emitted, [{ room: 'residents', event: 'gate:status', data: { gateId: 'front-gate', status: 'open' } }]);

  assert.equal(gateMqtt.unlockGate('front-gate', 'r1'), true);
  const { topic, payload } = fake.published[0];
  assert.equal(topic, 'gates/front-gate/command');
  assert.equal(payload.type, 'unlock');
  assert.equal(payload.duration, 5000);
  assert.equal(payload.residentId, 'r1');
  assert.equal(typeof payload.ts, 'number');
  assert.deepEqual(lastAccess(), { gate_id: 'front-gate', resident_id: 'r1', action: 'unlock' });

  // A publish the broker rejects is logged as a failure.
  fake.publishError = new Error('nope');
  gateMqtt.unlockGate('front-gate', 'r1');
  assert.deepEqual(lastAccess(), { gate_id: 'front-gate', resident_id: 'r1', action: 'unlock-failed' });

  // Without a gate id nothing is sent.
  assert.equal(gateMqtt.sendGateCommand('', { type: 'unlock' }), false);
  assert.equal(fake.published.length, 2);

  fake.emit('offline');
  assert.equal(gateMqtt.isConnected(), false);
  assert.equal(gateMqtt.unlockGate('front-gate', 'r1'), false);
});
