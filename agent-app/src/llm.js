const OpenAI = require('openai');

function getClient(cfg) {
  const key = cfg.apiKey || 'sk-no-key';
  const opts = { apiKey: key };
  if (cfg.baseUrl) opts.baseURL = cfg.baseUrl;
  return new OpenAI(opts);
}

function resolveModel(cfg) {
  if (cfg.model) return cfg.model;
  if (cfg.provider === 'anthropic') return 'anthropic/claude-3.5-sonnet';
  if (cfg.provider === 'openai') return 'gpt-4o-mini';
  return 'gpt-4o-mini';
}

async function chat(cfg, messages, { temperature = 0.4 } = {}) {
  const client = getClient(cfg);
  const model = resolveModel(cfg);
  const resp = await client.chat.completions.create({
    model,
    messages,
    temperature
  });
  return resp.choices?.[0]?.message?.content || '';
}

module.exports = { chat, resolveModel };
