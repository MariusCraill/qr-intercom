const msal = require('@azure/msal-node');

const GRAPH_SCOPE = ['https://graph.microsoft.com/.default'];

let cachedToken = null;

async function getToken(cfg) {
  if (cachedToken && Date.now() < cachedToken.expiresOn) return cachedToken.accessToken;

  const clientConfig = {
    auth: {
      clientId: cfg.msClientId,
      authority: `https://login.microsoftonline.com/${cfg.msTenantId || 'common'}`,
      clientSecret: cfg.msClientSecret
    }
  };
  const cca = new msal.ConfidentialClientApplication(clientConfig);

  const request = {
    scopes: GRAPH_SCOPE,
    username: cfg.msUsername,
    password: cfg.msPassword
  };

  const resp = await cca.acquireTokenByUsernamePassword(request);
  const token = resp.accessToken;
  const expiresOn = Date.now() + Math.max(0, (resp.expiresOn ? new Date(resp.expiresOn).getTime() : 0) - Date.now() - 60000);
  cachedToken = { accessToken: token, expiresOn };
  return token;
}

async function graphFetch(cfg, path, options = {}) {
  const token = await getToken(cfg);
  const url = `https://graph.microsoft.com/v1.0${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ---- Calendar ----
async function getCalendarEvents(cfg, { start, end, top = 30 } = {}) {
  const now = new Date();
  const st = start || now.toISOString();
  const en = end || new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
  const data = await graphFetch(
    cfg,
    `/me/calendar/calendarView?startDateTime=${encodeURIComponent(st)}&endDateTime=${encodeURIComponent(en)}&$top=${top}&$orderby=start/dateTime&$select=subject,start,end,location,organizer,bodyPreview`
  );
  return (data.value || []).map((e) => ({
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName || '',
    organizer: e.organizer?.emailAddress?.name || '',
    bodyPreview: e.bodyPreview || ''
  }));
}

// ---- OneNote ----
async function getNotebooks(cfg) {
  const data = await graphFetch(cfg, '/me/onenote/notebooks?$select=id,displayName&$top=50');
  return (data.value || []).map((n) => ({ id: n.id, displayName: n.displayName }));
}

async function getSections(cfg, notebookId) {
  const data = await graphFetch(cfg, `/me/onenote/notebooks/${notebookId}/sections?$select=id,displayName&$top=100`);
  return (data.value || []).map((s) => ({ id: s.id, displayName: s.displayName, notebookId }));
}

async function getPages(cfg, sectionId, top = 20) {
  const data = await graphFetch(cfg, `/me/onenote/sections/${sectionId}/pages?$select=id,title,createdDateTime&$top=${top}`);
  return (data.value || []).map((p) => ({ id: p.id, title: p.title, createdDateTime: p.createdDateTime, sectionId }));
}

async function getPageContent(cfg, pageId) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/onenote/pages/${pageId}/content`, {
    headers: { Authorization: `Bearer ${await getToken(cfg)}`, Accept: 'text/html' }
  });
  if (!res.ok) throw new Error(`Graph page content error ${res.status}`);
  const html = await res.text();
  // strip html tags to plain text
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  getToken,
  getCalendarEvents,
  getNotebooks,
  getSections,
  getPages,
  getPageContent
};
