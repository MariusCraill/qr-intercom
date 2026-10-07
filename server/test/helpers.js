// Shared setup for the server tests. Each test file runs in its own process
// (node --test), so the environment set here is private to that file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ADMIN_EMAIL = 'admin';
const ADMIN_PASSWORD = 'admin-test-password';

function configureEnv(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-intercom-test-'));
  Object.assign(process.env, {
    JWT_SECRET: 'x'.repeat(48),
    DB_PATH: path.join(dataDir, 'intercom.db'),
    ADMIN_USERNAME: ADMIN_EMAIL,
    ADMIN_PASSWORD,
    ALLOW_REGISTRATION: 'false',
    PUBLIC_BASE_URL: '',
    CORS_ORIGIN: '',
    ...overrides
  });
  delete process.env.MQTT_BROKER;
  return dataDir;
}

// The server is chatty; keep test output readable unless asked otherwise.
function quietConsole() {
  if (process.env.TEST_VERBOSE) return;
  console.log = () => {};
  console.warn = () => {};
}

// Boots the app (and optionally Socket.IO) on an ephemeral port.
async function startServer({ env, webrtc = false } = {}) {
  configureEnv(env);
  quietConsole();

  const { initDatabase } = require('../src/db');
  const { createApp } = require('../src/app');
  await initDatabase();

  const server = http.createServer(createApp());
  const io = webrtc ? require('../src/webrtc').initWebRTC(server) : null;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    if (io) await new Promise((resolve) => io.close(resolve));
    else await new Promise((resolve) => server.close(resolve));
  }

  return { server, baseUrl, close };
}

// Small fetch wrapper that sends JSON and parses JSON back.
function client(baseUrl) {
  return async function request(method, url, { body, token, headers = {} } = {}) {
    const res = await fetch(baseUrl + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body: json, text };
  };
}

async function login(request, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const res = await request('POST', '/api/auth/login', { body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  return res.body.token;
}

module.exports = { ADMIN_EMAIL, ADMIN_PASSWORD, configureEnv, quietConsole, startServer, client, login };
