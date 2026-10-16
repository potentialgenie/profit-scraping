(function () {
  'use strict';

  // Content-script half of the search scraper. Passive: it watches the page
  // and waits to be told to scrape, so the user drives it from the popup
  // rather than from an overlay on Upwork's own UI.
  //
  // Two independent sources feed it — the rendered tiles, and whatever
  // search-injected.js manages to capture from the page's own JSON. Either
  // alone is enough, which is what keeps it working when Upwork reshuffles
  // its markup.

  const CHANNEL = 'UPWORK_SEARCH_RESULTS';
  const STATE_KEY = 'leadsScrape';

  // Every Upwork job is identified by this key. It appears in the tile's link
  // regardless of what path Upwork wraps around it, so the key is the only
  // thing worth matching on.
  const CIPHER_RE = /(~0[0-9a-f]{10,})/i;

  // Full-text fetches are same-origin requests against your own logged-in
  // session. Spacing them out keeps the pattern human and avoids tripping the
  // bot checks that would get the account challenged.
  const ENRICH_MIN_MS = 1400;
  const ENRICH_MAX_MS = 3200;

  /** Everything seen in this document, keyed by job id. */
  const captured = new Map();
  let scraping = false;
  let stopRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = () => ENRICH_MIN_MS + Math.random() * (ENRICH_MAX_MS - ENRICH_MIN_MS);

  function mergeJob(row) {
    if (!row || !row.id) return;
    const prev = captured.get(row.id) || {};
    // Longer prose wins: the DOM tile and the JSON payload truncate at
    // different lengths, and either may be the richer one.
    const description =
      (row.description || '').length > (prev.description || '').length
        ? row.description
        : prev.description;
    const merged = { ...prev, ...row, description };

    // The payload's exact timestamp beats a date rounded off from "2 hours
    // ago", whichever order the two sources happen to arrive in.
    if (prev.postedOn && !prev.postedApprox && row.postedApprox) {
      merged.postedOn = prev.postedOn;
      merged.postedApprox = false;
    }
    captured.set(row.id, merged);
  }

  // ─── Posted date ────────────────────────────────────────────
  // Display only now that runs no longer stop on a time window, but still
  // worth capturing: the leads table sorts and filters on it.

  const UNIT_MS = {
    second: 1000, minute: 60000, hour: 3600000,
    day: 86400000, week: 604800000, month: 2592000000,
  };

  function relativeAgeMs(text) {
    const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
    const counted = t.match(/posted\s+(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago/);
    if (counted) return Number(counted[1]) * UNIT_MS[counted[2]];
    if (/posted\s+(?:just now|less than a minute|a minute ago|moments ago)/.test(t)) return 0;
    if (/posted\s+yesterday/.test(t)) return UNIT_MS.day;
    if (/posted\s+last\s+week/.test(t)) return UNIT_MS.week;
    // Some tile variants drop the "Posted" prefix. Safe to match loosely here
    // because a search tile carries no other relative time. No word boundary
    // before the digits: textContent runs sibling elements together, so this
    // often arrives as "…fixed-price30 minutes ago".
    const bare = t.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s+ago\b/);
    if (bare) return Number(bare[1]) * UNIT_MS[bare[2]];
    return null;
  }

  function tileAgeMs(container) {
    const stamp = container.querySelector('time[datetime]');
    if (stamp) {
      const ms = Date.parse(stamp.getAttribute('datetime'));
      if (!Number.isNaN(ms)) return Math.max(0, Date.now() - ms);
    }
    for (const sel of ['[data-test*="ublished"]', '[data-test*="osted"]', 'small']) {
      const el = container.querySelector(sel);
      if (!el) continue;
      const age = relativeAgeMs(el.textContent);
      if (age != null) return age;
    }
    return relativeAgeMs(container.textContent);
  }

  // ─── DOM scraping ───────────────────────────────────────────

  function jobLinks() {
    return document.querySelectorAll('a[href*="~0"]');
  }

  function tileContainer(link) {
    let el = link;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const tag = el.tagName;
      if (tag === 'ARTICLE' || tag === 'SECTION' || el.dataset.test === 'JobTile') return el;
      if ((el.textContent || '').trim().length > 220) return el;
    }
    return link.parentElement;
  }

  function titleFor(link, container) {
    const direct = (link.textContent || '').replace(/\s+/g, ' ').trim();
    if (direct.length >= 3) return direct;
    // Some tiles wrap the link around an icon and put the title in a heading.
    const heading = container && container.querySelector('h1, h2, h3, h4, [data-test*="itle"]');
    const text = heading && heading.textContent.replace(/\s+/g, ' ').trim();
    return text && text.length >= 3 ? text : null;
  }

  function descriptionFrom(container, title) {
    const picks = [
      '[data-test="JobDescription"]',
      '[data-test="job-description-text"]',
      '[data-test*="escription"]',
      '.job-description',
      '.break',
    ];
    for (const sel of picks) {
      const el = container.querySelector(sel);
      const text = el && el.textContent.trim();
      if (text && text.length > 40) return text;
    }
    // Nothing matched a known hook — fall back to the tile's own text with the
    // title stripped off the front.
    let text = (container.textContent || '').replace(/\s+/g, ' ').trim();
    if (title && text.startsWith(title)) text = text.slice(title.length).trim();
    return text.length > 40 ? text : null;
  }

  /**
   * Read every job tile rendered on the page. Deliberately matches on the
   * ~0… key alone — an earlier version also required the link path to contain
   * "/jobs/", which silently discarded every result whenever Upwork linked
   * tiles through a different route.
   */
  function scrapeDom() {
    const rows = [];
    const seen = new Set();

    for (const link of jobLinks()) {
      const href = link.getAttribute('href') || '';
      const match = href.match(CIPHER_RE);
      if (!match) continue;

      const id = match[1];
      if (seen.has(id)) continue; // tiles often link to the same job twice

      const container = tileContainer(link);
      const title = titleFor(link, container);
      if (!title) continue;
      seen.add(id);

      const ageMs = tileAgeMs(container);
      rows.push({
        id,
        url: `https://www.upwork.com/jobs/${id}`,
        title,
        description: descriptionFrom(container, title) || '',
        truncated: true,
        ageMs,
        postedOn: ageMs == null ? null : new Date(Date.now() - ageMs).toISOString(),
        postedApprox: ageMs != null,
        source: 'dom',
      });
    }
    return rows;
  }

  // ─── Full-description fetch ─────────────────────────────────
  // Search payloads clip the description, and client contact details are
  // almost always at the very end of a post — so the clipped text is exactly
  // the part that loses them. Re-fetch the job page and read the full prose.

  function jsonStringAt(html, from) {
    // Reads one JSON string literal starting at `from` (the opening quote),
    // honouring backslash escapes. Used to pull a value out of the raw
    // __NUXT__ blob without parsing the whole (very large) payload.
    let out = '';
    for (let i = from + 1; i < html.length; i++) {
      const ch = html[i];
      if (ch === '\\') {
        const next = html[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'u') { out += String.fromCharCode(parseInt(html.slice(i + 2, i + 6), 16)); i += 4; }
        else out += next;
        i++;
        continue;
      }
      if (ch === '"') return out;
      out += ch;
    }
    return out;
  }

  function descriptionFromHtml(html) {
    // 1. The SSR state carries the authoritative, unclipped text.
    const marker = html.indexOf('"description":"');
    if (marker !== -1) {
      const text = jsonStringAt(html, marker + '"description":'.length);
      if (text && text.length > 80) return text;
    }

    // 2. Rendered markup.
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      for (const sel of ['[data-test="Description"]', '[data-test="job-description"]', '.job-description', 'section .break']) {
        const el = doc.querySelector(sel);
        const text = el && el.textContent.trim();
        if (text && text.length > 80) return text;
      }
      // 3. Last resort — the social preview blurb.
      const og = doc.querySelector('meta[property="og:description"], meta[name="description"]');
      const content = og && og.getAttribute('content');
      if (content && content.length > 80) return content;
    } catch { /* malformed HTML */ }

    return null;
  }

  // ─── Client work history ────────────────────────────────────
  // Each row links the freelancer the client hired. The profile page is where
  // their location is printed, so the names are collected here and resolved
  // below. The text is kept for the detail drawer.

  const MAX_HISTORY_ENTRIES = 15;
  const MAX_HISTORY_CHARS = 6000;

  // Keys Upwork has used for the client's past-contract list in the SSR state.
  const HISTORY_KEYS = ['workHistory', 'buyerWorkHistory', 'clientHistory', 'jobHistory'];
  const COMMENT_KEY = /^(comment|feedbackComment|text|message)$/i;
  const SCORE_KEY = /^(score|rating|overallRating|feedbackScore)$/i;
  const TITLE_KEY = /^(title|jobTitle)$/i;

  // Reads one balanced JSON array/object starting at `from` (the bracket), so
  // we can lift a single branch out of the very large __NUXT__ blob.
  function balancedJsonAt(html, from) {
    const open = html[from];
    const close = open === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = from; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close && !--depth) return html.slice(from, i + 1);
    }
    return null;
  }

  // Upwork renames these fields between releases, so rather than bind to one
  // shape we walk each entry and collect whatever reads like a title, score or
  // feedback comment.
  function historyEntryText(entry, depth = 0) {
    if (!entry || typeof entry !== 'object' || depth > 3) return { title: null, scores: [], comments: [] };
    const out = { title: null, scores: [], comments: [] };
    for (const [key, val] of Object.entries(entry)) {
      if (val == null) continue;
      if (typeof val === 'string') {
        const text = val.trim();
        if (!text) continue;
        if (TITLE_KEY.test(key) && !out.title) out.title = text;
        else if (COMMENT_KEY.test(key) && text.length > 15) out.comments.push(text);
      } else if (typeof val === 'number' && SCORE_KEY.test(key)) {
        out.scores.push(val);
      } else if (typeof val === 'object') {
        const nested = historyEntryText(val, depth + 1);
        if (nested.title && !out.title) out.title = nested.title;
        out.scores.push(...nested.scores);
        out.comments.push(...nested.comments);
      }
    }
    return out;
  }

  function historyFromJson(html) {
    for (const key of HISTORY_KEYS) {
      const marker = html.indexOf(`"${key}":[`);
      if (marker === -1) continue;
      const slice = balancedJsonAt(html, marker + key.length + 3);
      if (!slice) continue;
      let entries;
      try { entries = JSON.parse(slice); } catch { continue; }
      if (!Array.isArray(entries) || !entries.length) continue;

      const lines = [];
      for (const entry of entries.slice(0, MAX_HISTORY_ENTRIES)) {
        const { title, scores, comments } = historyEntryText(entry);
        if (!title && !comments.length) continue;
        const rating = scores.length ? ` (${scores[0]}/5)` : '';
        lines.push(`- ${title || 'Past contract'}${rating}`);
        for (const c of comments) lines.push(`  feedback: ${c}`);
      }
      if (lines.length) return lines.join('\n');
    }
    return null;
  }

  // Fallback: lift the rendered section verbatim. Unstructured text is fine —
  // the model only needs to read it.
  function historyFromDom(doc) {
    const headings = doc.querySelectorAll('h2, h3, h4, [data-test*="istory"]');
    for (const h of headings) {
      if (!/client'?s\s+(recent\s+)?(work\s+)?history/i.test(h.textContent || '')) continue;
      const section = h.closest('section, div[data-test], article') || h.parentElement;
      const text = section && section.textContent.replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
      if (text && text.length > 80) return text;
    }
    return null;
  }

  function clientHistoryFromHtml(html, doc) {
    let text = historyFromJson(html);
    if (!text && doc) text = historyFromDom(doc);
    if (!text) return null;
    return text.length > MAX_HISTORY_CHARS ? `${text.slice(0, MAX_HISTORY_CHARS)}\n…[more history omitted]…` : text;
  }

  // ─── Freelancer locations ───────────────────────────────────
  // History names the person. The country is on their profile, in the same
  // place you see after clicking "To freelancer". Profiles repeat across jobs,
  // so a location we already read is reused for the rest of the scrape.

  const PROFILE_CACHE_KEY = 'freelancerCache';
  const PROFILE_CACHE_MS = 14 * 24 * 60 * 60 * 1000;

  async function loadProfileCache() {
    const stored = await chrome.storage.local.get(PROFILE_CACHE_KEY);
    const all = stored[PROFILE_CACHE_KEY] || {};
    const now = Date.now();
    const map = new Map();
    for (const [url, row] of Object.entries(all)) {
      if (!row || !row.checkedAt || now - row.checkedAt > PROFILE_CACHE_MS) continue;
      map.set(url, row);
    }
    return map;
  }

  function saveProfileCache(map) {
    const obj = {};
    for (const [url, row] of map) {
      if (row && row.checkedAt && !row.error) obj[url] = row;
    }
    return chrome.storage.local.set({ [PROFILE_CACHE_KEY]: obj });
  }

  async function fetchJobDetail(job) {
    const res = await fetch(job.url, { credentials: 'include', headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (/just a moment|cdn-cgi\/challenge/i.test(html)) throw new Error('Cloudflare challenge');

    const description = descriptionFromHtml(html) || '';
    const title = titleFromHtml(html);
    let doc = null;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { /* malformed */ }
    const freelancers = globalThis.HistoryParse.freelancersFromJobHtml(html);
    const preferred = globalThis.HistoryParse.preferredCountriesFromJobHtml(html);
    const clientHistory = clientHistoryFromHtml(html, doc);
    if (!description && !freelancers.length && !clientHistory && !preferred.countries.length) {
      throw new Error('job page had no client history');
    }
    return {
      description,
      title,
      clientHistory,
      freelancers,
      preferredCountries: preferred.countries,
      locationMatch: preferred.vietnam === true,
    };
  }

  function titleFromHtml(html) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const raw = (og && og[1]) || (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || '';
    const text = raw.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.replace(/\s+[-|–—].*$/, '').trim() || null;
  }

  async function resolveFreelancers(people, cache, onProgress) {
    const out = [];
    let challenges = 0;

    for (const person of people) {
      if (!scraping || stopRequested) break;
      const hit = cache.get(person.url);
      if (hit) {
        out.push({ ...hit, name: person.name || hit.name, url: person.url });
        continue;
      }

      onProgress(`Opening ${person.name}'s profile…`);
      try {
        const res = await fetch(person.url, { credentials: 'include', headers: { accept: 'text/html' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (/just a moment|cdn-cgi\/challenge/i.test(html)) throw new Error('Cloudflare challenge');
        const loc = globalThis.HistoryParse.locationFromProfileHtml(html);
        const row = {
          name: person.name,
          url: person.url,
          location: loc.label,
          country: loc.country,
          vietnam: loc.vietnam === true,
          checkedAt: Date.now(),
        };
        cache.set(person.url, row);
        out.push(row);
        challenges = 0;
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        out.push({
          name: person.name,
          url: person.url,
          location: null,
          country: null,
          vietnam: false,
          error: message,
        });
        if (/Cloudflare challenge/i.test(message) && ++challenges >= 3) {
          onProgress('Upwork blocked profile checks. Saving the jobs already checked.');
          break;
        }
      }
      await sleep(jitter());
    }
    return { people: out, blocked: challenges >= 3 };
  }

  async function enrichAll(jobs, onProgress) {
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let blocked = false;
    const cache = await loadProfileCache();

    for (const job of jobs) {
      if (!scraping || stopRequested) break;
      try {
        const detail = await fetchJobDetail(job);
        if (detail.description.length > (job.description || '').length) {
          job.description = detail.description;
          job.truncated = false;
        }
        if (detail.title && (!job.title || job.title === 'New job')) job.title = detail.title;
        if (detail.clientHistory) job.clientHistory = detail.clientHistory;
        job.preferredCountries = detail.preferredCountries || [];
        job.locationMatch = detail.locationMatch === true;
        // The client already asked for Vietnam, so the freelancer profiles are
        // not needed to decide whether this job link is kept.
        if (job.locationMatch) {
          job.freelancers = [];
          job.checked = true;
          job.checkError = null;
          succeeded++;
        } else {
          const resolved = detail.freelancers.length
            ? await resolveFreelancers(detail.freelancers, cache, onProgress)
            : { people: [], blocked: false };
          job.freelancers = resolved.people;
          job.checked = true;
          job.checkError = null;
          succeeded++;
          if (resolved.blocked) blocked = true;
        }
      } catch (err) {
        failed++;
        job.checked = false;
        job.checkError = String(err && err.message ? err.message : err);
        // The odd failure is normal — deleted posts, private jobs. Five with
        // nothing getting through means Cloudflare is blocking us, and every
        // further request just deepens the hole.
        if (failed >= 5 && succeeded === 0) {
          onProgress(`Job pages blocked (${job.checkError}). Try again once the search results are visible.`);
          blocked = true;
        }
      }
      attempted++;
      if (job.checked === false) {
        onProgress(`Job ${attempted} of ${jobs.length} · couldn't open the job page`);
      } else if (job.locationMatch) {
        onProgress(`Job ${attempted} of ${jobs.length} · asked for ${(job.preferredCountries || []).join(', ')}`);
      } else {
        const matched = (job.freelancers || []).filter((f) => f.vietnam).map((f) => f.name);
        onProgress(matched.length
          ? `Job ${attempted} of ${jobs.length} · ${matched.join(', ')} in Vietnam`
          : `Job ${attempted} of ${jobs.length} · no Vietnam match`);
      }
      if (blocked) break;
      await sleep(jitter());
    }

    await saveProfileCache(cache);
    return blocked;
  }

  // ─── Progress, published to storage ─────────────────────────
  // The popup is free to close mid-scrape, so progress goes to storage rather
  // than back down an open message channel.

  function setState(patch) {
    return chrome.storage.local.set({
      [STATE_KEY]: { updatedAt: Date.now(), ...patch },
    });
  }

  // Wait for the tile list to render. Short, because the user triggers this
  // from a page they're already looking at.
  async function waitForResults(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (jobLinks().length > 0) {
        await sleep(400); // let the rest of the list settle
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  const CIPHER_ID_RE = /~0[0-9a-f]{10,}/gi;
  let wakeWatch = false;
  let lastSearchFetch = 0;

  function publishChecked(jobs) {
    const checkedJobs = jobs.filter((job) => job.checked === true || job.checkError);
    if (!checkedJobs.length) return null;
    return chrome.runtime.sendMessage({ action: 'leads:ingest', jobs: checkedJobs });
  }

  function stubsFromHtml(html) {
    const out = [];
    const seen = new Set();
    CIPHER_ID_RE.lastIndex = 0;
    let match;
    while ((match = CIPHER_ID_RE.exec(html))) {
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        url: `https://www.upwork.com/jobs/${id}`,
        title: 'New job',
        description: '',
      });
    }
    return out;
  }

  async function rememberSeen(ids, primed) {
    if (stopRequested) return;
    const { leadsWatch } = await chrome.storage.local.get('leadsWatch');
    const prev = leadsWatch || {};
    if (stopRequested || prev.active !== true) return;
    await chrome.storage.local.set({
      leadsWatch: {
        active: true,
        phase: 'live',
        primed: primed === true || prev.primed === true,
        startedAt: prev.startedAt || Date.now(),
        seenIds: [...ids].slice(-4000),
      },
    });
  }

  async function collectJobStubs() {
    window.postMessage({ type: 'UPWORK_SEARCH_RESCAN' }, '*');
    await sleep(300);
    const byId = new Map();
    scrapeDom().forEach((job) => byId.set(job.id, job));
    captured.forEach((job, id) => { if (!byId.has(id)) byId.set(id, job); });

    if (Date.now() - lastSearchFetch > 15000) {
      lastSearchFetch = Date.now();
      try {
        const res = await fetch(location.href, { credentials: 'include', headers: { accept: 'text/html' } });
        if (res.ok) {
          const html = await res.text();
          if (!/just a moment|cdn-cgi\/challenge/i.test(html)) {
            stubsFromHtml(html).forEach((job) => { if (!byId.has(job.id)) byId.set(job.id, job); });
          }
        }
      } catch { /* the tiles already collected are enough for this pass */ }
    }
    return [...byId.values()];
  }

  async function waitForSignal(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopRequested || wakeWatch) {
        wakeWatch = false;
        return;
      }
      await sleep(400);
    }
  }

  // Jobs already on screen when Start is clicked are the baseline. Only an id
  // that appears after that gets opened and reviewed.
  async function watchLive() {
    if (scraping) return;
    scraping = true;
    stopRequested = false;
    const status = (message) => setState({ active: true, watching: true, message });
    try {
      await waitForResults(8000);
      const { leadsWatch } = await chrome.storage.local.get('leadsWatch');
      const seen = new Set((leadsWatch && leadsWatch.seenIds) || []);
      if (!leadsWatch || !leadsWatch.primed) {
        (await collectJobStubs()).forEach((job) => seen.add(job.id));
        await rememberSeen(seen, true);
        await status('Waiting for a new job…');
      }

      while (!stopRequested) {
        const fresh = (await collectJobStubs()).filter((job) => !seen.has(job.id));
        if (!fresh.length) {
          await status('Waiting for a new job…');
          await waitForSignal(6000);
          continue;
        }
        fresh.forEach((job) => seen.add(job.id));
        await rememberSeen(seen, true);
        await status(`Reviewing ${fresh.length} new job${fresh.length === 1 ? '' : 's'}…`);
        const blocked = await enrichAll(fresh, status);
        await publishChecked(fresh);
        if (stopRequested) break;
        await status(blocked
          ? 'Upwork blocked a check. Still waiting for a new job…'
          : 'Waiting for a new job…');
        await waitForSignal(blocked ? 30000 : 4000);
      }
    } catch (err) {
      if (!stopRequested) {
        await setState({
          active: true,
          watching: true,
          error: String(err && err.message ? err.message : err),
          message: 'Waiting to retry…',
        });
      }
    } finally {
      scraping = false;
      if (stopRequested) await setState({ active: false, watching: false, message: 'Stopped.' });
    }
  }

  // ─── Bridge + messages ──────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== CHANNEL) return;
    (e.data.jobs || []).forEach(mergeJob);
    if (e.data.jobs && e.data.jobs.length) wakeWatch = true;
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.action === 'leads:ping') {
      // Lets the caller tell "content script isn't loaded" apart from "page
      // has no results", which need different advice.
      sendResponse({ ready: true, visible: jobLinks().length, scraping });
      return;
    }
    if (msg.action === 'leads:scrapePage') {
      if (scraping) { sendResponse({ ok: true, alreadyRunning: true }); return; }
      watchLive();
      sendResponse({ ok: true, started: true });
    }
    if (msg.action === 'leads:watchTick') {
      if (scraping) { sendResponse({ ok: true, alreadyRunning: true }); return; }
      watchLive();
      sendResponse({ ok: true, started: true });
    }
    if (msg.action === 'leads:stopWatch') {
      stopRequested = true;
      sendResponse({ ok: true });
    }
  });

  setTimeout(() => {
    chrome.storage.local.get('leadsWatch', ({ leadsWatch }) => {
      if (!leadsWatch || !leadsWatch.active || scraping) return;
      watchLive();
    });
  }, 700);

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('search-injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();
