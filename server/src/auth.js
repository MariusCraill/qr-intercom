const jwt = require('jsonwebtoken');
const { getOne } = require('./db');

// A missing or predictable signing key lets anyone who has read this source mint a
// valid session for any user, admin included. Refuse to boot rather than fall back
// to a known value.
const PLACEHOLDER_SECRETS = new Set([
  'dev-secret',
  'secret',
  'changeme',
  'change-me-to-a-real-secret-in-production'
]);

const GENERATE_HINT =
  'Generate one and put it in server/.env:\n' +
  '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

function resolveJwtSecret() {
  const secret = (process.env.JWT_SECRET || '').trim();

  if (!secret) {
    throw new Error(`JWT_SECRET is not set. ${GENERATE_HINT}`);
  }

  if (PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    throw new Error(`JWT_SECRET is still the placeholder from .env.example. ${GENERATE_HINT}`);
  }

  if (secret.length < 32) {
    throw new Error(`JWT_SECRET is too short (${secret.length} chars, need 32+). ${GENERATE_HINT}`);
  }

  return secret;
}

const JWT_SECRET = resolveJwtSecret();

// The fields a session carries around; never the password hash.
function findUserById(id) {
  return getOne('SELECT id, name, email, apartment, is_admin FROM residents WHERE id = ?', [id]);
}
const TOKEN_TTL = process.env.TOKEN_TTL || '7d';

// ---------- brute force protection ----------
const MAX_ATTEMPTS = parseInt(process.env.LOGIN_RATE_LIMIT) || 10;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map(); // ip -> { count, firstAt }

function clientKey(req) {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function loginRateLimit(req, res, next) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && now - entry.firstAt < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    const retryIn = Math.ceil((WINDOW_MS - (now - entry.firstAt)) / 1000);
    res.set('Retry-After', String(retryIn));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${retryIn}s.` });
  }

  if (!entry || now - entry.firstAt >= WINDOW_MS) attempts.set(key, { count: 0, firstAt: now });
  next();
}

function registerFailedLogin(req) {
  const key = clientKey(req);
  const entry = attempts.get(key) || { count: 0, firstAt: Date.now() };
  entry.count += 1;
  attempts.set(key, entry);
}

function clearFailedLogins(req) {
  attempts.delete(clientKey(req));
}

// keep the map from growing unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAt >= WINDOW_MS) attempts.delete(key);
  }
}, WINDOW_MS).unref();

function cookieOptions() {
  return {
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true'
  };
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function extractToken(req) {
  const bearer = req.headers.authorization || '';
  return req.cookies?.token || (bearer.startsWith('Bearer ') ? bearer.slice(7) : null);
}

function authMiddleware(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  const user = findUserById(decoded.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.user = user;
  next();
}

// Any logged-in resident may see their own data; admin routes must be gated.
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.user = findUserById(decoded.id);
    }
  }
  next();
}

module.exports = {
  resolveJwtSecret,
  findUserById,
  generateToken,
  verifyToken,
  authMiddleware,
  optionalAuth,
  requireAdmin,
  cookieOptions,
  loginRateLimit,
  registerFailedLogin,
  clearFailedLogins
};
