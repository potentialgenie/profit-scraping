'use strict';

// Reads three things out of Upwork HTML: the countries under Preferred
// qualifications → Location, the freelancer profiles linked from "Client's
// recent history", and the location printed on a freelancer profile.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HistoryParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_FREELANCERS = 12;
  const HISTORY_KEYS = ['workHistory', 'buyerWorkHistory', 'clientHistory', 'jobHistory'];
  const PERSON_NAME_KEYS = ['contractorName', 'freelancerName', 'vendorName', 'displayName', 'shortName'];

  function decodeEntities(value) {
    return String(value || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  function cleanName(value) {
    const text = decodeEntities(value).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80) return null;
    if (/^(to freelancer:?|freelancer|view profile)$/i.test(text)) return null;
    return text;
  }

  function freelancerUrl(href) {
    let url;
    try { url = new URL(String(href || ''), 'https://www.upwork.com'); } catch { return null; }
    const host = url.hostname.replace(/^www\./, '');
    if (host !== 'upwork.com') return null;
    const match = url.pathname.match(/^\/(?:freelancers|fl)\/(~[0-9a-f]{10,}|[A-Za-z0-9][A-Za-z0-9_-]{1,60})\/?$/i);
    if (!match) return null;
    if (/^(search|login|signup)$/i.test(match[1])) return null;
    return `https://www.upwork.com/freelancers/${match[1]}`;
  }

  function balancedJsonAt(html, from) {
    const open = html[from];
    const close = open === '[' ? ']' : '}';
    if (close !== ']' && close !== '}') return null;
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

  function firstString(obj, keys) {
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  function personFromNode(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const named = firstString(node, PERSON_NAME_KEYS);
    const genericName = !node.title && !node.jobTitle ? firstString(node, ['name']) : null;
    const name = cleanName(named || genericName);
    if (!name) return null;

    const explicit = freelancerUrl(firstString(node, ['profileUrl', 'vanityUrl', 'url', 'href', 'link']));
    if (explicit) return { name, url: explicit };

    const cipher = firstString(node, ['ciphertext', 'cipherText']);
    if (cipher && /^~[0-9a-f]{10,}$/i.test(cipher)) {
      return { name, url: `https://www.upwork.com/freelancers/${cipher}` };
    }
    return null;
  }

  function peopleInEntry(entry) {
    const found = [];
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 5) return;
      if (Array.isArray(node)) {
        node.forEach((item) => walk(item, depth + 1));
        return;
      }
      const person = personFromNode(node);
      if (person) found.push(person);
      Object.values(node).forEach((value) => {
        if (value && typeof value === 'object') walk(value, depth + 1);
      });
    })(entry, 0);
    return found;
  }

  function freelancersFromHistoryJson(html) {
    const source = String(html || '');
    for (const key of HISTORY_KEYS) {
      const marker = source.indexOf(`"${key}":[`);
      if (marker === -1) continue;
      const slice = balancedJsonAt(source, marker + key.length + 3);
      if (!slice) continue;
      let entries;
      try { entries = JSON.parse(slice); } catch { continue; }
      if (!Array.isArray(entries) || !entries.length) continue;
      const people = [];
      for (const entry of entries) people.push(...peopleInEntry(entry));
      if (people.length) return people;
    }
    return [];
  }

  function freelancersFromHistoryMarkup(html) {
    const source = String(html || '');
    const heading = /client'?s\s+(?:recent\s+)?(?:work\s+)?history/i.exec(source);
    if (!heading) return [];
    const start = source.lastIndexOf('<', heading.index);
    const rest = source.slice(start === -1 ? heading.index : start, (start === -1 ? heading.index : start) + 120000);
    const nextHeading = rest.slice(1).search(/<h[1-3]\b/i);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
    const people = [];
    const linkRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRe.exec(section))) {
      const url = freelancerUrl(match[2]);
      if (!url) continue;
      const attrs = `${match[1]} ${match[3]}`;
      const aria = attrs.match(/aria-label\s*=\s*["']([^"']+)["']/i);
      const title = attrs.match(/\btitle\s*=\s*["']([^"']+)["']/i);
      const name = cleanName(match[4]) || cleanName(aria && aria[1]) || cleanName(title && title[1]);
      if (name) people.push({ name, url });
    }
    return people;
  }

  function dedupeFreelancers(list) {
    const byUrl = new Map();
    for (const person of list) {
      if (!person || !person.url) continue;
      const name = cleanName(person.name) || 'Freelancer';
      const prev = byUrl.get(person.url);
      if (!prev) byUrl.set(person.url, { name, url: person.url });
      else if (name.length > prev.name.length) byUrl.set(person.url, { name, url: person.url });
    }
    return [...byUrl.values()].slice(0, MAX_FREELANCERS);
  }

  function freelancersFromJobHtml(html) {
    // Rendered history links are the rows the user can click. The JSON list is
    // only a fallback for pages that have not painted that section, because an
    // earlier "workHistory" array on the page can belong to someone else.
    const fromMarkup = freelancersFromHistoryMarkup(html);
    if (fromMarkup.length) return dedupeFreelancers(fromMarkup);
    return dedupeFreelancers(freelancersFromHistoryJson(html));
  }

  function plausibleLocation(value) {
    const text = decodeEntities(value).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60 || /[.!?]/.test(text)) return null;
    return text;
  }

  function formatLocation(city, country) {
    const place = plausibleLocation(city);
    const nation = plausibleLocation(country);
    if (place && nation && place.toLowerCase() !== nation.toLowerCase()) return `${place}, ${nation}`;
    return nation || place || null;
  }

  function countryFromLabel(label) {
    const parts = String(label || '').split(',').map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function isVietnamLocation(country, label) {
    if (/^(vn|vnm)$/i.test(String(country || '').trim())) return true;
    return /\bviet\s*nam\b/i.test(`${country || ''} ${label || ''}`);
  }

  function locationResult(city, country, label) {
    const text = label || formatLocation(city, country);
    const nation = country || countryFromLabel(text);
    if (!text && !nation) return { label: null, country: null, vietnam: false };
    return {
      label: text || nation,
      country: nation || null,
      vietnam: isVietnamLocation(nation, text),
    };
  }

  function locationFromAttribute(html) {
    const re = /data-(?:test|qa|cy)\s*=\s*["'][^"']*location[^"']*["'][^>]*>/gi;
    let match;
    while ((match = re.exec(html))) {
      const chunk = html.slice(match.index + match[0].length, match.index + match[0].length + 500);
      const text = chunk.split(/<\/(?:div|span|p|li|a)>/i)[0];
      const location = plausibleLocation(text);
      if (location) return locationResult(null, null, location);
    }
    return null;
  }

  function locationFromLocalTime(html) {
    const tagged = html.match(/>([^<]{2,60})<\/(?:span|div|p)>(?:(?!local time)[\s\S]){0,80}local time/i);
    if (tagged) {
      const location = plausibleLocation(tagged[1]);
      if (location) return locationResult(null, null, location);
    }
    const inline = html.match(/([^<>]{2,60}?)\s+[–—-]\s+\d{1,2}:\d{2}\s*(?:am|pm)?\s*local time/i);
    if (inline) {
      const location = plausibleLocation(inline[1]);
      if (location) return locationResult(null, null, location);
    }
    return null;
  }

  function addressFromJsonLd(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = addressFromJsonLd(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const country = firstString(node, ['addressCountry', 'country']);
    const city = firstString(node, ['addressLocality', 'addressRegion', 'city']);
    if (country || city) return locationResult(city, country, null);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const found = addressFromJsonLd(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function locationFromJsonLd(html) {
    const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = re.exec(html))) {
      try {
        const found = addressFromJsonLd(JSON.parse(match[1].trim()), 0);
        if (found && (found.label || found.country)) return found;
      } catch { /* malformed block */ }
    }
    return null;
  }

  function locationFromJsonObject(html) {
    const re = /"location"\s*:\s*\{/g;
    let match;
    while ((match = re.exec(html))) {
      const brace = match.index + match[0].lastIndexOf('{');
      const slice = balancedJsonAt(html, brace);
      if (!slice) continue;
      try {
        const obj = JSON.parse(slice);
        const country = firstString(obj, ['country', 'countryName', 'addressCountry']);
        const city = firstString(obj, ['city', 'cityName', 'addressLocality']);
        if (!country && !city) continue;
        if ((country || '').length > 40 || (city || '').length > 40) continue;
        return locationResult(city, country, null);
      } catch { /* keep scanning */ }
    }
    return null;
  }

  const NOT_A_COUNTRY = /^(yes|no|independent|agency|worldwide|anywhere|any|remote|rising talent)$/i;

  function looksLikeCountryLine(line) {
    if (!line || line.length > 80 || /\d|[:.!?]/.test(line)) return false;
    return /[A-Za-z]/.test(line);
  }

  function splitCountries(value) {
    return String(value || '')
      .split(/\s*(?:,|;|\/|\band\b)\s*/i)
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part && part.length <= 40 && !NOT_A_COUNTRY.test(part));
  }

  function qualificationsSlice(html) {
    const start = String(html || '').search(/preferred\s+qualifications/i);
    if (start === -1) return '';
    const rest = html.slice(start, start + 30000);
    const end = rest.search(/client'?s\s+(?:recent\s+)?(?:work\s+)?history|about the client/i);
    return end === -1 ? rest : rest.slice(0, end);
  }

  function preferredFromMarkup(html) {
    const slice = qualificationsSlice(html);
    if (!slice) return [];
    const text = decodeEntities(slice.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '\n'));
    const at = text.search(/location\s*:/i);
    if (at === -1) return [];
    const after = text.slice(at).replace(/^location\s*:\s*/i, '');
    const countries = [];
    for (const rawLine of after.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(talent type|job success|include rising talent|english level|languages|rising talent)\b/i.test(line)) {
        if (countries.length) break;
        continue;
      }
      if (!looksLikeCountryLine(line) || line.split(/\s+/).length > 3) {
        if (countries.length) break;
        continue;
      }
      countries.push(...splitCountries(line));
      if (countries.length >= 12) break;
    }
    return countries;
  }

  function namesFromJsonArray(slice) {
    if (!slice) return [];
    try {
      const arr = JSON.parse(slice);
      if (!Array.isArray(arr)) return [];
      const names = [];
      for (const item of arr) {
        if (typeof item === 'string') names.push(item);
        else if (item && typeof item === 'object') {
          const name = firstString(item, ['name', 'country', 'countryName']);
          if (name) names.push(name);
        }
      }
      return names;
    } catch {
      return [];
    }
  }

  function preferredFromJson(html) {
    const source = String(html || '');
    const found = [];
    for (const key of ['preferredQualifications', 'qualifications', 'preferredFreelancerLocation', 'prefFreelancerLocation']) {
      const token = `"${key}"`;
      const marker = source.indexOf(token);
      if (marker === -1) continue;
      const after = marker + token.length;
      const bracket = source.indexOf('[', after);
      const brace = source.indexOf('{', after);
      if (bracket !== -1 && (brace === -1 || bracket < brace) && bracket - after < 16) {
        found.push(...namesFromJsonArray(balancedJsonAt(source, bracket)));
        continue;
      }
      if (brace === -1 || brace - after > 16) continue;
      const obj = balancedJsonAt(source, brace);
      if (!obj) continue;
      const countriesKey = obj.indexOf('"countries"');
      if (countriesKey === -1) continue;
      const arrAt = obj.indexOf('[', countriesKey);
      if (arrAt === -1) continue;
      found.push(...namesFromJsonArray(balancedJsonAt(obj, arrAt)));
    }
    return found.flatMap(splitCountries);
  }

  function preferredCountriesFromJobHtml(html) {
    const fromMarkup = preferredFromMarkup(html);
    const list = fromMarkup.length ? fromMarkup : preferredFromJson(html);
    const seen = new Set();
    const countries = [];
    for (const country of list) {
      const key = country.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      countries.push(country);
    }
    return {
      countries: countries.slice(0, 20),
      vietnam: countries.some((country) => isVietnamLocation(country, country)),
    };
  }

  function locationFromProfileHtml(html) {
    const source = String(html || '');
    return locationFromAttribute(source)
      || locationFromLocalTime(source)
      || locationFromJsonLd(source)
      || locationFromJsonObject(source)
      || { label: null, country: null, vietnam: false };
  }

  return {
    freelancersFromJobHtml,
    locationFromProfileHtml,
    preferredCountriesFromJobHtml,
    isVietnamLocation,
  };
});
