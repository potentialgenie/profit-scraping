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
  // The feedback a client leaves and receives names them far more often than
  // the posting does — "Thanks, Katsiaryna" in a review is an identity the job
  // text never gives up. So capture that section too and let the model read it.

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

  // ─── Attachments ────────────────────────────────────────────
  // Briefs attached to a post routinely carry the letterhead the post itself
  // omits, so each file gets fetched and read (see doc-extract.js).

  const MAX_ATTACHMENTS = 3;
  const ATTACHMENT_KEYS = ['attachments', 'jobAttachments', 'files'];
  const ATTACHMENT_HREF = /\/(attachments?|download)\//i;

  function attachmentName(entry) {
    for (const key of ['name', 'fileName', 'filename', 'title', 'originalName']) {
      const v = entry[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  function attachmentUrl(entry) {
    for (const key of ['link', 'url', 'downloadUrl', 'href', 'path']) {
      const v = entry[key];
      if (typeof v === 'string' && v.trim()) {
        try { return new URL(v, 'https://www.upwork.com').href; } catch { /* unusable */ }
      }
    }
    return null;
  }

  function attachmentsFromJson(html) {
    for (const key of ATTACHMENT_KEYS) {
      const marker = html.indexOf(`"${key}":[`);
      if (marker === -1) continue;
      const slice = balancedJsonAt(html, marker + key.length + 3);
      if (!slice) continue;
      let entries;
      try { entries = JSON.parse(slice); } catch { continue; }
      if (!Array.isArray(entries) || !entries.length) continue;

      const out = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const name = attachmentName(entry);
        const url = attachmentUrl(entry);
        if (name || url) out.push({ name: name || 'attachment', url });
      }
      if (out.length) return out;
    }
    return [];
  }

  function attachmentsFromDom(doc) {
    const out = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (!ATTACHMENT_HREF.test(href) && !a.hasAttribute('download')) continue;
      let url;
      try { url = new URL(href, 'https://www.upwork.com').href; } catch { continue; }
      const name = (a.getAttribute('download') || a.textContent || '').trim();
      out.push({ name: name || 'attachment', url });
    }
    return out;
  }

  function attachmentsFromHtml(html, doc) {
    const found = attachmentsFromJson(html);
    const all = found.length || !doc ? found : attachmentsFromDom(doc);
    // Entries we can't fetch are still kept: a file named after the client
    // identifies them whether or not its contents are reachable.
    const seen = new Set();
    return all
      .filter((a) => {
        const key = a.url || a.name;
        return key && !seen.has(key) && seen.add(key);
      })
      .slice(0, MAX_ATTACHMENTS);
  }

  /** Read each attachment, keeping the filename even when the text won't parse. */
  async function readAttachments(list, onProgress) {
    const out = [];
    for (const item of list) {
      if (!scraping) break;
      if (!item.url) { out.push({ name: item.name, text: '' }); continue; }
      let text = '';
      try {
        text = await globalThis.extractAttachmentText(item.url);
      } catch (err) {
        onProgress && onProgress(`Attachment "${item.name}" unreadable (${err.message})`);
      }
      out.push({ name: item.name, text });
      await sleep(jitter());
    }
    return out;
  }

  async function fetchJobDetail(job) {
    const res = await fetch(job.url, { credentials: 'include', headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (/just a moment|cdn-cgi\/challenge/i.test(html)) throw new Error('Cloudflare challenge');

    const description = descriptionFromHtml(html);
    if (!description) throw new Error('description not found in page');

    let doc = null;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch { /* malformed */ }
    return {
      description,
      clientHistory: clientHistoryFromHtml(html, doc),
      attachments: attachmentsFromHtml(html, doc),
    };
  }

  async function enrichAll(jobs, onProgress, withAttachments) {
    let attempted = 0;
    let succeeded = 0;
    let failed = 0;

    for (const job of jobs) {
      if (!scraping) break;
      try {
        const detail = await fetchJobDetail(job);
        if (detail.description.length > (job.description || '').length) {
          job.description = detail.description;
          job.truncated = false;
        }
        if (detail.clientHistory) job.clientHistory = detail.clientHistory;
        if (detail.attachments.length) {
          job.attachments = withAttachments
            ? await readAttachments(detail.attachments, onProgress)
            : detail.attachments.map((a) => ({ name: a.name, text: '' }));
        }
        succeeded++;
      } catch (err) {
        failed++;
        // The odd failure is normal — deleted posts, private jobs. Five with
        // nothing getting through means Cloudflare is blocking us, and every
        // further request just deepens the hole.
        if (failed >= 5 && succeeded === 0) {
          onProgress(`Full-text fetch blocked (${err.message}) — using search snippets`);
          return;
        }
      }
      attempted++;
      onProgress(`Reading job ${attempted} of ${jobs.length}…`);
      await sleep(jitter());
    }
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

  async function scrapePage(enrich, readAttachmentsEnabled) {
    if (scraping) return;
    scraping = true;
    const status = (message) => setState({ active: true, message });

    try {
      await status('Reading results…');
      await waitForResults();

      // Ask the page-context script to re-read the hydrated store, then merge
      // the DOM pass over the top.
      window.postMessage({ type: 'UPWORK_SEARCH_RESCAN' }, '*');
      await sleep(400);

      const domRows = scrapeDom();
      domRows.forEach(mergeJob);

      // The DOM is the only reliable answer to "what is on *this* page" —
      // Upwork pages the results client-side, so `captured` still holds
      // everything from earlier pages in the same document.
      const onPage = new Set(domRows.map((r) => r.id));
      let jobs = [...captured.values()].filter((j) => onPage.has(j.id));

      // Markup we couldn't read, but the page's own JSON came through.
      if (!jobs.length && captured.size) jobs = [...captured.values()];

      if (!jobs.length) {
        const links = jobLinks().length;
        await setState({
          active: false,
          found: 0,
          error: links
            ? `Found ${links} job link${links === 1 ? '' : 's'} but couldn't read the tiles. Upwork's layout may have changed.`
            : 'No job results on this page. Scroll until the listings appear, then try again.',
        });
        return;
      }

      // Every job gets visited now, not just the ones with a clipped snippet:
      // the work history and attachments only exist on the job page, so
      // skipping the fetch loses them even when the description looks whole.
      if (enrich && jobs.length) await enrichAll(jobs, status, readAttachmentsEnabled);

      await status(`Saving ${jobs.length} job${jobs.length === 1 ? '' : 's'}…`);
      const reply = await chrome.runtime.sendMessage({ action: 'leads:ingest', jobs });
      const added = reply && reply.added != null ? reply.added : null;

      await setState({
        active: false,
        found: jobs.length,
        added,
        message: added == null
          ? `Saved ${jobs.length} job${jobs.length === 1 ? '' : 's'}.`
          : `${jobs.length} job${jobs.length === 1 ? '' : 's'} on this page · ${added} new.`,
      });
    } catch (err) {
      await setState({ active: false, error: String(err && err.message ? err.message : err) });
    } finally {
      scraping = false;
    }
  }

  // ─── Bridge + messages ──────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== CHANNEL) return;
    (e.data.jobs || []).forEach(mergeJob);
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
      scrapePage(!!msg.enrich, msg.readAttachments !== false);
      sendResponse({ ok: true, started: true });
    }
  });

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('search-injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
})();
