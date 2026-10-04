const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { run, getOne, getAll } = require('../db');
const {
  generateToken,
  authMiddleware,
  requireAdmin,
  cookieOptions,
  loginRateLimit,
  registerFailedLogin,
  clearFailedLogins
} = require('../auth');

const router = express.Router();

// The qrcode package is only needed by two admin routes and is slow to load,
// so it is required on first use rather than at startup.
let QRCode = null;
function qr() {
  if (!QRCode) QRCode = require('qrcode');
  return QRCode;
}

// Trust an explicitly configured base URL so a spoofed Host header cannot
// poison the links baked into QR codes.
function getBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = req.headers.host;
  if (!host || !/^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(host)) return null;
  // req.protocol only honours X-Forwarded-Proto when TRUST_PROXY is on.
  return `${req.protocol}://${host}`;
}

function publicUser(u) {
  return { id: u.id, name: u.name, apartment: u.apartment, email: u.email, is_admin: u.is_admin };
}

// ---------- public (unauthenticated) ----------
router.get('/public/resident/:id', (req, res) => {
  const resident = getOne('SELECT id, name, apartment FROM residents WHERE id = ?', [req.params.id]);
  if (!resident) return res.status(404).json({ error: 'Resident not found' });
  res.json(resident);
});

// ---------- auth ----------
router.post('/auth/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = getOne('SELECT * FROM residents WHERE email = ?', [email]);
  const ok = user ? await bcrypt.compare(password, user.password) : false;
  if (!ok) {
    registerFailedLogin(req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearFailedLogins(req);
  const token = generateToken({ id: user.id, email: user.email });
  res.cookie('token', token, cookieOptions());
  res.json({ token, user: publicUser(user) });
});

// Any resident can answer a gate call and open the door, so open self-registration
// would let anyone on the network let themselves in. Admins add residents instead.
router.post('/auth/register', loginRateLimit, async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return res.status(403).json({ error: 'Self-registration is disabled. Ask the building admin for an account.' });
  }
  const { name, apartment, phone, email, password } = req.body || {};
  if (!name || !apartment || !email || !password) {
    return res.status(400).json({ error: 'Name, apartment, email, and password required' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (getOne('SELECT id FROM residents WHERE email = ?', [email])) {
    registerFailedLogin(req); // also throttles probing for registered emails
    return res.status(409).json({ error: 'Email already registered' });
  }

  // Public self-registration can never create an admin.
  const id = uuid();
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    run(
      'INSERT INTO residents (id, name, apartment, phone, email, password, is_admin) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [id, name, apartment, phone || null, email, hashedPassword]
    );
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const token = generateToken({ id, email });
  res.cookie('token', token, cookieOptions());
  res.status(201).json({ token, user: { id, name, apartment, email, is_admin: 0 } });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token', cookieOptions());
  res.json({ ok: true });
});

router.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ---------- residents (admin only) ----------
router.get('/residents', authMiddleware, requireAdmin, (req, res) => {
  res.json(getAll('SELECT id, name, apartment, phone, email, is_admin, created_at FROM residents ORDER BY created_at'));
});

router.post('/residents', authMiddleware, requireAdmin, async (req, res) => {
  const { name, apartment, phone, email, password, is_admin } = req.body || {};
  if (!name || !apartment || !email || !password) {
    return res.status(400).json({ error: 'Name, apartment, email, and password required' });
  }
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  if (getOne('SELECT id FROM residents WHERE email = ?', [email])) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const id = uuid();
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    run(
      'INSERT INTO residents (id, name, apartment, phone, email, password, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, apartment, phone || null, email, hashedPassword, is_admin ? 1 : 0]
    );
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.status(201).json({ id, name, apartment, email, is_admin: is_admin ? 1 : 0 });
});

router.put('/residents/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { name, apartment, phone, email, password, is_admin } = req.body || {};
  if (!name || !apartment || !email) {
    return res.status(400).json({ error: 'Name, apartment, and email required' });
  }
  if (password && String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (getOne('SELECT id FROM residents WHERE email = ? AND id != ?', [email, req.params.id])) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const target = getOne('SELECT id, is_admin FROM residents WHERE id = ?', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Resident not found' });

  // Don't let the last admin demote or delete themselves out of existence.
  if (target.is_admin && !is_admin && req.user.id === target.id) {
    return res.status(400).json({ error: 'You cannot remove your own admin rights' });
  }

  try {
    if (password) {
      run(
        'UPDATE residents SET name=?, apartment=?, phone=?, email=?, password=?, is_admin=? WHERE id=?',
        [name, apartment, phone || null, email, await bcrypt.hash(password, 10), is_admin ? 1 : 0, req.params.id]
      );
    } else {
      run(
        'UPDATE residents SET name=?, apartment=?, phone=?, email=?, is_admin=? WHERE id=?',
        [name, apartment, phone || null, email, is_admin ? 1 : 0, req.params.id]
      );
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  res.json({ ok: true });
});

router.delete('/residents/:id', authMiddleware, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });
  run('DELETE FROM residents WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- QR codes (admin only) ----------
router.get('/residents/:id/qr', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const resident = getOne('SELECT id, name, apartment FROM residents WHERE id = ?', [req.params.id]);
    if (!resident) return res.status(404).json({ error: 'Resident not found' });

    const base = getBaseUrl(req);
    if (!base) return res.status(400).json({ error: 'Set PUBLIC_BASE_URL to generate QR codes' });

    const url = `${base}/call/${resident.id}`;
    const image = await qr().toDataURL(url, { width: 400, margin: 2 });
    res.json({ qr: image, url, resident });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/residents/qr-all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const residents = getAll('SELECT id, name, apartment FROM residents ORDER BY apartment');
    const base = getBaseUrl(req);
    if (!base) return res.status(400).json({ error: 'Set PUBLIC_BASE_URL to generate QR codes' });

    const results = await Promise.all(
      residents.map(async (r) => ({
        resident: r,
        qr: await qr().toDataURL(`${base}/call/${r.id}`, { width: 400, margin: 2 }),
        url: `${base}/call/${r.id}`
      }))
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- gates (admin only) ----------
router.get('/gates', authMiddleware, requireAdmin, (req, res) => {
  res.json(getAll('SELECT * FROM gates ORDER BY created_at'));
});

router.post('/gates', authMiddleware, requireAdmin, (req, res) => {
  const { name, location } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Gate name required' });

  const id = uuid().split('-')[0];
  try {
    run('INSERT INTO gates (id, name, location, mqtt_topic) VALUES (?, ?, ?, ?)',
      [id, name, location || null, `gates/${id}/command`]);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.status(201).json({ id, name, location });
});

router.delete('/gates/:id', authMiddleware, requireAdmin, (req, res) => {
  run('DELETE FROM gates WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Public gate metadata for the kiosk page (no secrets, no MQTT topics).
router.get('/public/gates/:id', (req, res) => {
  const gate = getOne('SELECT id, name, location FROM gates WHERE id = ?', [req.params.id]);
  if (!gate) return res.status(404).json({ error: 'Gate not found' });
  res.json(gate);
});

// ---------- logs ----------
// A resident's own history. The full log below is admin only.
router.get('/calls/mine', authMiddleware, (req, res) => {
  res.json(getAll(`
    SELECT c.id, c.gate_id, c.resident_id, c.started_at, c.answered_at, c.ended_at, c.duration, c.status,
           g.name as gate_name
    FROM call_logs c LEFT JOIN gates g ON c.gate_id = g.id
    WHERE c.resident_id = ?
    ORDER BY c.started_at DESC LIMIT 50
  `, [req.user.id]));
});

router.get('/logs/calls', authMiddleware, requireAdmin, (req, res) => {
  res.json(getAll(`
    SELECT c.*, g.name as gate_name, r.name as resident_name
    FROM call_logs c LEFT JOIN gates g ON c.gate_id = g.id LEFT JOIN residents r ON c.resident_id = r.id
    ORDER BY c.started_at DESC LIMIT 100
  `));
});

router.get('/logs/access', authMiddleware, requireAdmin, (req, res) => {
  res.json(getAll(`
    SELECT a.*, g.name as gate_name, r.name as resident_name
    FROM access_logs a LEFT JOIN gates g ON a.gate_id = g.id LEFT JOIN residents r ON a.resident_id = r.id
    ORDER BY a.timestamp DESC LIMIT 100
  `));
});

module.exports = router;
