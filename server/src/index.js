require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { initDatabase, flushDatabase } = require('./db');
const { initMQTT } = require('./mqtt');
const { initWebRTC } = require('./webrtc');
const { createApp } = require('./app');

const PORT = parseInt(process.env.PORT) || 3100;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT) || 3143;
const CERT_DIR = path.join(__dirname, '../../.certs');
const servers = [];
const BOOTED_AT = Date.now();
let STARTED_AT = null;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  let fallback = null;
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('192.168.')) return iface.address;
      fallback = fallback || iface.address;
    }
  }
  return fallback || '127.0.0.1';
}

function banner(localIP, certFingerprint) {
  const lines = [
    '',
    '========================================',
    '  QR Video Intercom Server',
    '========================================',
    `  Local IP:  ${localIP}`,
    `  HTTP:      http://${localIP}:${PORT}`,
    `  HTTPS:     https://${localIP}:${HTTPS_PORT}   <- use this for camera/mic`,
    `  Dashboard: http://${localIP}:${PORT}/`,
    `  Resident:  http://${localIP}:${PORT}/resident/`,
    `  Gate:      http://${localIP}:${PORT}/gate/<gateId>`,
    // The Android app shows this on first connect so it can be checked by eye.
    ...(certFingerprint ? ['', '  HTTPS certificate SHA-256:', `  ${certFingerprint}`] : []),
    '========================================',
    ''
  ];
  console.log(lines.join('\n'));
}

// Reuse one self-signed cert so phones do not get a new warning on every restart.
function loadOrCreateCert(localIP) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  // Required lazily: generating a cert is a rare, one-off path and this
  // package is slow to load.
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'qr-intercom' }], {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: localIP }
      ]
    }]
  });

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  console.log('[HTTPS] Generated self-signed certificate in', CERT_DIR);
  return { key: pems.private, cert: pems.cert };
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`${label} port ${port} is already in use. Change it in server/.env and restart.`));
      } else {
        reject(err);
      }
    });
    server.listen(port, '0.0.0.0', () => {
      servers.push(server);
      resolve();
    });
  });
}

async function start() {
  await initDatabase();
  const app = createApp({ getStartedAt: () => STARTED_AT });

  const localIP = getLocalIP();
  const httpServer = http.createServer(app);

  // HTTPS is optional; HTTP is the source of truth for readiness.
  let httpsServer = null;
  let certFingerprint = null;
  try {
    const tls = loadOrCreateCert(localIP);
    httpsServer = https.createServer(tls, app);
    certFingerprint = new crypto.X509Certificate(tls.cert).fingerprint256;
  } catch (err) {
    console.warn('[HTTPS] Disabled:', err.message);
  }

  const io = initWebRTC(httpServer, httpsServer);
  initMQTT(io);

  await listen(httpServer, PORT, 'HTTP');
  if (httpsServer) {
    try {
      await listen(httpsServer, HTTPS_PORT, 'HTTPS');
    } catch (err) {
      console.warn(`[HTTPS] Disabled: ${err.message}`);
    }
  }

  banner(localIP, httpsServer && httpsServer.listening ? certFingerprint : null);
  STARTED_AT = new Date().toISOString();
  console.log(`[SRV] Ready after ${((Date.now() - BOOTED_AT) / 1000).toFixed(1)}s\n`);

  const shutdown = (signal) => {
    console.log(`\n[SRV] ${signal} received, shutting down`);
    flushDatabase();
    for (const s of servers) s.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => console.error('[SRV] Uncaught:', err));
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
