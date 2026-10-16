'use strict';

const SEARCH_PREFIX = 'https://www.upwork.com/nx/search/jobs';

function setStatus(text, kind) {
  const el = document.getElementById('leadStatus');
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function vietnamCount(jobs) {
  return jobs.filter((job) => job.locationMatch || (job.freelancers || []).some((person) => person.vietnam)).length;
}

async function renderStatus() {
  const { leadsScrape: scrape, leadJobs = [], leadsWatch } = await chrome.storage.local.get(['leadsScrape', 'leadJobs', 'leadsWatch']);
  const btn = document.getElementById('scrapePage');
  const watching = !!(leadsWatch && leadsWatch.active);
  const busy = !!(scrape && scrape.active);

  btn.disabled = false;
  btn.textContent = watching ? 'Stop' : 'Start';

  if (busy || watching) return setStatus((scrape && (scrape.message || scrape.error)) || 'Waiting for a new job…', scrape && scrape.error ? 'bad' : 'busy');
  if (scrape && scrape.error) return setStatus(scrape.error, 'bad');
  if (scrape && scrape.message) return setStatus(scrape.message);
  const matches = vietnamCount(leadJobs);
  setStatus(leadJobs.length
    ? `${matches} Vietnam match${matches === 1 ? '' : 'es'}`
    : 'Press Start on an Upwork job search.');
}

async function scrapeCurrentPage() {
  const { leadsWatch } = await chrome.storage.local.get('leadsWatch');
  if (leadsWatch && leadsWatch.active) {
    const reply = await chrome.runtime.sendMessage({ action: 'leads:watchStop' });
    if (reply && reply.ok === false) setStatus(reply.error || 'Could not stop.', 'bad');
    else setStatus('Stopped.');
    renderStatus();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSearch = tab && (tab.url || '').startsWith(SEARCH_PREFIX);
  setStatus(onSearch ? 'Starting…' : 'Opening your job search…', 'busy');

  const reply = await chrome.runtime.sendMessage({ action: 'leads:scrapeSearch' });
  if (reply && reply.ok === false) {
    setStatus(reply.error || 'Could not start the watch.', 'bad');
    return;
  }
  renderStatus();
}

document.getElementById('scrapePage').addEventListener('click', () => {
  scrapeCurrentPage().catch((err) => setStatus(err.message || 'Could not start the scan.', 'bad'));
});
document.getElementById('openLeads').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'leads:openDashboard' }, () => window.close());
});

chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'local') return;
  if (changes.leadsScrape || changes.leadJobs || changes.leadsWatch) renderStatus();
});

renderStatus();
