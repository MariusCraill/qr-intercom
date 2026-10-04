const { run } = require('./db');

let client = null;
let io = null;
let connected = false;
let lastErrorAt = 0;

function initMQTT(socketIo) {
  io = socketIo;
  const broker = process.env.MQTT_BROKER;

  if (!broker) {
    console.log('[MQTT] No broker configured, MQTT disabled');
    return null;
  }

  // Required lazily: the mqtt package is expensive to load and is not needed
  // when no gate broker is configured.
  const mqtt = require('mqtt');

  const options = { reconnectPeriod: 5000, connectTimeout: 10000 };
  if (process.env.MQTT_GATE_USERNAME) {
    options.username = process.env.MQTT_GATE_USERNAME;
    options.password = process.env.MQTT_GATE_PASSWORD;
  }

  client = mqtt.connect(broker, options);

  client.on('connect', () => {
    connected = true;
    console.log('[MQTT] Connected to', broker);
    // Only status topics: subscribing to gates/# would echo our own commands back.
    client.subscribe('gates/+/status', { qos: 1 }, (err) => {
      if (err) console.error('[MQTT] Subscribe error:', err.message);
      else console.log('[MQTT] Subscribed to gates/+/status');
    });
  });

  // A down broker retries forever, so only log the first attempt and then
  // every 30 seconds to keep the console readable.
  let reconnectLoggedAt = 0;
  client.on('reconnect', () => {
    const now = Date.now();
    if (now - reconnectLoggedAt < 30000) return;
    reconnectLoggedAt = now;
    console.log(`[MQTT] Reconnecting to ${broker}...`);
  });
  client.on('close', () => { connected = false; });
  client.on('offline', () => { connected = false; });

  client.on('message', (topic, message) => {
    const parts = topic.split('/');
    if (parts.length === 3 && parts[0] === 'gates' && parts[2] === 'status') {
      const gateId = parts[1];
      const status = message.toString();
      // Residents and the dashboard only; anonymous kiosk/visitor sockets don't need it.
      if (io) io.to('residents').emit('gate:status', { gateId, status });
    }
  });

  client.on('error', (err) => {
    // A down broker retries forever; log at most once a minute.
    const now = Date.now();
    if (now - lastErrorAt < 60000) return;
    lastErrorAt = now;
    console.error(`[MQTT] Cannot reach ${broker}: ${err.message || err.code || 'connection refused'}`);
  });

  return client;
}

function sendGateCommand(gateId, command) {
  if (!client || !connected) {
    console.log('[MQTT] Not connected, cannot send command');
    return false;
  }
  if (!gateId) {
    console.log('[MQTT] No gate id supplied, dropping command');
    return false;
  }

  const topic = `gates/${gateId}/command`;
  const action = command.type || 'command';
  client.publish(topic, JSON.stringify({ ...command, ts: Date.now() }), { qos: 1 }, (err) => {
    if (err) console.error('[MQTT] Publish failed:', err.message);
    // Record what actually reached the broker, not just what was attempted.
    logAccess(command.residentId || null, gateId, err ? `${action}-failed` : action);
  });
  return true;
}

function unlockGate(gateId, residentId) {
  return sendGateCommand(gateId, { type: 'unlock', duration: 5000, residentId });
}

// access_logs.id is an autoincrement column, so let SQLite assign it.
function logAccess(residentId, gateId, action) {
  run('INSERT INTO access_logs (gate_id, resident_id, action) VALUES (?, ?, ?)', [gateId, residentId, action]);
}

function isConnected() {
  return Boolean(client && connected);
}

function getClient() {
  return client;
}

module.exports = { initMQTT, sendGateCommand, unlockGate, logAccess, isConnected, getClient };
