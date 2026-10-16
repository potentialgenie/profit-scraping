'use strict';

// Results page. A job matches when a freelancer linked from the client's
// recent history has Vietnam on their profile.

const DEFAULT_SEARCH_URL =
  'https://www.upwork.com/nx/search/jobs?amount=5000-' +
  '&category2_uid=531770282580668420,531770282580668419,531770282580668418' +
  '&nav_dir=pop&per_page=50&q=%2F&sort=recency&t=0,1';

let filter = 'vietnam';
let query = '';
let sortState = { key: 'capturedAt', type: 'date', dir: 'desc' };
let config = { searchUrl: DEFAULT_SEARCH_URL };
let rows = [];
let visible = [];
let toastTimer = null;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const ms = typeof ts === 'number' ? ts : Date.parse(ts);
  if (Number.isNaN(ms)) return '—';
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
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

function vietnamPeople(job) {
  return (job.freelancers || []).filter((person) => person.vietnam);
}

function isVietnamJob(job) {
  return job.locationMatch === true || vietnamPeople(job).length > 0;
}

function otherPeople(job) {
  return (job.freelancers || []).filter((person) => !person.vietnam);
}

function passesFilter(job, which = filter) {
  switch (which) {
    case 'vietnam': return isVietnamJob(job);
    case 'empty': return job.checked === true && !(job.freelancers || []).length && !job.locationMatch;
    case 'failed': return job.checked === false;
    default: return true;
  }
}

function matchesQuery(job) {
  if (!query) return true;
  const people = (job.freelancers || [])
    .map((person) => `${person.name} ${person.location || ''} ${person.country || ''}`)
    .join(' ');
  const places = (job.preferredCountries || []).join(' ');
  return `${job.title} ${people} ${places}`.toLowerCase().includes(query);
}

function sortValue(job, key, type) {
  const raw = job[key];
  if (raw === null || raw === undefined || raw === '') return null;
  if (type === 'date') {
    const ms = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
  }
  return String(raw).toLowerCase();
}

function applyView() {
  let list = rows.filter((job) => passesFilter(job) && matchesQuery(job));
  if (sortState.key) {
    const { key, type, dir } = sortState;
    list = [...list].sort((a, b) => {
      const av = sortValue(a, key, type);
      const bv = sortValue(b, key, type);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return dir === 'desc' ? -cmp : cmp;
    });
  }
  visible = list;
}

function personChip(person, kind) {
  const place = person.vietnam
    ? (person.location || person.country || 'Vietnam')
    : (person.location || person.country || (person.error ? 'location unread' : 'location unknown'));
  return `<button type="button" class="contact ${kind}" data-open="${escapeHtml(person.url)}" title="Open ${escapeHtml(person.name)}'s profile"><span>${escapeHtml(person.name)}</span><span class="place">${escapeHtml(place)}</span></button>`;
}

function peopleCell(people, kind) {
  if (!people.length) return '<span class="num-nil">—</span>';
  return `<div class="contacts">${people.slice(0, 4).map((person) => personChip(person, kind)).join('')}</div>`;
}

function renderSummary() {
  const matched = rows.filter(isVietnamJob);
  document.getElementById('sumTotal').textContent = rows.length;
  document.getElementById('sumVietnam').textContent = matched.length;
  document.getElementById('sumLocation').textContent = rows.filter((job) => job.locationMatch).length;
  document.getElementById('sumFailed').textContent = rows.filter((job) => job.checked === false).length;

  const count = (name) => rows.filter((job) => passesFilter(job, name)).length;
  document.getElementById('cntVietnam').textContent = count('vietnam');
  document.getElementById('cntAll').textContent = rows.length;
  document.getElementById('cntEmpty').textContent = count('empty');
  document.getElementById('cntFailed').textContent = count('failed');
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
      ? 'No jobs scanned yet. Open an Upwork search and scan it.'
      : query
        ? 'No jobs match your search.'
        : filter === 'vietnam'
          ? 'No job on this list asks for Vietnam or has a Vietnam freelancer in the client history.'
          : 'No jobs in this filter.';
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">${msg}</td></tr>`;
    return;
  }

  for (const job of visible) {
    const tr = document.createElement('tr');
    tr.dataset.jobId = job.id;
    if (isVietnamJob(job)) tr.classList.add('is-match');

    const sub = [];
    if (job.budget != null) sub.push(`$${Number(job.budget).toLocaleString()}`);
    else if (job.hourlyRange) sub.push(`$${escapeHtml(job.hourlyRange)}/hr`);
    if (job.postedOn) sub.push(`posted ${timeAgo(job.postedOn)}`);
    if (job.country) sub.push(escapeHtml(job.country));
    if (job.checked === false) sub.push('not checked');

    tr.innerHTML = `
      <td>
        <div class="lead-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
        ${sub.length ? `<div class="lead-sub">${sub.join('<span class="sep">·</span>')}</div>` : ''}
        ${(job.preferredCountries || []).length ? `<div class="loc-line${job.locationMatch ? ' is-hit' : ''}">Location: ${escapeHtml(job.preferredCountries.join(', '))}</div>` : ''}
      </td>
      <td>${peopleCell(vietnamPeople(job), 'vietnam')}</td>
      <td>${peopleCell(otherPeople(job), 'link')}</td>
      <td>${timeAgo(job.capturedAt)}</td>
      <td>
        <div class="row-actions">
          <button class="btn icon" data-action="open" title="Open job on Upwork">↗</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

function renderStatus(scrape) {
  const pill = document.getElementById('status');
  const text = document.getElementById('statusText');
  const busy = !!(scrape && scrape.active);
  pill.classList.toggle('checking', busy);

  if (busy) text.textContent = scrape.message || 'Scanning the search page…';
  else if (scrape && scrape.error) text.textContent = 'Scan stopped';
  else if (scrape && scrape.message) text.textContent = scrape.message;
  else {
    const matches = rows.filter(isVietnamJob).length;
    text.textContent = rows.length
      ? `${matches} Vietnam match${matches === 1 ? '' : 'es'}`
      : 'No jobs yet';
  }
}

function renderBanner(scrape) {
  const banner = document.getElementById('banner');
  const textEl = document.getElementById('bannerText');
  const action = document.getElementById('bannerAction');
  let message = null;
  let actionLabel = null;
  let onAction = null;
  let isError = false;

  if (scrape && !scrape.active && scrape.error) {
    message = scrape.error;
    isError = true;
  } else if (!rows.length) {
    message = 'Press Start. Each new job is reviewed as Upwork posts it.';
    actionLabel = 'Start';
    onAction = scanSearch;
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
  const stored = await chrome.storage.local.get(['leadJobs', 'leadsScrape', 'leadsConfig', 'leadsWatch']);
  config = { searchUrl: DEFAULT_SEARCH_URL, ...(stored.leadsConfig || {}) };
  rows = stored.leadJobs || [];
  applyView();
  renderSummary();
  renderTable();
  renderStatus(stored.leadsScrape);
  renderBanner(stored.leadsScrape);
  const label = document.getElementById('scrapeLabel');
  if (label) label.textContent = stored.leadsWatch && stored.leadsWatch.active ? 'Stop' : 'Start';
}

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
  const links = visible.map((job) => job.url);
  if (!links.length) { toast('Nothing to copy'); return; }
  copyToClipboard(links.join('\n'), `Copied ${links.length} job link${links.length === 1 ? '' : 's'}`);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!visible.length) { toast('Nothing to export'); return; }
  const header = ['Title', 'Job URL', 'Preferred locations', 'Vietnam freelancers', 'Freelancer locations', 'Other freelancers'];
  const lines = [header.map(csvCell).join(',')];
  for (const job of visible) {
    const matched = vietnamPeople(job);
    const others = otherPeople(job);
    lines.push([
      job.title,
      job.url,
      job.preferredCountries || [],
      matched.map((person) => person.name),
      matched.map((person) => person.location || person.country || ''),
      others.map((person) => `${person.name}${person.location ? ` (${person.location})` : ''}`),
    ].map(csvCell).join(','));
  }
  const blob = new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `upwork-vietnam-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${visible.length} row${visible.length === 1 ? '' : 's'}`);
}

function personLines(people) {
  if (!people.length) return '<p class="is-muted">None</p>';
  return `<div class="contacts">${people.map((person) => personChip(person, person.vietnam ? 'vietnam' : 'link')).join('')}</div>`;
}

function openDetail(job) {
  const matched = vietnamPeople(job);
  document.getElementById('detailTitle').textContent = job.title;
  document.getElementById('detailSub').textContent = job.locationMatch
    ? `Asked for ${(job.preferredCountries || []).join(', ')}`
    : matched.length
      ? `${matched.map((person) => person.name).join(', ')} in Vietnam`
      : 'No Vietnam match';

  const section = (heading, html) => `<div class="detail-section"><h3>${heading}</h3>${html}</div>`;
  let html = `
    <div class="detail-actions">
      <button class="btn primary" data-action="open">Open job</button>
      <button class="btn ghost" data-copy="${escapeHtml(job.url)}">Copy job link</button>
    </div>`;
  if ((job.preferredCountries || []).length) {
    html += section('Preferred location', `<p>${escapeHtml(job.preferredCountries.join(', '))}</p>`);
  }
  html += section('Vietnam freelancers', personLines(matched));
  html += section('Other freelancers in the history', personLines(otherPeople(job)));
  if (job.checked === false) {
    html += section('Check', `<p>${escapeHtml(job.checkError || 'This job page could not be opened.')}</p>`);
  }
  if (job.clientHistory) {
    html += section("Client's history", `<div class="detail-desc">${escapeHtml(job.clientHistory)}</div>`);
  }

  const body = document.getElementById('detailBody');
  body.innerHTML = html;
  body.querySelector('[data-action="open"]')?.addEventListener('click', () => openJobTab(job));
  document.getElementById('detailDrawer').hidden = false;
}

function closeDetail() {
  document.getElementById('detailDrawer').hidden = true;
}

function fillSettings() {
  document.getElementById('searchUrl').value = config.searchUrl || '';
}

async function saveConfig(patch) {
  config = { ...config, ...patch };
  const { leadsConfig } = await chrome.storage.local.get('leadsConfig');
  await chrome.storage.local.set({ leadsConfig: { ...(leadsConfig || {}), ...config } });
}

function openSettings() {
  fillSettings();
  document.getElementById('settingsModal').hidden = false;
}

function closeSettings() {
  document.getElementById('settingsModal').hidden = true;
  render();
}

async function scanSearch() {
  const { leadsWatch } = await chrome.storage.local.get('leadsWatch');
  try {
    if (leadsWatch && leadsWatch.active) {
      await send('leads:watchStop');
      toast('Stopped');
      return;
    }
    toast('Starting…');
    const reply = await send('leads:scrapeSearch');
    toast(reply.opened ? 'Opened your job search' : 'Waiting for a new job');
  } catch (err) {
    toast(err.message);
  }
}

document.getElementById('scrapeSearch').addEventListener('click', scanSearch);
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('copyLinks').addEventListener('click', copyVisibleLinks);
document.getElementById('exportCsv').addEventListener('click', exportCsv);

document.getElementById('filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll('#filters .chip').forEach((item) => item.classList.toggle('active', item === chip));
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
  if (sortState.key !== key) sortState = { key, type, dir: type === 'date' ? 'desc' : 'asc' };
  else sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  applyView();
  renderTable();
});

document.getElementById('leadsBody').addEventListener('click', (e) => {
  const profile = e.target.closest('[data-open]');
  if (profile) {
    e.stopPropagation();
    chrome.tabs.create({ url: profile.dataset.open });
    return;
  }
  const tr = e.target.closest('tr[data-job-id]');
  if (!tr) return;
  const job = rows.find((item) => item.id === tr.dataset.jobId);
  if (!job) return;
  if (e.target.closest('[data-action="open"]')) openJobTab(job);
  else openDetail(job);
});

document.getElementById('detailBody').addEventListener('click', (e) => {
  const profile = e.target.closest('[data-open]');
  if (profile) {
    chrome.tabs.create({ url: profile.dataset.open });
    return;
  }
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) copyToClipboard(copyBtn.dataset.copy, 'Copied job link');
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

document.getElementById('searchUrl').addEventListener('change', (e) => {
  saveConfig({ searchUrl: e.target.value.trim() });
});

document.getElementById('clearAll').addEventListener('click', async () => {
  if (!confirm('Delete every scanned job? This cannot be undone.')) return;
  await send('leads:clear');
  toast('Jobs deleted');
  render();
});

chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'local') return;
  if (changes.leadJobs || changes.leadsScrape || changes.leadsConfig || changes.leadsWatch) render();
});

render();
