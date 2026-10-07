const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');

const { isConnected: isMQTTConnected } = require('./mqtt');
const apiRoutes = require('./routes/api');
const gateRoutes = require('./routes/gate');
const residentRoutes = require('./routes/resident');

const PUBLIC_DIR = path.join(__dirname, '../public');

// The pages need inline <script>, so allow inline rather than breaking them.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'";

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
}

function corsMiddleware(corsOrigin) {
  if (!corsOrigin || corsOrigin === '*') {
    // Credentialed requests cannot use `Access-Control-Allow-Origin: *`, so
    // same-origin (the normal case) is left untouched and cross-origin is closed.
    return (req, res, next) => {
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    };
  }

  const allowed = corsOrigin.split(',').map((s) => s.trim());
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

const sendPage = (file) => (req, res) => res.sendFile(file, { root: PUBLIC_DIR });

// Builds the Express app without listening, so it can be booted by index.js or
// mounted on an ephemeral port by the tests. The database must be initialised first.
function createApp({ getStartedAt = () => null } = {}) {
  const app = express();
  // Only trust X-Forwarded-* when a proxy is actually in front, otherwise any
  // client can spoof its IP and slip past the login rate limiter.
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(corsMiddleware(process.env.CORS_ORIGIN));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

  app.get('/healthz', (req, res) => {
    res.json({
      ok: true,
      status: 'ready',
      uptime: Math.round(process.uptime()),
      startedAt: getStartedAt(),
      mqtt: isMQTTConnected()
    });
  });

  app.use('/api', apiRoutes);
  app.use('/gate', gateRoutes);
  app.use('/resident', residentRoutes);
  app.get('/call/:residentId', sendPage('call.html'));
  app.get('/test', sendPage('test.html'));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[HTTP]', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
