'use strict';

const DEBUG = true;
const log = (...a) => { if (DEBUG) console.log('%c[LeadFinder:bg]', 'color:#4caf50', ...a); };

importScripts('leads-engine.js');

const HANDLERS = {
  'leads:ingest': (msg) => ingestLeadJobs(msg.jobs),
  'leads:clear': () => clearLeads().then(() => ({ ok: true })),
  'leads:openDashboard': () => openLeadsDashboard().then(() => ({ ok: true })),
  'leads:scrapeSearch': () => startWatch(),
  'leads:watchStop': () => stopWatch(),
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'leads-watch') resumeWatch().catch((err) => log('watch resume failed', err));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.action];
  if (!handler) return;
  Promise.resolve(handler(msg))
    .then((result) => sendResponse(result || { ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.clear('upwork-poll');
  chrome.alarms.clear('leads-analyze');
  chrome.storage.local.remove([
    'jobs', 'logs', 'lastPolled', 'notifyConfig', 'pageToken', 'columnWidths',
  ]);

  // v2 stored model output. Those rows were never checked for freelancer
  // location, so a first upgrade drops them and the saved API keys.
  const major = parseInt(String(details.previousVersion || '0'), 10);
  if (details.reason === 'update' && major < 3) {
    chrome.storage.local.remove(['leadJobs', 'leadsRun', 'leadsScrape']);
    chrome.storage.local.get('leadsConfig').then(({ leadsConfig }) => {
      if (!leadsConfig) return;
      chrome.storage.local.set({ leadsConfig: { searchUrl: leadsConfig.searchUrl || '' } });
    });
    log('cleared v2 lead results');
  }
  log('service worker installed');
});

ensureWatchAlarm().catch((err) => log('watch alarm failed', err));
log('service worker started');
