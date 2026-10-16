'use strict';

// Lead pipeline: ingest scraped search results, run them through the model in
// batches, and keep a resumable record of progress. Loaded into the service
// worker via importScripts (depends on llm.js).

const LEADS_JOBS_KEY = 'leadJobs';
const LEADS_CONFIG_KEY = 'leadsConfig';
const LEADS_RUN_KEY = 'leadsRun';
const LEADS_ALARM = 'leads-analyze';

// Oldest records are dropped past this point. Each row is ~2-6 KB, so this
// sits comfortably inside the unlimited-less local storage budget.
const MAX_STORED_JOBS = 1500;

const DEFAULT_SEARCH_URL =
  'https://www.upwork.com/nx/search/jobs?amount=5000-' +
  '&category2_uid=531770282580668420,531770282580668419,531770282580668418' +
  '&nav_dir=pop&per_page=50&q=%2F&sort=recency&t=0,1';

const DEFAULT_LEADS_CONFIG = {
  provider: 'gemini',
  geminiKey: '',
  openaiKey: '',
  model: '',
  searchUrl: DEFAULT_SEARCH_URL,
  // Re-fetch each job page for the untruncated description before analysing.
  enrich: true,
  // Download attached briefs and read their text. Costs an extra request per
  // file, but attachments are where contact details most often survive.
  readAttachments: true,
  // Batching trades round-trips for prompt size. Each job now carries its full
  // description plus the client's work history, so batches stay small.
  batchSize: 4,
  minConfidence: 0.35,
  autoAnalyze: true,
};

const leadsLog = (...a) => { if (DEBUG) console.log('%c[LeadFinder:leads]', 'color:#9c6ade', ...a); };

let analyzing = false;

// ─── Config ─────────────────────────────────────────────────

async function getLeadsConfig() {
  const stored = await chrome.storage.local.get(LEADS_CONFIG_KEY);
  const cfg = { ...DEFAULT_LEADS_CONFIG, ...(stored[LEADS_CONFIG_KEY] || {}) };
  if (!cfg.model) cfg.model = LLM_PROVIDERS[cfg.provider]?.models[0] || '';
  return cfg;
}

/** Shape the stored config into what llm.js expects (one active key). */
function toLlmConfig(cfg) {
  return {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.provider === 'openai' ? cfg.openaiKey : cfg.geminiKey,
  };
}

// ─── Local contact extraction ───────────────────────────────
// Runs before the model so the dashboard shows something immediately, and so
// an obvious email is never lost to a bad model response.

const LOCAL_EMAIL_RE = /[A-Z0-9._%+-]+\s*(?:@|\(\s*at\s*\)|\[\s*at\s*\])\s*[A-Z0-9.-]+\s*(?:\.|\(\s*dot\s*\)|\[\s*dot\s*\])\s*[A-Z]{2,}/gi;
const LOCAL_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"']{4,}/gi;
const LOCAL_HANDLE_RE = /\b(?:t\.me|telegram|discord|skype|linkedin\.com\/(?:in|company))\/?[^\s<>()"']*/gi;

function localContacts(text) {
  const body = String(text || '');
  const emails = [];
  for (const raw of body.match(LOCAL_EMAIL_RE) || []) {
    const cleaned = normalizeEmail(raw);
    if (cleaned && !emails.includes(cleaned)) emails.push(cleaned);
  }
  const links = [];
  for (const raw of [...(body.match(LOCAL_URL_RE) || []), ...(body.match(LOCAL_HANDLE_RE) || [])]) {
    const url = raw.replace(/[.,;:)]+$/, '');
    if (/upwork\.com/i.test(url)) continue;
    if (!links.includes(url)) links.push(url);
  }
  return { emails, links: links.slice(0, 8) };
}

// ─── Attachments ────────────────────────────────────────────

// How much attachment text we keep on disk. llm.js applies its own, smaller
// cap when building the prompt.
const MAX_STORED_ATTACHMENT_CHARS = 20000;

function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && (a.name || a.text))
    .map((a) => ({
      name: String(a.name || 'attachment').slice(0, 200),
      text: String(a.text || '').slice(0, MAX_STORED_ATTACHMENT_CHARS),
    }));
}

function attachmentChars(list) {
  return (Array.isArray(list) ? list : []).reduce((n, a) => n + (a.text || '').length, 0);
}

/**
 * Everything the regex prefilter should see. An email inside an attached brief
 * counts just as much as one in the posting, so scan the whole body of
 * evidence rather than the description alone.
 */
function evidenceText(job) {
  return [
    job.description || '',
    job.clientHistory || '',
    ...(job.attachments || []).map((a) => `${a.name}\n${a.text || ''}`),
  ].join('\n');
}

// ─── Storage ────────────────────────────────────────────────

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

async function getLeadsRun() {
  const stored = await chrome.storage.local.get(LEADS_RUN_KEY);
  return stored[LEADS_RUN_KEY] || { status: 'idle', total: 0, done: 0, failed: 0, message: '' };
}

function setLeadsRun(run) {
  return chrome.storage.local.set({ [LEADS_RUN_KEY]: run });
}

/**
 * Merge freshly scraped rows into storage. Existing rows keep their analysis
 * unless the description grew — a longer description can reveal contact
 * details the first pass never saw, so that re-queues the job.
 */
async function ingestLeadJobs(incoming) {
  const existing = await getLeadJobs();
  const byId = new Map(existing.map((j) => [j.id, j]));
  const now = Date.now();
  let added = 0;
  let requeued = 0;

  for (const row of incoming || []) {
    if (!row || !row.id || !row.title) continue;
    const description = String(row.description || '').trim();
    const prev = byId.get(row.id);

    if (!prev) {
      const job = {
        id: row.id,
        url: row.url || `https://www.upwork.com/jobs/${row.id}`,
        title: row.title,
        description,
        clientHistory: row.clientHistory || null,
        attachments: normalizeAttachments(row.attachments),
        postedOn: row.postedOn || null,
        budget: row.budget ?? null,
        hourlyRange: row.hourlyRange || null,
        country: row.country || null,
        capturedAt: now,
        state: 'pending',
        analysis: null,
        error: null,
      };
      job.local = localContacts(evidenceText(job));
      byId.set(row.id, job);
      added++;
      continue;
    }

    // A fuller description, newly-captured history or a newly-read attachment
    // are all new evidence, so an analysed job goes back in the queue.
    const grew = description.length > (prev.description || '').length;
    const gainedHistory = row.clientHistory && !prev.clientHistory;
    const attachments = normalizeAttachments(row.attachments);
    const gainedAttachments = attachmentChars(attachments) > attachmentChars(prev.attachments);

    if (grew) prev.description = description;
    if (gainedHistory) prev.clientHistory = row.clientHistory;
    if (gainedAttachments) prev.attachments = attachments;
    if (grew || gainedHistory || gainedAttachments) prev.local = localContacts(evidenceText(prev));
    if ((grew || gainedHistory || gainedAttachments) && prev.state === 'done') {
      prev.state = 'pending';
      requeued++;
    }
    if (!prev.postedOn && row.postedOn) prev.postedOn = row.postedOn;
    if (prev.budget == null && row.budget != null) prev.budget = row.budget;
    prev.seenAt = now;
  }

  await saveLeadJobs([...byId.values()]);
  leadsLog(`ingest: ${added} new, ${requeued} re-queued, ${byId.size} total`);
  return { added, requeued, total: byId.size };
}

// ─── Analysis run ───────────────────────────────────────────

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Write a batch's results back onto the stored records. */
async function applyResults(batch, results, errorMessage) {
  const jobs = await getLeadJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const now = Date.now();

  for (const job of batch) {
    const target = byId.get(job.id);
    if (!target) continue;
    const result = results && results.get(job.id);
    if (result) {
      // Union the model's findings with the regex pass — the model is better
      // at names and intent, the regex never misses a literal address.
      const emails = [...new Set([...(result.emails || []), ...((target.local && target.local.emails) || [])])];
      target.analysis = { ...result, emails, hasClientInfo: result.hasClientInfo || emails.length > 0 };
      target.state = 'done';
      target.error = null;
    } else {
      target.state = 'error';
      target.error = errorMessage || 'No result returned for this job';
    }
    target.analyzedAt = now;
  }

  await saveLeadJobs([...byId.values()]);
}

/**
 * Analyse every pending job. Safe to call repeatedly — concurrent calls no-op,
 * and progress is persisted after each batch so an interrupted run resumes.
 */
async function runLeadAnalysis() {
  if (analyzing) return { ok: true, alreadyRunning: true };
  const cfg = await getLeadsConfig();
  const llmCfg = toLlmConfig(cfg);

  if (!llmCfg.apiKey) {
    await setLeadsRun({
      status: 'error', total: 0, done: 0, failed: 0,
      message: `Add a ${LLM_PROVIDERS[cfg.provider].label} API key in Settings to analyse jobs.`,
    });
    return { ok: false, error: 'missing-api-key' };
  }

  const all = await getLeadJobs();
  const pending = all.filter((j) => j.state === 'pending' && (j.description || '').length > 30);
  if (!pending.length) {
    await setLeadsRun({ status: 'idle', total: 0, done: 0, failed: 0, message: 'Nothing to analyse.' });
    return { ok: true, analyzed: 0 };
  }

  analyzing = true;
  const run = {
    status: 'running',
    total: pending.length,
    done: 0,
    failed: 0,
    message: `Analysing ${pending.length} job${pending.length === 1 ? '' : 's'}…`,
    startedAt: Date.now(),
  };
  await setLeadsRun(run);
  // Watchdog: if the service worker is torn down mid-run, this picks it up.
  chrome.alarms.create(LEADS_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });

  try {
    for (const batch of chunk(pending, Math.max(1, Math.min(20, cfg.batchSize)))) {
      let results = null;
      let failure = null;

      try {
        results = await analyzeJobs(batch, llmCfg);
      } catch (err) {
        failure = String(err && err.message ? err.message : err);
        // One oversized or malformed job can poison a whole batch. Retry the
        // items individually so the rest of the batch still lands.
        if (batch.length > 1) {
          results = new Map();
          for (const job of batch) {
            try {
              const single = await analyzeJobs([job], llmCfg);
              const hit = single.get(job.id);
              if (hit) results.set(job.id, hit);
            } catch { /* recorded as an error below */ }
          }
          if (results.size) failure = null;
        }
      }

      await applyResults(batch, results, failure);
      run.done += results ? results.size : 0;
      run.failed += batch.length - (results ? results.size : 0);
      run.message = `Analysed ${run.done} of ${run.total}…`;
      await setLeadsRun(run);
      leadsLog(`batch done — ${run.done}/${run.total} (${run.failed} failed)`);

      // A hard auth/quota failure will hit every remaining batch too.
      if (failure && /API key rejected|Rate limited/i.test(failure)) {
        run.status = 'error';
        run.message = failure;
        await setLeadsRun(run);
        return { ok: false, error: failure };
      }
    }

    run.status = 'done';
    run.finishedAt = Date.now();
    run.message = run.failed
      ? `Analysed ${run.done} job${run.done === 1 ? '' : 's'}, ${run.failed} failed.`
      : `Analysed ${run.done} job${run.done === 1 ? '' : 's'}.`;
    await setLeadsRun(run);
    return { ok: true, analyzed: run.done, failed: run.failed };
  } catch (err) {
    run.status = 'error';
    run.message = String(err && err.message ? err.message : err);
    await setLeadsRun(run);
    return { ok: false, error: run.message };
  } finally {
    analyzing = false;
    chrome.alarms.clear(LEADS_ALARM);
  }
}

/** Resume an interrupted run — called from the analysis alarm. */
async function resumeLeadAnalysis() {
  if (analyzing) return;
  const run = await getLeadsRun();
  if (run.status !== 'running') { chrome.alarms.clear(LEADS_ALARM); return; }
  const jobs = await getLeadJobs();
  if (!jobs.some((j) => j.state === 'pending')) {
    await setLeadsRun({ ...run, status: 'done', finishedAt: Date.now() });
    chrome.alarms.clear(LEADS_ALARM);
    return;
  }
  leadsLog('resuming interrupted analysis run');
  runLeadAnalysis();
}

/** Clear stored leads. `scope` is 'all' or 'analyzed'. */
async function clearLeads(scope) {
  if (scope === 'analyzed') {
    const jobs = await getLeadJobs();
    await saveLeadJobs(jobs.map((j) => ({ ...j, state: 'pending', analysis: null, error: null })));
  } else {
    await chrome.storage.local.set({ [LEADS_JOBS_KEY]: [] });
  }
  await setLeadsRun({ status: 'idle', total: 0, done: 0, failed: 0, message: '' });
}

async function focusOrCreateTab(url, matcher) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (matcher ? matcher(t) : t.url === url));
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

/**
 * Scrape whichever search page is open, preferring the one the user is
 * looking at. Opens the saved search if there isn't one.
 *
 * Returns once the scrape has *started* — it runs in the page and reports
 * progress through storage, so it survives the popup closing.
 */
async function scrapeSearchTab(enrich, readAttachments) {
  const tabs = await chrome.tabs.query({});
  let tab = tabs.find((t) => t.active && isSearchUrl(t.url)) || tabs.find((t) => isSearchUrl(t.url));
  let opened = false;

  if (!tab) {
    const cfg = await getLeadsConfig();
    tab = await chrome.tabs.create({ url: cfg.searchUrl || DEFAULT_SEARCH_URL });
    opened = true;
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  }

  // A freshly opened tab needs a moment before its content script answers.
  // An existing tab that never answers was loaded before this version of the
  // extension, and needs a reload.
  for (let i = 0; i < 24; i++) {
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { action: 'leads:ping' });
      if (pong && pong.ready) {
        await chrome.tabs.sendMessage(tab.id, { action: 'leads:scrapePage', enrich, readAttachments });
        return { ok: true, opened, tabId: tab.id };
      }
    } catch {
      // No listener yet — still loading, or the script predates this version.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(
    opened
      ? 'The search page is taking a while to load. Try again once the results appear.'
      : 'The search page did not respond. Reload that tab and try again.'
  );
}
