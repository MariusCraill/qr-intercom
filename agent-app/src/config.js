const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Values that must never be written to disk from a UI/API save. They stay in
// .env or process memory only, otherwise the config endpoint becomes a way to
// exfiltrate every secret the process is holding.
const SECRET_FIELDS = [
  'apiKey',
  'tavilyApiKey',
  'msClientSecret',
  'msUsername',
  'msPassword'
];

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const uploads = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(uploads)) fs.mkdirSync(uploads, { recursive: true });
}

// config.json may hold non-secret prefs only; drop anything sensitive on read.
function sanitize(cfg) {
  const clean = { ...cfg };
  for (const field of SECRET_FIELDS) delete clean[field];
  return clean;
}

function defaultConfig() {
  return {
    // LLM provider
    provider: '',       // 'openai' | 'anthropic' | '' (uses baseUrl)
    baseUrl: '',        // custom OpenAI-compatible endpoint, e.g. http://localhost:11434/v1
    model: '',
    // Web search
    webSearch: 'duckduckgo', // 'duckduckgo' | 'tavily' | 'none'
    // Microsoft Graph
    msTenantId: '',
    msClientId: ''
  };
}

function loadConfig() {
  ensureDirs();
  const cfg = defaultConfig();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      Object.assign(cfg, sanitize(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))));
    } catch (e) {
      /* ignore corrupted config */
    }
  }
  // .env overrides file config (for secrets, keeps keys out of the saved file)
  if (process.env.LLM_API_KEY) cfg.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_BASE_URL) cfg.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.LLM_MODEL) cfg.model = process.env.LLM_MODEL;
  if (process.env.LLM_PROVIDER) cfg.provider = process.env.LLM_PROVIDER;
  if (process.env.WEB_SEARCH) cfg.webSearch = process.env.WEB_SEARCH;
  if (process.env.TAVILY_API_KEY) cfg.tavilyApiKey = process.env.TAVILY_API_KEY;
  if (process.env.MS_TENANT_ID) cfg.msTenantId = process.env.MS_TENANT_ID;
  if (process.env.MS_CLIENT_ID) cfg.msClientId = process.env.MS_CLIENT_ID;
  if (process.env.MS_CLIENT_SECRET) cfg.msClientSecret = process.env.MS_CLIENT_SECRET;
  if (process.env.MS_USERNAME) cfg.msUsername = process.env.MS_USERNAME;
  if (process.env.MS_PASSWORD) cfg.msPassword = process.env.MS_PASSWORD;
  return cfg;
}

function saveConfig(patch) {
  ensureDirs();
  const allowed = {};
  for (const [key, value] of Object.entries(patch || {})) {
    // Only known, non-secret keys may be persisted.
    if (SECRET_FIELDS.includes(key) || !(key in defaultConfig())) continue;
    allowed[key] = typeof value === 'string' ? value.slice(0, 2000) : value;
  }
  const merged = { ...sanitize(loadConfig()), ...allowed };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
  return loadConfig();
}

module.exports = { loadConfig, saveConfig, DATA_DIR, SECRET_FIELDS };
