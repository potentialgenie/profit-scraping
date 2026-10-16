'use strict';

const SEARCH_PREFIX = 'https://www.upwork.com/nx/search/jobs';

function setStatus(text, kind) {
  const el = document.getElementById('leadStatus');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

/** Reflect the scrape state the content script publishes to storage. */
async function renderStatus() {
  const { leadsScrape: scrape, leadJobs = [] } = await chrome.storage.local.get(['leadsScrape', 'leadJobs']);
  const btn = document.getElementById('scrapePage');
  const busy = !!(scrape && scrape.active);

  btn.disabled = busy;
  btn.textContent = busy ? 'Scraping…' : 'Scrape this page';

  if (busy) return setStatus(scrape.message || 'Working…', 'busy');
  if (scrape && scrape.error) return setStatus(scrape.error, 'bad');
  if (scrape && scrape.message) return setStatus(scrape.message);
  setStatus(leadJobs.length ? `${leadJobs.length} jobs collected so far` : 'Open an Upwork job search, then scrape it.');
}

// The button scrapes the search page you're on; if you're somewhere else it
// opens your saved search first, so it does something sensible either way.
async function scrapeCurrentPage() {
  const enrich = document.getElementById('leadsEnrich').checked;
  const readAttachments = document.getElementById('leadsAttachments').checked;
  const { leadsConfig } = await chrome.storage.local.get('leadsConfig');
  await chrome.storage.local.set({ leadsConfig: { ...(leadsConfig || {}), enrich, readAttachments } });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSearch = tab && (tab.url || '').startsWith(SEARCH_PREFIX);
  setStatus(onSearch ? 'Starting…' : 'Opening your job search…', 'busy');

  const reply = await chrome.runtime.sendMessage({ action: 'leads:scrapeSearch', enrich, readAttachments });
  if (reply && reply.ok === false) {
    setStatus(reply.error || 'Could not start the scrape.', 'bad');
    return;
  }
  // The scrape runs in the page and reports through storage, so the popup can
  // close without stopping it.
  renderStatus();
}

async function init() {
  const { leadsConfig } = await chrome.storage.local.get('leadsConfig');
  document.getElementById('leadsEnrich').checked = leadsConfig ? leadsConfig.enrich !== false : true;
  document.getElementById('leadsAttachments').checked = leadsConfig ? leadsConfig.readAttachments !== false : true;
  syncAttachmentToggle();
  renderStatus();
}

// Attachments live on the job page, so reading them depends on enrichment.
const enrichBox = document.getElementById('leadsEnrich');
const attachBox = document.getElementById('leadsAttachments');
function syncAttachmentToggle() {
  attachBox.disabled = !enrichBox.checked;
  attachBox.parentElement.style.opacity = enrichBox.checked ? '' : '0.5';
}
enrichBox.addEventListener('change', syncAttachmentToggle);

document.getElementById('scrapePage').addEventListener('click', scrapeCurrentPage);
document.getElementById('openLeads').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'leads:openDashboard' }, () => window.close());
});

// Live-refresh while the popup is open.
chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'local') return;
  if (changes.leadsScrape || changes.leadJobs) renderStatus();
});

init();
