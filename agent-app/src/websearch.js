async function duckDuckGoSearch(query, maxResults = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  const html = await res.text();
  const results = [];
  // parse result blocks
  const blockRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    let href = m[1];
    if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
      href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
    }
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    links.push({ href, title });
    if (links.length >= maxResults) break;
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].href,
      snippet: snippets[i] || ''
    });
  }
  return results;
}

async function tavilySearch(cfg, query, maxResults = 5) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: cfg.tavilyApiKey, query, max_results: maxResults })
  });
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content || ''
  }));
}

async function search(cfg, query, maxResults = 5) {
  const mode = cfg.webSearch || 'duckduckgo';
  if (mode === 'tavily' && cfg.tavilyApiKey) return tavilySearch(cfg, query, maxResults);
  return duckDuckGoSearch(query, maxResults);
}

module.exports = { search };
