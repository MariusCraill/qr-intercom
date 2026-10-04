const $ = (s) => document.querySelector(s);

const state = {
  mode: 'context',               // 'context' | 'internet'
  calEvents: [],
  selectedCalendar: [],
  selectedNotes: [],             // {id, title}
  documents: [],
  selectedDocs: [],
  notebooks: [],
  sections: []
};

// ---------- helpers ----------
// Every /api call needs the AGENT_TOKEN from .env; it is asked for once and kept
// in this browser only.
const TOKEN_KEY = 'agent_token';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
}

function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* private mode */ }
}

async function api(path, opts = {}, retried = false) {
  const headers = { ...(opts.headers || {}) };
  // FormData must set its own multipart Content-Type (with the boundary).
  if (typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['X-Agent-Token'] = token;

  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !retried) {
    const entered = (window.prompt('Enter the AGENT_TOKEN from agent-app/.env') || '').trim();
    if (entered) {
      setToken(entered);
      return api(path, opts, true);
    }
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

// ---------- source toggle ----------
$('#sourceToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.sbtn');
  if (!btn) return;
  state.mode = btn.dataset.mode;
  document.querySelectorAll('.sbtn').forEach((b) => b.classList.toggle('active', b === btn));
});

// ---------- settings ----------
// Secrets are deliberately not accepted here: the server strips them so they
// can never land in data/config.json. Set them in .env instead.
async function loadSettings() {
  try {
    const meta = await api('/api/config/meta');
    $('#cfgWebSearch').value = meta.webSearch || 'duckduckgo';
    if (meta.model) $('#cfgModel').value = meta.model;
    $('#cfgBaseUrl').value = meta.baseUrl || '';
    if (meta.provider) $('#cfgProvider').value = meta.provider;
    if (meta.msTenantId) $('#cfgTenantId').value = meta.msTenantId;
    if (meta.msClientId) $('#cfgClientId').value = meta.msClientId;
    const bits = [];
    if (meta.hasLlmKey) bits.push('LLM key ✔');
    if (meta.hasTavily) bits.push('Tavily ✔');
    if (meta.hasMsAuth) bits.push('Microsoft auth ✔');
    $('#configStatus').textContent = bits.length ? bits.join(' · ') : 'No API keys detected in .env';
  } catch (e) {
    $('#configStatus').textContent = 'Could not load config';
  }
}

$('#saveConfigBtn').addEventListener('click', async () => {
  const status = $('#configStatus');
  try {
    const token = $('#cfgToken').value.trim();
    if (token) setToken(token);

    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        provider: $('#cfgProvider').value,
        baseUrl: $('#cfgBaseUrl').value.trim(),
        model: $('#cfgModel').value.trim(),
        webSearch: $('#cfgWebSearch').value,
        msTenantId: $('#cfgTenantId').value.trim(),
        msClientId: $('#cfgClientId').value.trim()
      })
    });
    status.textContent = 'Settings saved. API keys still come from .env.';
    setTimeout(() => { loadSettings(); }, 300);
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
});

// ---------- messages ----------
function addMsg(role, text, metaText) {
  const wrap = el('div', '', 'msg ' + role);
  wrap.appendChild(el('div', role === 'user' ? 'You' : 'Agent', 'mhead'));
  wrap.appendChild(el('div', text));
  if (metaText) wrap.appendChild(el('div', metaText, 'meta'));
  $('#messages').appendChild(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

// ---------- calendar ----------
$('#loadCalendarBtn').addEventListener('click', async (e) => {
  e.target.textContent = 'Loading…';
  try {
    state.calEvents = await api('/api/calendar');
    renderCalendar();
  } catch (err) {
    addMsg('assistant', 'Could not load calendar: ' + err.message, '');
  } finally {
    e.target.textContent = 'Load upcoming events';
  }
});

function renderCalendar() {
  const container = $('#calendarList');
  container.innerHTML = '';
  if (!state.calEvents.length) {
    container.appendChild(el('div', 'No events yet, or configure calendar.', 'gone'));
    return;
  }
  state.calEvents.forEach((ev, idx) => {
    const d = new Date(ev.start);
    const dateStr = d.toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const item = el('div', `[${idx}] ${ev.subject}`, 'item' + (state.selectedCalendar.includes(idx) ? ' selected' : ''));
    item.title = `${dateStr}\n${ev.location || ''}\n${ev.bodyPreview || ''}`;
    const sub = el('div', `${dateStr}${ev.location ? ' · ' + ev.location : ''}`, 'sub');
    item.appendChild(sub);
    item.addEventListener('click', () => {
      const i = state.selectedCalendar.indexOf(idx);
      if (i >= 0) { state.selectedCalendar.splice(i, 1); item.classList.remove('selected'); }
      else { state.selectedCalendar.push(idx); item.classList.add('selected'); }
      updateCtxBar();
    });
    container.appendChild(item);
  });
}

// ---------- notes ----------
async function loadNotebooks() {
  const sel = $('#notebookSelect');
  sel.innerHTML = '<option value="">Load notebooks…</option>';
  try {
    state.notebooks = await api('/api/notebooks');
    sel.innerHTML = '<option value="">Select notebook…</option>';
    state.notebooks.forEach((n) => sel.appendChild(new Option(n.displayName, n.id)));
  } catch (err) {
    sel.innerHTML = '<option value="">Note: ' + err.message + '</option>';
  }
}

$('#notebookSelect').addEventListener('change', async (e) => {
  const nb = e.target.value;
  const sec = $('#sectionSelect');
  sec.innerHTML = '<option value="">Select section…</option>';
  sec.disabled = true;
  if (!nb) return;
  try {
    state.sections = await api(`/api/notebooks/${nb}/sections`);
    sec.disabled = false;
    state.sections.forEach((s) => sec.appendChild(new Option(s.displayName, s.id)));
  } catch (err) {
    sec.innerHTML = '<option value="">' + err.message + '</option>';
  }
});

$('#sectionSelect').addEventListener('change', async (e) => {
  const sid = e.target.value;
  const list = $('#notesList');
  list.innerHTML = '';
  if (!sid) return;
  try {
    const pages = await api(`/api/sections/${sid}/pages`);
    if (!pages.length) { list.appendChild(el('div', 'No pages in this section.', 'gone')); return; }
    pages.forEach((p) => {
      const item = el('div', p.title || '(untitled)', 'item');
      const sub = el('div', p.createdDateTime ? new Date(p.createdDateTime).toDateString() : '', 'sub');
      item.appendChild(sub);
      item.addEventListener('click', () => {
        const i = state.selectedNotes.findIndex((x) => x.id === p.id);
        if (i >= 0) { state.selectedNotes.splice(i, 1); item.classList.remove('selected'); }
        else { state.selectedNotes.push({ id: p.id, title: p.title }); item.classList.add('selected'); }
        updateCtxBar();
      });
      list.appendChild(item);
    });
  } catch (err) {
    list.appendChild(el('div', err.message, 'gone'));
  }
});

// ---------- documents (drag & drop) ----------
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

['dragover', 'dragenter'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragging'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragging'); })
);
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      dropZone.classList.add('uploading');
      const r = await api('/api/documents', { method: 'POST', body: fd });
      state.documents.push({ id: r.id, name: r.name, characters: r.characters });
      renderDocs();
    } catch (err) {
      addMsg('assistant', 'Upload failed for ' + file.name + ': ' + err.message, '');
    } finally {
      dropZone.classList.remove('uploading');
    }
  }
}

async function loadDocs() {
  try {
    state.documents = await api('/api/documents');
    renderDocs();
  } catch (e) {}
}

function renderDocs() {
  const container = $('#docsList');
  container.innerHTML = '';
  if (!state.documents.length) { container.appendChild(el('div', 'No documents uploaded.', 'gone')); return; }
  state.documents.forEach((d) => {
    const item = el('div', d.name, 'item' + (state.selectedDocs.includes(d.id) ? ' selected' : ''));
    const sub = el('div', `${d.characters} chars`, 'sub');
    const rm = el('span', '✕', 'remove');
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api('/api/documents/' + d.id, { method: 'DELETE' });
      state.documents = state.documents.filter((x) => x.id !== d.id);
      state.selectedDocs = state.selectedDocs.filter((x) => x !== d.id);
      renderDocs(); updateCtxBar();
    });
    item.appendChild(rm);
    item.appendChild(sub);
    item.addEventListener('click', () => {
      const i = state.selectedDocs.indexOf(d.id);
      if (i >= 0) { state.selectedDocs.splice(i, 1); item.classList.remove('selected'); }
      else { state.selectedDocs.push(d.id); item.classList.add('selected'); }
      updateCtxBar();
    });
    container.appendChild(item);
  });
}

// ---------- context bar ----------
function updateCtxBar() {
  const counts = [];
  if (state.selectedCalendar.length) counts.push(`${state.selectedCalendar.length} event(s)`);
  if (state.selectedNotes.length) counts.push(`${state.selectedNotes.length} note(s)`);
  if (state.selectedDocs.length) counts.push(`${state.selectedDocs.length} document(s)`);
  const parts = [];
  if (counts.length) parts.push(counts.join(', '));
  parts.push(state.mode === 'internet' ? 'Internet search ON' : 'Context only (no internet)');
  $('#ctxCounts').textContent = parts.join(' · ');
}

// ---------- chat ----------
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';

  const payload = {
    message: text,
    useInternet: state.mode === 'internet',
    includeCalendar: true,
    notes: state.selectedNotes,
    documentIds: state.selectedDocs
  };

  addMsg('user', text);
  addMsg('assistant', '…', '');
  const respEl = $('#messages').lastElementChild.querySelector('div:last-child');

  // If only context & nothing selected, ask clarification guidance is handled server-side.
  const spinner = el('div', 'Thinking…', 'spinner');
  respEl.parentElement.appendChild(spinner);

  const sendBtn = $('#sendBtn');
  const original = sendBtn.textContent;
  sendBtn.disabled = true;
  sendBtn.textContent = '…';

  try {
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify(payload) });
    spinner.remove();
    respEl.textContent = r.reply;
    const metaText = state.mode === 'internet' || state.selectedCalendar.length || state.selectedNotes.length || state.selectedDocs.length
      ? `Context: calendar + notes + docs as selected · ${state.mode === 'internet' ? 'incl. web search' : 'context only'}`
      : `Context: selected sources · ${state.mode === 'internet' ? 'incl. web search' : 'context only'}`;
    const meta = el('div', metaText, 'meta');
    respEl.parentElement.appendChild(meta);
  } catch (err) {
    spinner.remove();
    respEl.textContent = 'Error: ' + err.message;
    respEl.classList.add('err');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = original;
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
});

// textarea auto-grow + enter to send
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});

// Settings first, so a missing token is asked for once rather than by every loader.
(async () => {
  await loadSettings();
  loadNotebooks();
  loadDocs();
})();
updateCtxBar();
addMsg('assistant', 'Welcome! Configure your model + Microsoft in Settings, then load your calendar and notes, drag in any documents, pick your sources (or toggle Internet on), and ask away.');
