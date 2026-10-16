'use strict';

// ─── Debug logging ──────────────────────────────────────────
// Flip DEBUG to false to silence all logs. Every line is tagged so you can
// filter the service-worker console by "[LeadFinder]".
const DEBUG = true;
const log = (...a) => { if (DEBUG) console.log('%c[LeadFinder:bg]', 'color:#4caf50', ...a); };

// Client-lead pipeline. Order matters: leads-engine.js uses llm.js.
importScripts('llm.js', 'leads-engine.js');

// ─── Alarms ─────────────────────────────────────────────────
// Analysis batches outlive the service worker, so progress resumes from an
// alarm rather than a timer (MV3 tears the worker down after ~30s idle).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LEADS_ALARM) {
    resumeLeadAnalysis().catch(console.error);
  }
});

// ─── Messages from the popup / leads dashboard ──────────────

const HANDLERS = {
  'leads:ingest': async (msg) => {
    const summary = await ingestLeadJobs(msg.jobs);
    const cfg = await getLeadsConfig();
    // Kick analysis off as soon as rows land so results appear while the
    // collector is still working through later pages.
    if (cfg.autoAnalyze && summary.added + summary.requeued > 0) {
      runLeadAnalysis().catch(console.error);
    }
    return summary;
  },
  'leads:analyze': () => runLeadAnalysis(),
  'leads:clear': (msg) => clearLeads(msg.scope).then(() => ({ ok: true })),
  'leads:openDashboard': () => openLeadsDashboard().then(() => ({ ok: true })),
  'leads:scrapeSearch': async (msg) => {
    const cfg = await getLeadsConfig();
    const enrich = msg.enrich != null ? msg.enrich : cfg.enrich;
    const readAttachments = msg.readAttachments != null ? msg.readAttachments : cfg.readAttachments;
    return scrapeSearchTab(enrich, readAttachments);
  },
  'leads:verifyKey': async (msg) => {
    const cfg = { ...(await getLeadsConfig()), ...(msg.config || {}) };
    const sample = await verifyApiKey(toLlmConfig(cfg));
    return { ok: true, sample };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.action];
  if (!handler) return;
  Promise.resolve(handler(msg))
    .then((result) => sendResponse(result || { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // async response
});

// ─── Upgrade cleanup ────────────────────────────────────────
// v1 shipped a job watchdog that polled watched jobs and raised desktop
// notifications. It's gone, so drop the state it left behind instead of
// letting it sit in local storage forever.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.clear('upwork-poll');
  chrome.storage.local.remove([
    'jobs', 'logs', 'lastPolled', 'notifyConfig', 'pageToken', 'columnWidths',
  ]);
  log('removed legacy watchdog state');
});

log('service worker started');
