(function () {
  'use strict';

  // Page-context half of the search scraper. The search page is a Nuxt SPA:
  // the first page of results is embedded in __NUXT__, every page after that
  // arrives over fetch/XHR. Both live in the page's JS world, so we read them
  // here and hand normalised rows to search-content.js over postMessage.

  const CHANNEL = 'UPWORK_SEARCH_RESULTS';
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log('%c[LeadFinder:search-inj]', 'color:#9c6ade', ...a); };

  const CIPHER_RE = /~0[0-9a-f]{10,}/i;

  // ─── Normalisation ──────────────────────────────────────────
  // Upwork has shipped several shapes for a search hit over the years
  // (REST `searchResults.jobs[]`, GraphQL `marketplaceJobPostingsSearch
  // .edges[].node`, Nuxt store `jobs[]`). Rather than bind to one, we accept
  // anything that carries a title, some prose, and a ~0… job key.

  function firstString(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  // The ~0… key identifies the job. Prefer the documented fields, then fall
  // back to scanning shallow string values for the pattern.
  function jobKeyOf(obj) {
    for (const k of ['ciphertext', 'jobCiphertext', 'uid', 'id', 'jobUid', 'key']) {
      const v = obj[k];
      if (typeof v === 'string') {
        const m = v.match(CIPHER_RE);
        if (m) return m[0];
      }
    }
    for (const k in obj) {
      const v = obj[k];
      if (typeof v === 'string' && v.length < 200) {
        const m = v.match(CIPHER_RE);
        if (m) return m[0];
      }
    }
    return null;
  }

  function amountOf(node) {
    const b = node.amount || node.budget || null;
    if (b && b.amount != null) return Number(b.amount);
    if (typeof node.budget === 'number') return node.budget;
    return null;
  }

  function hourlyOf(node) {
    const r = node.hourlyBudget || node.hourlyBudgetMin || node.extendedBudgetInfo || null;
    if (!r) return null;
    const min = r.hourlyBudgetMin ?? r.min ?? r.rawValue ?? null;
    const max = r.hourlyBudgetMax ?? r.max ?? null;
    if (min == null && max == null) return null;
    return [min, max].filter((n) => n != null).map(Number).join('-');
  }

  function looksLikeJob(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const title = firstString(o, ['title', 'jobTitle', 'name']);
    if (!title || title.length < 3) return false;
    const desc = firstString(o, ['description', 'shortDescription', 'snippet', 'jobDescription']);
    if (!desc) return false;
    return !!jobKeyOf(o);
  }

  function normalize(node, source) {
    const id = jobKeyOf(node);
    if (!id) return null;
    const title = firstString(node, ['title', 'jobTitle', 'name']);
    const description = firstString(node, ['description', 'shortDescription', 'snippet', 'jobDescription']);
    if (!title || !description) return null;

    return {
      id,
      url: `https://www.upwork.com/jobs/${id}`,
      title,
      description,
      // Search payloads truncate prose at ~300 chars with an ellipsis. Flagging
      // it lets the collector decide whether a full-text fetch is worth it.
      truncated: /[…]$|\.\.\.$/.test(description) || description.length >= 280,
      postedOn: firstString(node, ['createdOn', 'publishedOn', 'createdDateTime', 'publishTime']),
      jobType: firstString(node, ['type', 'jobType', 'engagement']),
      budget: amountOf(node),
      hourlyRange: hourlyOf(node),
      country: (node.client && node.client.location && node.client.location.country) ||
        (node.clientCountry) || null,
      source,
    };
  }

  // ─── Recursive search for the results array ─────────────────

  function collectJobs(root, source) {
    const found = new Map();
    const seen = new Set();

    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 12) return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          // GraphQL connections wrap each hit in an `edge`.
          const candidate = item && typeof item === 'object' && item.node ? item.node : item;
          if (looksLikeJob(candidate)) {
            const row = normalize(candidate, source);
            if (row && !found.has(row.id)) found.set(row.id, row);
          } else {
            walk(item, depth + 1);
          }
        }
        return;
      }

      for (const k in node) {
        try { walk(node[k], depth + 1); } catch { /* getters can throw */ }
      }
    })(root, 0);

    return [...found.values()];
  }

  function publish(jobs, source) {
    if (!jobs.length) return;
    log(`captured ${jobs.length} job(s) from ${source}`);
    window.postMessage({ type: CHANNEL, source, jobs }, '*');
  }

  // ─── Network interception ───────────────────────────────────

  function urlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && input.url) return input.url;
    } catch { /* ignore */ }
    return '';
  }

  function handleJson(url, json) {
    const jobs = collectJobs(json, 'network');
    if (jobs.length) {
      log('results in response from', url);
      publish(jobs, 'network');
    }
  }

  const origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch(input, init);
      p.then((res) => {
        try {
          if (!(res.headers.get('content-type') || '').includes('json')) return;
          res.clone().json().then((json) => handleJson(urlOf(input) || res.url, json)).catch(() => {});
        } catch { /* ignore */ }
      }).catch(() => {});
      return p;
    };
  }

  (function patchXhr() {
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__wdUrl = url;
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => {
        try {
          if (!(this.getResponseHeader('content-type') || '').includes('json')) return;
          handleJson(this.__wdUrl, JSON.parse(this.responseText));
        } catch { /* not ours */ }
      });
      return send.apply(this, arguments);
    };
  })();

  // ─── Initial page: results are server-rendered into __NUXT__ ──

  function readInitialState() {
    const roots = [window.__NUXT__, window.__NUXT_DATA__, window.__INITIAL_STATE__].filter(Boolean);
    for (const root of roots) {
      const jobs = collectJobs(root, 'nuxt');
      if (jobs.length) { publish(jobs, 'nuxt'); return true; }
    }
    return false;
  }

  // The Nuxt payload can hydrate slightly after this script runs, so retry a
  // few times before giving up and letting the DOM scraper carry the page.
  let tries = 0;
  (function pollInitial() {
    if (readInitialState() || ++tries > 10) return;
    setTimeout(pollInitial, 400);
  })();

  // search-content.js asks for a re-read after it navigates/paginates.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'UPWORK_SEARCH_RESCAN') readInitialState();
  });
})();
