'use strict';

// Leads dashboard. Reads everything the service worker wrote to storage and
// renders it; all mutation goes back through messages so the engine stays the
// single owner of the pipeline.

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

// Mirrors DEFAULT_LEADS_CONFIG in leads-engine.js — the worker owns the real
// defaults, these keep the settings form from rendering blank before the first
// save.
const DEFAULT_CONFIG = {
  provider: 'gemini',
  geminiKey: '',
  openaiKey: '',
  model: '',
  searchUrl:
    'https://www.upwork.com/nx/search/jobs?amount=5000-' +
    '&category2_uid=531770282580668420,531770282580668419,531770282580668418' +
    '&nav_dir=pop&per_page=50&q=%2F&sort=recency&t=0,1',
  batchSize: 8,
  minConfidence: 0.35,
  autoAnalyze: true,
  enrich: true,
};

let filter = 'leads';
let query = '';
let sortState = { key: 'capturedAt', type: 'date', dir: 'desc' };
let config = { ...DEFAULT_CONFIG };
let rows = [];          // jobs decorated with a `_v` view object
let visible = [];       // rows passing filter + search + sort
let toastTimer = null;

// ─── Helpers ────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

async function send(action, payload) {
  const reply = await chrome.runtime.sendMessage({ action, ...payload });
  if (reply && reply.ok === false) throw new Error(reply.error || 'Request failed');
  return reply || {};
}

/**
 * Flatten a stored job into the shape the table renders. Falls back to the
 * regex pass when the model hasn't seen the job yet, so a plainly visible
 * email shows up immediately rather than after the next analysis run.
 */
function buildView(job) {
  const a = job.analysis || null;
  const local = job.local || { emails: [], links: [] };
  const emails = a ? a.emails || [] : local.emails || [];
  const links = a ? a.links || [] : local.links || [];
  const phones = a ? a.phones || [] : [];
  const company = (a && a.companyName) || null;
  const person = (a && a.personName) || null;

  return {
    company,
    person,
    emails,
    phones,
    links,
    client: company || person || '',
    clientSummary: (a && a.clientSummary) || null,
    jobSummary: (a && a.jobSummary) || '',
    signals: (a && a.signals) || [],
    confidence: a ? a.confidence || 0 : (emails.length ? 0.5 : 0),
    analyzed: job.state === 'done',
    isLead: a ? !!a.hasClientInfo : emails.length > 0,
  };
}

function passesFilter(job, which = filter) {
  const v = job._v;
  switch (which) {
    case 'leads':
      // An unanalysed job with a literal email in the text still counts.
      return v.isLead && (!v.analyzed || v.confidence >= config.minConfidence);
    case 'email': return v.emails.length > 0;
    case 'company': return !!v.company;
    case 'attachment': return (job.attachments || []).length > 0;
    case 'problem': return job.state === 'error' || job.state === 'pending';
    default: return true;
  }
}

function matchesQuery(job) {
  if (!query) return true;
  const v = job._v;
  const haystack = [
    job.title, v.company, v.person, v.clientSummary, v.jobSummary,
    v.emails.join(' '), v.links.join(' '),
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function sortValue(job, key, type) {
  const raw = key === 'client' || key === 'confidence' ? job._v[key] : job[key];
  if (raw === null || raw === undefined || raw === '') return null;
  if (type === 'num') { const n = Number(raw); return Number.isNaN(n) ? null : n; }
  if (type === 'date') { const ms = typeof raw === 'number' ? raw : Date.parse(raw); return Number.isNaN(ms) ? null : ms; }
  return String(raw).toLowerCase();
}

function applyView() {
  let list = rows.filter((j) => passesFilter(j) && matchesQuery(j));
  if (sortState.key) {
    const { key, type, dir } = sortState;
    list = [...list].sort((a, b) => {
      const av = sortValue(a, key, type);
      const bv = sortValue(b, key, type);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;   // blanks always sink
      if (bv === null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  visible = list;
}

// ─── Rendering ──────────────────────────────────────────────

function renderSummary() {
  const leads = rows.filter((j) => j._v.isLead);
  const emails = new Set();
  rows.forEach((j) => j._v.emails.forEach((e) => emails.add(e)));

  document.getElementById('sumTotal').textContent = rows.length;
  document.getElementById('sumLeads').textContent = leads.length;
  document.getElementById('sumEmails').textContent = emails.size;
  document.getElementById('sumPending').textContent = rows.filter((j) => j.state === 'pending').length;

  const count = (f) => rows.filter((j) => passesFilter(j, f)).length;
  document.getElementById('cntLeads').textContent = count('leads');
  document.getElementById('cntEmail').textContent = count('email');
  document.getElementById('cntCompany').textContent = count('company');
  document.getElementById('cntAttachment').textContent = count('attachment');
  document.getElementById('cntAll').textContent = rows.length;
  document.getElementById('cntProblem').textContent = count('problem');
}

function contactsCell(v) {
  const parts = [];
  for (const email of v.emails.slice(0, 3)) {
    parts.push(`<button type="button" class="contact email" data-copy="${escapeHtml(email)}" title="Copy ${escapeHtml(email)}"><span>${escapeHtml(email)}</span></button>`);
  }
  for (const phone of v.phones.slice(0, 2)) {
    parts.push(`<button type="button" class="contact phone" data-copy="${escapeHtml(phone)}" title="Copy ${escapeHtml(phone)}"><span>${escapeHtml(phone)}</span></button>`);
  }
  for (const link of v.links.slice(0, 2)) {
    let label = link;
    try { label = new URL(link.startsWith('http') ? link : `https://${link}`).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    parts.push(`<button type="button" class="contact link" data-copy="${escapeHtml(link)}" title="Copy ${escapeHtml(link)}"><span>${escapeHtml(label)}</span></button>`);
  }
  if (!parts.length) return '<span class="num-nil">—</span>';
  return `<div class="contacts">${parts.join('')}</div>`;
}

function clientCell(job) {
  const v = job._v;
  if (!v.company && !v.person) {
    if (job.state === 'pending') return '<span class="state-pill pending">queued</span>';
    if (job.state === 'error') return '<span class="state-pill error">failed</span>';
    return '<span class="num-nil">—</span>';
  }
  const name = v.company
    ? `<div class="client-name">${escapeHtml(v.company)}</div>`
    : `<div class="client-name">${escapeHtml(v.person)}</div>`;
  const person = v.company && v.person ? `<div class="client-person">${escapeHtml(v.person)}</div>` : '';
  return name + person;
}

function confidenceCell(v) {
  if (!v.analyzed) return '<span class="num-nil">—</span>';
  const pct = Math.round(v.confidence * 100);
  const cls = pct >= 70 ? 'hi' : pct >= 40 ? 'mid' : 'lo';
  return `<span class="conf ${cls}">${pct}%</span>`;
}

function renderTable() {
  const tbody = document.getElementById('leadsBody');
  tbody.innerHTML = '';

  document.querySelectorAll('.leads-table th.sortable').forEach((th) => {
    const active = th.dataset.sort === sortState.key;
    th.classList.toggle('sort-asc', active && sortState.dir === 'asc');
    th.classList.toggle('sort-desc', active && sortState.dir === 'desc');
    th.setAttribute('aria-sort', active ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none');
  });

  document.getElementById('resultCount').textContent = rows.length
    ? (visible.length === rows.length ? `${rows.length} jobs` : `${visible.length} of ${rows.length}`)
    : '';

  if (!visible.length) {
    const msg = !rows.length
      ? 'No jobs collected yet. Click “Collect jobs” to open your Upwork search and scan it.'
      : query
        ? 'No leads match your search.'
        : 'No jobs in this filter.';
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">${msg}</td></tr>`;
    return;
  }

  for (const job of visible) {
    const v = job._v;
    const tr = document.createElement('tr');
    tr.dataset.jobId = job.id;

    const sub = [];
    if (job.budget != null) sub.push(`$${Number(job.budget).toLocaleString()}`);
    else if (job.hourlyRange) sub.push(`$${escapeHtml(job.hourlyRange)}/hr`);
    if (job.postedOn) sub.push(`posted ${timeAgo(job.postedOn)}`);
    if (job.country) sub.push(escapeHtml(job.country));

    tr.innerHTML = `
      <td>
        <div class="lead-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
        ${sub.length ? `<div class="lead-sub">${sub.join('<span class="sep">·</span>')}</div>` : ''}
      </td>
      <td>${clientCell(job)}</td>
      <td>${contactsCell(v)}</td>
      <td><div class="lead-summary">${escapeHtml(v.clientSummary || v.jobSummary || '')}</div></td>
      <td>${timeAgo(job.capturedAt)}</td>
      <td class="num">${confidenceCell(v)}</td>
      <td>
        <div class="row-actions">
          <button class="btn icon" data-action="open" title="Open job on Upwork">↗</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function renderStatus(run, scrape) {
  const pill = document.getElementById('status');
  const text = document.getElementById('statusText');
  const analysing = run && run.status === 'running';
  pill.classList.toggle('checking', analysing || !!(scrape && scrape.active));

  if (scrape && scrape.active) {
    text.textContent = scrape.message || 'Scraping the search page…';
  } else if (analysing) {
    text.textContent = run.message || 'Analysing…';
  } else if (run && run.status === 'error') {
    text.textContent = 'Analysis stopped';
  } else if (run && run.message) {
    text.textContent = run.message;
  } else {
    text.textContent = rows.length ? `${rows.length} jobs collected` : 'No jobs yet';
  }
}

function renderBanner(run, scrape) {
  const banner = document.getElementById('banner');
  const textEl = document.getElementById('bannerText');
  const action = document.getElementById('bannerAction');
  const activeKey = config.provider === 'openai' ? config.openaiKey : config.geminiKey;

  let message = null;
  let actionLabel = null;
  let onAction = null;
  let isError = false;

  if (scrape && !scrape.active && scrape.error) {
    message = scrape.error;
    isError = true;
  } else if (run && run.status === 'error') {
    message = run.message;
    isError = true;
    actionLabel = 'Settings';
    onAction = openSettings;
  } else if (!activeKey) {
    message = `Add a ${PROVIDERS[config.provider].label} API key to pull client names and contact details out of job descriptions.`;
    actionLabel = 'Add key';
    onAction = openSettings;
  } else if (rows.some((j) => j.state === 'pending')) {
    const n = rows.filter((j) => j.state === 'pending').length;
    message = `${n} job${n === 1 ? '' : 's'} collected but not analysed yet.`;
    actionLabel = 'Analyse now';
    onAction = analyzeNow;
  }

  banner.hidden = !message;
  banner.classList.toggle('is-error', isError);
  if (!message) return;
  textEl.textContent = message;
  action.hidden = !actionLabel;
  action.textContent = actionLabel || '';
  action.onclick = onAction;
}

async function render() {
  const stored = await chrome.storage.local.get(['leadJobs', 'leadsRun', 'leadsScrape', 'leadsConfig']);
  config = { ...DEFAULT_CONFIG, ...(stored.leadsConfig || {}) };
  if (!config.model) config.model = PROVIDERS[config.provider].models[0];

  rows = (stored.leadJobs || []).map((job) => ({ ...job, _v: buildView(job) }));
  applyView();
  renderSummary();
  renderTable();
  renderStatus(stored.leadsRun, stored.leadsScrape);
  renderBanner(stored.leadsRun, stored.leadsScrape);
}

// ─── Actions ────────────────────────────────────────────────

function openJobTab(job) {
  chrome.tabs.create({ url: job.url });
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Copy failed — check clipboard permissions');
  }
}

function copyVisibleLinks() {
  // The point of the filter: hand back only the jobs worth contacting.
  const links = visible.map((j) => j.url);
  if (!links.length) { toast('Nothing to copy'); return; }
  copyToClipboard(links.join('\n'), `Copied ${links.length} job link${links.length === 1 ? '' : 's'}`);
}

function csvCell(value) {
  const s = Array.isArray(value) ? value.join(' | ') : String(value == null ? '' : value);
  return `"${s.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!visible.length) { toast('Nothing to export'); return; }
  const header = ['Title', 'Company', 'Person', 'Emails', 'Phones', 'Links', 'Client summary', 'Job summary', 'Confidence', 'Job URL'];
  const lines = [header.map(csvCell).join(',')];
  for (const job of visible) {
    const v = job._v;
    lines.push([
      job.title, v.company, v.person, v.emails, v.phones, v.links,
      v.clientSummary, v.jobSummary, v.analyzed ? v.confidence.toFixed(2) : '', job.url,
    ].map(csvCell).join(','));
  }
  // BOM so Excel reads the UTF-8 correctly.
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `upwork-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${visible.length} row${visible.length === 1 ? '' : 's'}`);
}

async function analyzeNow() {
  toast('Analysing…');
  try {
    await send('leads:analyze');
  } catch (err) {
    toast(err.message);
  }
  render();
}

// ─── Detail drawer ──────────────────────────────────────────

function openDetail(job) {
  const v = job._v;
  document.getElementById('detailTitle').textContent = job.title;
  document.getElementById('detailSub').textContent =
    [v.company, v.person].filter(Boolean).join(' · ') || 'No client identified';

  const body = document.getElementById('detailBody');
  const section = (heading, html) => `<div class="detail-section"><h3>${heading}</h3>${html}</div>`;
  const chips = (items, cls) => items
    .map((x) => `<button type="button" class="contact ${cls}" data-copy="${escapeHtml(x)}"><span>${escapeHtml(x)}</span></button>`)
    .join('');

  let html = `
    <div class="detail-actions">
      <button class="btn primary" data-action="open">Open on Upwork</button>
      <button class="btn ghost" data-copy="${escapeHtml(job.url)}">Copy link</button>
    </div>`;

  if (v.emails.length || v.phones.length || v.links.length) {
    html += section('Contact', `<div class="contacts">${chips(v.emails, 'email')}${chips(v.phones, 'phone')}${chips(v.links, 'link')}</div>`);
  }
  if (v.clientSummary) html += section('Client', `<p>${escapeHtml(v.clientSummary)}</p>`);
  if (v.jobSummary) html += section('Job summary', `<p>${escapeHtml(v.jobSummary)}</p>`);
  if (v.signals.length) {
    html += section('Why it matched', `<div class="signal-list">${v.signals.map((s) => `<span class="signal">${escapeHtml(s)}</span>`).join('')}</div>`);
  }
  if (job.state === 'error') html += section('Analysis error', `<p>${escapeHtml(job.error || 'Unknown error')}</p>`);
  html += section('Job description', `<div class="detail-desc">${escapeHtml(job.description || '')}</div>`);
  for (const file of job.attachments || []) {
    const body = file.text
      ? `<div class="detail-desc">${escapeHtml(file.text)}</div>`
      : '<p class="is-muted">Couldn\u2019t read this file\u2019s contents \u2014 the filename was still analysed.</p>';
    html += section(`Attachment: ${escapeHtml(file.name)}`, body);
  }
  if (job.clientHistory) {
    html += section("Client's history", `<div class="detail-desc">${escapeHtml(job.clientHistory)}</div>`);
  }

  body.innerHTML = html;
  body.querySelector('[data-action="open"]')?.addEventListener('click', () => openJobTab(job));

  document.getElementById('detailDrawer').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  document.getElementById('detailDrawer').hidden = true;
  if (document.getElementById('settingsModal').hidden) document.body.style.overflow = '';
}

// ─── Settings ───────────────────────────────────────────────

function fillModels() {
  const select = document.getElementById('modelSelect');
  select.innerHTML = '';
  for (const model of PROVIDERS[config.provider].models) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    select.appendChild(opt);
  }
  select.value = PROVIDERS[config.provider].models.includes(config.model)
    ? config.model
    : PROVIDERS[config.provider].models[0];
}

function fillSettings() {
  document.querySelector(`#providerChoice input[value="${config.provider}"]`).checked = true;
  document.getElementById('apiKey').value =
    config.provider === 'openai' ? config.openaiKey : config.geminiKey;
  document.getElementById('keyHelp').href = PROVIDERS[config.provider].keyUrl;
  document.getElementById('batchSize').value = config.batchSize;
  document.getElementById('minConfidence').value = config.minConfidence;
  document.getElementById('autoAnalyze').checked = !!config.autoAnalyze;
  document.getElementById('searchUrl').value = config.searchUrl || '';
  document.getElementById('verifyResult').textContent = '';
  fillModels();
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  const { leadsConfig } = await chrome.storage.local.get('leadsConfig');
  await chrome.storage.local.set({ leadsConfig: { ...(leadsConfig || {}), ...config } });
}

function openSettings() {
  fillSettings();
  document.getElementById('settingsModal').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSettings() {
  document.getElementById('settingsModal').hidden = true;
  if (document.getElementById('detailDrawer').hidden) document.body.style.overflow = '';
  render();
}

// ─── Wiring ─────────────────────────────────────────────────

document.getElementById('scrapeSearch').addEventListener('click', async () => {
  toast('Starting…');
  try {
    const reply = await send('leads:scrapeSearch', { enrich: config.enrich !== false });
    toast(reply.opened ? 'Opened your job search — scraping once it loads' : 'Scraping the search page');
  } catch (err) {
    toast(err.message);
  }
});
document.getElementById('analyzeNow').addEventListener('click', analyzeNow);
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('copyLinks').addEventListener('click', copyVisibleLinks);
document.getElementById('exportCsv').addEventListener('click', exportCsv);

document.getElementById('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll('#filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  applyView();
  renderTable();
});

document.getElementById('leadSearch').addEventListener('input', (e) => {
  query = e.target.value.trim().toLowerCase();
  applyView();
  renderTable();
});

document.querySelector('.leads-table thead').addEventListener('click', (e) => {
  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  const type = th.dataset.type || 'str';
  const numericFirst = type === 'num' || type === 'date';
  if (sortState.key !== key) sortState = { key, type, dir: numericFirst ? 'desc' : 'asc' };
  else sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  applyView();
  renderTable();
});

// One delegated handler for the table: copy chips win over the row's drawer.
document.getElementById('leadsBody').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    e.stopPropagation();
    copyToClipboard(copyBtn.dataset.copy, 'Copied');
    return;
  }
  const tr = e.target.closest('tr[data-job-id]');
  if (!tr) return;
  const job = rows.find((j) => j.id === tr.dataset.jobId);
  if (!job) return;
  if (e.target.closest('[data-action="open"]')) openJobTab(job);
  else openDetail(job);
});

document.getElementById('detailBody').addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) copyToClipboard(copyBtn.dataset.copy, 'Copied');
});

document.getElementById('settingsModal').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSettings();
});
document.getElementById('detailDrawer').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeDetail();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('detailDrawer').hidden) closeDetail();
  else if (!document.getElementById('settingsModal').hidden) closeSettings();
});

document.getElementById('providerChoice').addEventListener('change', async (e) => {
  if (e.target.name !== 'provider') return;
  // Keys are kept per provider so switching back and forth doesn't lose them.
  await saveConfig({ provider: e.target.value, model: PROVIDERS[e.target.value].models[0] });
  fillSettings();
});

// On `input`, not `change`: closing the dialog with Escape never blurs the
// field, and a key the user typed but didn't save is a confusing failure.
document.getElementById('apiKey').addEventListener('input', (e) => {
  const key = e.target.value.trim();
  saveConfig(config.provider === 'openai' ? { openaiKey: key } : { geminiKey: key });
});

document.getElementById('modelSelect').addEventListener('change', (e) => saveConfig({ model: e.target.value }));
document.getElementById('autoAnalyze').addEventListener('change', (e) => saveConfig({ autoAnalyze: e.target.checked }));
document.getElementById('searchUrl').addEventListener('change', (e) => saveConfig({ searchUrl: e.target.value.trim() }));
document.getElementById('batchSize').addEventListener('change', (e) => {
  const n = Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 8));
  e.target.value = n;
  saveConfig({ batchSize: n });
});
document.getElementById('minConfidence').addEventListener('change', (e) => {
  const n = Math.max(0, Math.min(1, parseFloat(e.target.value)));
  const value = Number.isNaN(n) ? 0.35 : n;
  e.target.value = value;
  saveConfig({ minConfidence: value });
});

document.getElementById('verifyKey').addEventListener('click', async () => {
  const el = document.getElementById('verifyResult');
  el.className = 'verify-result';
  el.textContent = 'Testing…';
  // Use whatever is in the box right now, even if it hasn't blurred yet.
  const key = document.getElementById('apiKey').value.trim();
  const patch = config.provider === 'openai' ? { openaiKey: key } : { geminiKey: key };
  await saveConfig({ ...patch, model: document.getElementById('modelSelect').value });
  try {
    const { sample } = await send('leads:verifyKey', { config });
    el.classList.add('ok');
    el.textContent = sample && sample.emails && sample.emails.length
      ? `Working — test post resolved to ${sample.emails[0]}`
      : 'Working';
  } catch (err) {
    el.classList.add('bad');
    el.textContent = err.message;
  }
});

document.getElementById('clearAnalyzed').addEventListener('click', async () => {
  if (!confirm('Clear all extracted results and re-analyse every collected job?')) return;
  await send('leads:clear', { scope: 'analyzed' });
  toast('Queued for re-analysis');
  render();
});

document.getElementById('clearAll').addEventListener('click', async () => {
  if (!confirm('Delete every collected job and its results? This cannot be undone.')) return;
  await send('leads:clear', { scope: 'all' });
  toast('Leads deleted');
  render();
});

chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'local') return;
  if (changes.leadJobs || changes.leadsRun || changes.leadsScrape || changes.leadsConfig) render();
});

render();
