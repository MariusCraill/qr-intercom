const path = require('path');
// Load .env before anything reads process.env, and from this folder rather than
// whatever directory the process happened to be started from.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { loadConfig, saveConfig, DATA_DIR } = require('./src/config');
const { chat } = require('./src/llm');
const { search } = require('./src/websearch');
const { parseDocument } = require('./src/documents');
const graph = require('./src/graph');

const app = express();
const PORT = parseInt(process.env.PORT) || 3410;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB) || 20;
const MAX_DOC_CHARS = parseInt(process.env.MAX_DOC_CHARS) || 60000;
const MAX_DOCS = parseInt(process.env.MAX_DOCS) || 20;

// Every /api route reads your calendar, notes or documents or spends LLM credit,
// and any web page you visit can send requests to localhost. Without a token
// there is nothing to tell this UI apart from such a page.
const AGENT_TOKEN = (process.env.AGENT_TOKEN || '').trim();
if (!AGENT_TOKEN) {
  console.error('AGENT_TOKEN is not set. Generate one and put it in agent-app/.env:\n' +
    '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// This app holds API keys and a Microsoft account password, so it stays off the LAN.
if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn(`[WARN] HOST=${HOST} exposes your API keys and MS password to the network.`);
}

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.pdf', '.docx', '.txt', '.md', '.csv', '.json', '.log', '.rtf']);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext || 'unknown'}`));
  }
});

// In-memory store of uploaded document texts, capped so a long session cannot
// grow without bound.
const documentStore = new Map(); // id -> { name, text, addedAt, size }
let documentCounter = 1;

function pruneDocuments() {
  while (documentStore.size >= MAX_DOCS) {
    const oldest = documentStore.keys().next().value;
    if (oldest === undefined) break;
    documentStore.delete(oldest);
  }
}

// ---------- Auth ----------
// A custom header also means a cross-site form or <img> can never authenticate,
// because browsers will not attach it without a CORS preflight we never grant.
function tokenMatches(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(AGENT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.use('/api', (req, res, next) => {
  if (!tokenMatches(req.headers['x-agent-token'])) {
    return res.status(401).json({ error: 'Invalid agent token' });
  }
  next();
});

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// ---------- Config ----------
app.get('/api/config/meta', (req, res) => {
  const cfg = loadConfig();
  res.json({
    webSearch: cfg.webSearch,
    hasLlmKey: !!cfg.apiKey,
    hasBaseUrl: !!cfg.baseUrl,
    baseUrl: cfg.baseUrl || '',
    provider: cfg.provider || '',
    msTenantId: cfg.msTenantId || '',
    msClientId: cfg.msClientId || '',
    model: cfg.model,
    hasTavily: !!cfg.tavilyApiKey,
    hasMsAuth: !!(cfg.msClientId && (cfg.msClientSecret || (cfg.msUsername && cfg.msPassword)))
  });
});

app.post('/api/config', (req, res) => {
  try {
    saveConfig(req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// ---------- Documents ----------
app.post('/api/documents', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const text = await parseDocument(req.file.path, req.file.mimetype, req.file.originalname);
    if (!text || !text.trim()) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Could not extract text from document' });
    }
    const id = String(documentCounter++);
    // keep only the tail of very large docs to bound prompt size
    const trimmed = text.length > MAX_DOC_CHARS ? text.slice(-MAX_DOC_CHARS) : text;
    pruneDocuments();
    documentStore.set(id, {
      name: req.file.originalname,
      text: trimmed,
      size: req.file.size,
      addedAt: new Date().toISOString()
    });
    fs.unlink(req.file.path, () => {});
    res.json({ id, name: req.file.originalname, characters: trimmed.length });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: String(e) });
  }
});

app.get('/api/documents', (req, res) => {
  const list = [];
  for (const [id, d] of documentStore) {
    list.push({ id, name: d.name, characters: d.text.length, addedAt: d.addedAt });
  }
  res.json(list);
});

app.delete('/api/documents/:id', (req, res) => {
  documentStore.delete(req.params.id);
  res.json({ ok: true });
});

// ---------- Graph: Calendar & Notes ----------
app.get('/api/calendar', async (req, res) => {
  try {
    const cfg = loadConfig();
    const events = await graph.getCalendarEvents(cfg, {
      start: req.query.start,
      end: req.query.end,
      top: clampInt(req.query.top, 30, 1, 100)
    });
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/notebooks', async (req, res) => {
  try {
    const cfg = loadConfig();
    res.json(await graph.getNotebooks(cfg));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/notebooks/:id/sections', async (req, res) => {
  try {
    const cfg = loadConfig();
    res.json(await graph.getSections(cfg, req.params.id));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/sections/:id/pages', async (req, res) => {
  try {
    const cfg = loadConfig();
    res.json(await graph.getPages(cfg, req.params.id, clampInt(req.query.top, 20, 1, 100)));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/pages/:id', async (req, res) => {
  try {
    const cfg = loadConfig();
    const content = await graph.getPageContent(cfg, req.params.id);
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Chat ----------
async function buildContext(cfg, body) {
  const parts = [];

  // Calendar context
  if (body.includeCalendar !== false) {
    try {
      const events = await graph.getCalendarEvents(cfg, {
        start: body.calendarStart,
        end: body.calendarEnd,
        top: 40
      });
      if (events.length) {
        const lines = events.map((e) => {
          const start = e.start ? new Date(e.start).toLocaleString('en-GB') : '';
          const end = e.end ? new Date(e.end).toLocaleString('en-GB') : '';
          return `- ${e.subject} | ${start} -> ${end} | ${e.location} | by ${e.organizer}\n  ${e.bodyPreview || ''}`;
        });
        parts.push(`=== CALENDAR (Upcoming events) ===\n${lines.join('\n')}`);
      } else {
        parts.push('=== CALENDAR ===\nNo upcoming events in the selected range.');
      }
    } catch (e) {
      parts.push(`=== CALENDAR ===\n(Calendar unavailable: ${e.message})`);
    }
  }

  // Notes context (selected page contents)
  if (body.notes && Array.isArray(body.notes) && body.notes.length) {
    const noteParts = [];
    for (const n of body.notes) {
      try {
        const content = await graph.getPageContent(cfg, n.id);
        noteParts.push(`--- Note: ${n.title || n.id} ---\n${content}`);
      } catch (e) {
        noteParts.push(`--- Note: ${n.title || n.id} ---\n(unavailable: ${e.message})`);
      }
    }
    parts.push(`=== NOTES ===\n${noteParts.join('\n\n')}`);
  }

  // Uploaded documents context
  if (body.documentIds && Array.isArray(body.documentIds) && body.documentIds.length) {
    const docParts = [];
    for (const id of body.documentIds) {
      const d = documentStore.get(String(id));
      if (d) docParts.push(`--- Document: ${d.name} ---\n${d.text}`);
    }
    if (docParts.length) parts.push(`=== UPLOADED DOCUMENTS ===\n${docParts.join('\n\n')}`);
  }

  // Web search
  let webResults = null;
  if (body.useInternet && cfg.webSearch !== 'none') {
    try {
      webResults = await search(cfg, body.message, 5);
      if (webResults && webResults.length) {
        const lines = webResults.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet || ''}`);
        parts.push(`=== WEB SEARCH RESULTS ===\n${lines.join('\n')}`);
      }
    } catch (e) {
      parts.push(`=== WEB SEARCH ===\n(Search failed: ${e.message})`);
    }
  }

  return { context: parts.join('\n\n'), webResults };
}

app.post('/api/chat', async (req, res) => {
  const cfg = loadConfig();
  const body = req.body || {};
  const userMessage = (body.message || '').toString().trim();
  if (!userMessage) return res.status(400).json({ error: 'Message is required' });

  try {
    const { context } = await buildContext(cfg, body);

    const system = [
      'You are a helpful personal assistant. You have access to the user\'s up-to-date context below.',
      'Use ONLY the provided context to answer. Do not invent facts, dates, or events that are not in the context.',
      'If the context is insufficient to answer, say clearly what additional information you need.',
      'Be concise and direct, cite which source (calendar/note/document/web) you used when relevant.'
    ].join(' ');

    const userMsg = `${userMessage}\n\n---\nUp-to-date context:\n${context}`;

    const reply = await chat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ]);

    res.json({ reply, contextUsed: context });
  } catch (e) {
    res.status(500).json({ error: `LLM error: ${e.message}` });
  }
});

// Multer and body-parser errors arrive here; without this they leak a stack trace.
app.use((err, req, res, next) => {
  if (err) {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    console.error('[HTTP]', err.message);
    return res.status(status).json({ error: err.message });
  }
  next();
});

app.listen(PORT, HOST, () => {
  console.log(`Personal Agent running at http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
