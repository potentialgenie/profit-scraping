'use strict';

// Provider-agnostic extraction layer. Both Gemini and OpenAI can be pinned to
// a response schema, so the model returns parseable JSON instead of prose we'd
// have to guess at. Loaded into the service worker via importScripts.

const LLM_PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openai: {
    label: 'OpenAI',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

// Descriptions go to the model whole — identifying details cluster in the
// sign-off, so clipping the tail drops exactly what we're looking for. This
// ceiling is only a runaway guard; real postings run 1-10k characters.
const MAX_DESCRIPTION_CHARS = 40000;

// Work history is already capped at collection time; this is a second guard.
const MAX_HISTORY_CHARS = 6000;

// Attached briefs are the single richest source of contact details, so they
// get a generous share of the prompt.
const MAX_ATTACHMENT_CHARS = 12000;
const MAX_ATTACHMENTS = 3;

const SYSTEM_PROMPT = `You analyse Upwork job postings on behalf of a freelancer who wants to identify the real company or person behind each post.

For every job you receive, return one result object.

Each job has a "description" (the posting, verbatim), sometimes a "clientHistory" — the client's past contracts on Upwork with the feedback left in both directions — and sometimes "attachments", the files attached to the posting. Read all of them.

Attachments are the most reliable source of identity, because a brief written outside Upwork isn't subject to its contact-sharing rules. Treat them as follows:
- A letterhead, footer, signature block, or "about us" page in an attachment is strong evidence. Prefer it over anything implied by the posting.
- Each attachment has a "name" and a "text". The name alone can identify the client ("Northwind-Coffee-Brief.pdf"), so use it even when the text is empty or unreadable.
- Attachment text is machine-extracted from PDF and Word files, so it may have broken spacing, interleaved fragments, or missing characters. Read through the noise. An email or company name that is clearly legible despite mangled layout still counts.
- Do not report a value you had to guess at or repair because the extraction was garbled. If an email is broken mid-string, leave it out rather than reconstructing it.

The history is often where the client's identity leaks, because reviews address them by name. Treat it carefully:
- Freelancers thank the client by first name ("Thanks, Katsiaryna!", "Genuine pleasure to work with Katsiaryna") — that name is the CLIENT, and is a valid personName.
- The freelancer being reviewed is NOT the client. Names introduced as "To freelancer: …", or praised in the third person for delivering the work ("Sergey took us from a rough idea to a finished brand"), belong to the freelancer. Never report those as the client.
- Past contract titles describe the client's business and products, which is good evidence for companyName and clientSummary, but a product the client hired someone to build is not automatically their company name.
- When the description and the history disagree, prefer the description.

Decide "hasClientInfo":
- TRUE only when the posting identifies who the client actually is, or how to reach them off-platform. Qualifying signals: a named company or brand, a named person who is clearly the client or hiring manager, an email address, a phone number, a company website, a social/LinkedIn profile, an app or product name owned by the client, or a Calendly/Discord/Telegram handle.
- FALSE when the posting is only a specification: a list of requirements, skills, deliverables, or responsibilities with no identifying detail. Generic self-description such as "we are a fast-growing agency", "a US-based startup", or "our team" is NOT identifying information.
- Mentions of third-party tools the freelancer must use (Figma, AWS, Shopify, React) are NOT the client's identity. Neither are names of the client's own competitors or example sites given purely as inspiration.

Field rules:
- companyName / personName: copy the name exactly as written, or null if absent. personName must be a human name, not a username, unless the username is clearly how they want to be addressed.
- emails / phones / links: only values that actually appear in the text. Never invent, correct, or complete a partial value. Exclude upwork.com URLs. Return [] when there are none.
- clientSummary: one sentence on who the client appears to be and what they do. null when hasClientInfo is false.
- jobSummary: two sentences maximum covering what the job asks for and the scope. Always provide this, even when hasClientInfo is false.
- confidence: 0 to 1, how sure you are that the identity you extracted belongs to the client rather than to something incidental.
- signals: short phrases naming the evidence you used, e.g. "company name in first line", "email in sign-off", "client addressed by name in review".

Obfuscated contact details are common because Upwork filters them. Treat "name (at) company (dot) com", "name[at]company.com", and spaced-out addresses as emails, and normalise them to standard form.`;

// ─── Response schema ────────────────────────────────────────
// Same contract, two dialects: Gemini wants OpenAPI-style uppercase types with
// `nullable`, OpenAI's strict mode wants union types plus exhaustive
// `required` and `additionalProperties: false`.

function geminiSchema() {
  const strArray = { type: 'ARRAY', items: { type: 'STRING' } };
  return {
    type: 'OBJECT',
    properties: {
      results: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            hasClientInfo: { type: 'BOOLEAN' },
            companyName: { type: 'STRING', nullable: true },
            personName: { type: 'STRING', nullable: true },
            emails: strArray,
            phones: strArray,
            links: strArray,
            clientSummary: { type: 'STRING', nullable: true },
            jobSummary: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            signals: strArray,
          },
          required: ['id', 'hasClientInfo', 'emails', 'phones', 'links', 'jobSummary', 'confidence'],
        },
      },
    },
    required: ['results'],
  };
}

function openaiSchema() {
  const strArray = { type: 'array', items: { type: 'string' } };
  const nullableStr = { type: ['string', 'null'] };
  const item = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      hasClientInfo: { type: 'boolean' },
      companyName: nullableStr,
      personName: nullableStr,
      emails: strArray,
      phones: strArray,
      links: strArray,
      clientSummary: nullableStr,
      jobSummary: { type: 'string' },
      confidence: { type: 'number' },
      signals: strArray,
    },
  };
  item.required = Object.keys(item.properties);
  return {
    type: 'object',
    additionalProperties: false,
    properties: { results: { type: 'array', items: item } },
    required: ['results'],
  };
}

// ─── Request building ───────────────────────────────────────

function clip(text, maxChars) {
  const s = String(text || '').replace(/\s+\n/g, '\n').trim();
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  return `${s.slice(0, head)}\n…[trimmed]…\n${s.slice(-(maxChars - head))}`;
}

function buildUserPrompt(jobs) {
  const payload = jobs.map((j) => {
    const row = {
      id: j.id,
      title: j.title || '',
      description: clip(j.description, MAX_DESCRIPTION_CHARS),
    };
    // Omitted entirely when absent so the model never sees an empty field it
    // might try to reason about.
    const history = clip(j.clientHistory, MAX_HISTORY_CHARS);
    if (history) row.clientHistory = history;

    // Filenames go through even when the contents couldn't be parsed — a file
    // called "Northwind-Coffee-Brief.pdf" names the client on its own.
    const files = (j.attachments || []).slice(0, MAX_ATTACHMENTS).map((a) => ({
      name: a.name || 'attachment',
      text: clip(a.text, MAX_ATTACHMENT_CHARS),
    }));
    if (files.length) row.attachments = files;
    return row;
  });
  return `Analyse these ${jobs.length} job posting(s). Return exactly ${jobs.length} result object(s), one per input id.\n\n${JSON.stringify(payload, null, 1)}`;
}

async function readError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    try { detail = (await res.text()).slice(0, 300); } catch { /* give up */ }
  }
  if (res.status === 401 || res.status === 403) return `API key rejected (HTTP ${res.status}). ${detail}`;
  if (res.status === 429) return `Rate limited or out of quota (HTTP 429). ${detail}`;
  return `HTTP ${res.status}. ${detail}`;
}

async function callGemini(jobs, cfg) {
  const model = cfg.model || LLM_PROVIDERS.gemini.models[0];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: buildUserPrompt(jobs) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: geminiSchema(),
      },
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) {
    const reason = json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason;
    throw new Error(`Empty response from ${model}${reason ? ` (${reason})` : ''}`);
  }
  return text;
}

async function callOpenAI(jobs, cfg) {
  const model = cfg.model || LLM_PROVIDERS.openai.models[0];
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(jobs) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'upwork_client_extraction', strict: true, schema: openaiSchema() },
      },
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`Empty response from ${model}`);
  return text;
}

// ─── Normalisation ──────────────────────────────────────────

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Upwork strips contact details, so clients disguise them. Fold the common
// disguises back into a real address. "at"/"dot" are only treated as
// separators when bracketed or space-delimited — otherwise "donation" would
// turn into "don@ion".
function normalizeEmail(value) {
  const s = String(value || '')
    .replace(/\s*[([{<]\s*at\s*[)\]}>]\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*[([{<]\s*dot\s*[)\]}>]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*@\s*/g, '@')
    .replace(/\s*\.\s*/g, '.')
    .trim()
    .toLowerCase();
  const m = s.match(EMAIL_RE);
  return m ? m[0] : null;
}

function cleanList(value, mapper) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const v = mapper ? mapper(item) : String(item || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function cleanText(value, maxLen = 400) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s || /^(null|n\/a|none|unknown)$/i.test(s)) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function normalizeResult(raw) {
  const links = cleanList(raw.links, (v) => {
    const s = String(v || '').trim();
    if (!s || /upwork\.com/i.test(s)) return null;
    return s;
  });
  const emails = cleanList(raw.emails, normalizeEmail);
  const phones = cleanList(raw.phones, (v) => String(v || '').trim().replace(/\s{2,}/g, ' '));
  const companyName = cleanText(raw.companyName, 120);
  const personName = cleanText(raw.personName, 120);

  // Trust the evidence over the flag: a model that filled in a name or an
  // address but left hasClientInfo false has contradicted itself. A bare link
  // isn't enough — it's as likely to be a competitor or an inspiration site.
  const named = !!(companyName || personName || emails.length || phones.length);
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence)));

  return {
    hasClientInfo: raw.hasClientInfo === true || named,
    companyName,
    personName,
    emails,
    phones,
    links,
    clientSummary: cleanText(raw.clientSummary, 400),
    jobSummary: cleanText(raw.jobSummary, 600) || '',
    confidence: Number.isNaN(confidence) ? 0 : confidence,
    signals: cleanList(raw.signals).slice(0, 6),
  };
}

/**
 * Analyse a batch of jobs. Resolves to a Map of job id → normalised result.
 * Throws when the provider call itself fails, so the caller can decide
 * whether to retry the whole batch.
 */
async function analyzeJobs(jobs, cfg) {
  if (!jobs.length) return new Map();
  if (!cfg || !cfg.apiKey) throw new Error('No API key configured');

  const text = cfg.provider === 'openai' ? await callOpenAI(jobs, cfg) : await callGemini(jobs, cfg);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some models still wrap JSON in a fenced block despite the schema.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return JSON');
    parsed = JSON.parse(match[0]);
  }

  const rows = Array.isArray(parsed) ? parsed : parsed.results;
  if (!Array.isArray(rows)) throw new Error('Model response had no results array');

  const byId = new Map();
  rows.forEach((row, i) => {
    // Fall back to positional matching when the model drops or mangles an id.
    const id = (row && typeof row.id === 'string' && jobs.some((j) => j.id === row.id))
      ? row.id
      : jobs[i] && jobs[i].id;
    if (id) byId.set(id, normalizeResult(row || {}));
  });
  return byId;
}

/** Cheapest possible round-trip, used by the settings dialog. */
async function verifyApiKey(cfg) {
  const probe = [{
    id: 'probe',
    title: 'Logo design for Northwind Coffee',
    description: 'Hi, I am Dana Reyes, founder of Northwind Coffee. Email dana (at) northwindcoffee (dot) com.',
  }];
  const results = await analyzeJobs(probe, cfg);
  const row = results.get('probe');
  if (!row) throw new Error('Connected, but the model returned no result');
  return row;
}
