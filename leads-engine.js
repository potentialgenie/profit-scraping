'use strict';

// Stores scraped jobs and opens the results page. A job is worth keeping when
// someone in the client's recent history is a freelancer located in Vietnam.
// The content script does that check; this file only merges and remembers.

const LEADS_JOBS_KEY = 'leadJobs';
const LEADS_CONFIG_KEY = 'leadsConfig';
const LEADS_RUN_KEY = 'leadsRun';

const MAX_STORED_JOBS = 1500;
const MAX_DESCRIPTION_CHARS = 4000;

const DEFAULT_SEARCH_URL =
  'https://www.upwork.com/nx/search/jobs?amount=5000-' +
  '&category2_uid=531770282580668420,531770282580668419,531770282580668418' +
  '&nav_dir=pop&per_page=50&q=%2F&sort=recency&t=0,1';

const DEFAULT_LEADS_CONFIG = {
  searchUrl: DEFAULT_SEARCH_URL,
};

const leadsLog = (...a) => { if (typeof DEBUG !== 'undefined' && DEBUG) console.log('%c[LeadFinder:leads]', 'color:#9c6ade', ...a); };

async function getLeadsConfig() {
  const stored = await chrome.storage.local.get(LEADS_CONFIG_KEY);
  return { ...DEFAULT_LEADS_CONFIG, ...(stored[LEADS_CONFIG_KEY] || {}) };
}

function normalizeFreelancers(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const person of list) {
    if (!person || !person.url) continue;
    const url = String(person.url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      name: String(person.name || 'Freelancer').slice(0, 80),
      url,
      location: person.location ? String(person.location).slice(0, 80) : null,
      country: person.country ? String(person.country).slice(0, 60) : null,
      vietnam: person.vietnam === true,
      error: person.error ? String(person.error).slice(0, 160) : null,
    });
  }
  return out.slice(0, 12);
}

function hasVietnamFreelancer(job) {
  return (job.freelancers || []).some((person) => person.vietnam);
}

function isVietnamJob(job) {
  return job.locationMatch === true || hasVietnamFreelancer(job);
}

function normalizeCountries(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const text = String(item || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text || out.some((country) => country.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
  }
  return out.slice(0, 20);
}

async function getLeadJobs() {
  const stored = await chrome.storage.local.get(LEADS_JOBS_KEY);
  return stored[LEADS_JOBS_KEY] || [];
}

function saveLeadJobs(jobs) {
  const trimmed = jobs.length > MAX_STORED_JOBS
    ? [...jobs].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0)).slice(0, MAX_STORED_JOBS)
    : jobs;
  return chrome.storage.local.set({ [LEADS_JOBS_KEY]: trimmed });
}

/**
 * Merge one page of checked jobs into storage. A completed check replaces the
 * freelancer list. A failed open leaves a previous good check in place.
 */
async function ingestLeadJobs(incoming) {
  const existing = await getLeadJobs();
  const byId = new Map(existing.map((job) => [job.id, job]));
  const now = Date.now();
  let added = 0;
  let updated = 0;

  for (const row of incoming || []) {
    if (!row || !row.id || !row.title) continue;
    const description = String(row.description || '').trim().slice(0, MAX_DESCRIPTION_CHARS);
    const freelancers = normalizeFreelancers(row.freelancers);
    const preferredCountries = normalizeCountries(row.preferredCountries);
    const locationMatch = row.locationMatch === true || preferredCountries.some((country) => /\bviet\s*nam\b/i.test(country) || /^(vn|vnm)$/i.test(country));
    const prev = byId.get(row.id);

    if (!prev) {
      byId.set(row.id, {
        id: row.id,
        url: row.url || `https://www.upwork.com/jobs/${row.id}`,
        title: row.title,
        description,
        clientHistory: row.clientHistory || null,
        freelancers,
        preferredCountries,
        locationMatch,
        postedOn: row.postedOn || null,
        budget: row.budget ?? null,
        hourlyRange: row.hourlyRange || null,
        country: row.country || null,
        capturedAt: now,
        checked: row.checked === true,
        checkError: row.checked === true ? null : (row.checkError || null),
      });
      added++;
      continue;
    }

    if (row.checked === true) {
      prev.freelancers = freelancers;
      prev.preferredCountries = preferredCountries;
      prev.locationMatch = locationMatch;
      prev.checked = true;
      prev.checkError = null;
      if (description.length > (prev.description || '').length) prev.description = description;
      if (row.clientHistory) prev.clientHistory = row.clientHistory;
      updated++;
    } else if (row.checkError && prev.checked !== true) {
      prev.checkError = row.checkError;
    }
    if (!prev.postedOn && row.postedOn) prev.postedOn = row.postedOn;
    if (prev.budget == null && row.budget != null) prev.budget = row.budget;
    if (!prev.country && row.country) prev.country = row.country;
    if (!prev.hourlyRange && row.hourlyRange) prev.hourlyRange = row.hourlyRange;
    prev.seenAt = now;
  }

  const jobs = [...byId.values()];
  await saveLeadJobs(jobs);
  const vietnam = jobs.filter(isVietnamJob).length;
  leadsLog(`ingest: ${added} new, ${updated} updated, ${vietnam} Vietnam matches`);
  await chrome.storage.local.set({
    [LEADS_RUN_KEY]: {
      status: 'idle',
      total: jobs.length,
      vietnam,
      message: '',
    },
  });
  return { added, updated, vietnam, total: jobs.length };
}

async function clearLeads() {
  await chrome.storage.local.set({
    [LEADS_JOBS_KEY]: [],
    [LEADS_RUN_KEY]: { status: 'idle', total: 0, vietnam: 0, message: '' },
  });
}

async function focusOrCreateTab(url) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true });
    return existing;
  }
  return chrome.tabs.create({ url });
}

function openLeadsDashboard() {
  return focusOrCreateTab(chrome.runtime.getURL('leads.html'));
}

const isSearchUrl = (url) => (url || '').startsWith('https://www.upwork.com/nx/search/jobs');
const WATCH_KEY = 'leadsWatch';
const WATCH_ALARM = 'leads-watch';

async function startWatch() {
  await chrome.storage.local.set({
    [WATCH_KEY]: { active: true, phase: 'live', primed: false, seenIds: [], startedAt: Date.now() },
  });
  chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
  return scrapeSearchTab();
}

async function stopWatch() {
  await chrome.storage.local.set({ [WATCH_KEY]: { active: false, phase: 'idle' } });
  await chrome.alarms.clear(WATCH_ALARM);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!isSearchUrl(tab.url)) continue;
    try { await chrome.tabs.sendMessage(tab.id, { action: 'leads:stopWatch' }); } catch { /* tab has no listener */ }
  }
  await chrome.storage.local.set({
    leadsScrape: { active: false, watching: false, updatedAt: Date.now(), message: 'Stopped.' },
  });
  return { ok: true };
}

async function resumeWatch() {
  const stored = await chrome.storage.local.get(WATCH_KEY);
  const watch = stored[WATCH_KEY];
  if (!watch || !watch.active) {
    chrome.alarms.clear(WATCH_ALARM);
    return;
  }

  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((item) => item.active && isSearchUrl(item.url)) || tabs.find((item) => isSearchUrl(item.url));
  if (!tab) {
    const cfg = await getLeadsConfig();
    await chrome.tabs.create({ url: cfg.searchUrl || DEFAULT_SEARCH_URL, active: false });
    return;
  }

  let pong = null;
  try { pong = await chrome.tabs.sendMessage(tab.id, { action: 'leads:ping' }); } catch { /* still loading */ }
  if (pong && pong.scraping) return;
  if (pong && pong.ready) {
    chrome.tabs.sendMessage(tab.id, { action: 'leads:watchTick' });
    return;
  }
  chrome.tabs.reload(tab.id);
}

async function ensureWatchAlarm() {
  const stored = await chrome.storage.local.get(WATCH_KEY);
  if (stored[WATCH_KEY] && stored[WATCH_KEY].active) {
    chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
  }
}

/**
 * Scrape whichever search page is open, preferring the one the user is
 * looking at. Opens the saved search if there isn't one.
 *
 * Returns once the scrape has started. Profile checks keep running in the
 * page and report through storage, so closing the popup does not stop them.
 */
async function scrapeSearchTab() {
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((item) => item.active && isSearchUrl(item.url)) || tabs.find((item) => isSearchUrl(item.url));
  let opened = false;

  if (!tab) {
    const cfg = await getLeadsConfig();
    tab = await chrome.tabs.create({ url: cfg.searchUrl || DEFAULT_SEARCH_URL });
    opened = true;
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  }

  for (let i = 0; i < 24; i++) {
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { action: 'leads:ping' });
      if (pong && pong.ready) {
        await chrome.tabs.sendMessage(tab.id, { action: 'leads:scrapePage' });
        return { ok: true, opened, tabId: tab.id };
      }
    } catch {
      // No listener yet — still loading, or the script predates this version.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    opened
      ? 'The search page is taking a while to load. Try again once the results appear.'
      : 'The search page did not respond. Reload that tab and try again.'
  );
}
