'use strict';

// Pulls readable text out of job attachments. A brief attached as a PDF or
// Word file usually carries the letterhead the posting itself leaves out — the
// company name, a signature, sometimes a direct email.
//
// Runs in the content-script world so fetches carry the user's session, and
// leans on the platform's DecompressionStream instead of bundling a PDF or zip
// library. Extraction is best-effort by design: a garbled page is still worth
// scanning for an email, and anything unreadable degrades to just the filename.

(() => {
  const MAX_BYTES = 8 * 1024 * 1024;   // don't pull down huge design files
  const MAX_TEXT = 20000;              // per document, before the LLM's own cap

  async function inflate(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const latin1 = (bytes) => new TextDecoder('latin1').decode(bytes);

  function tidy(text) {
    const out = String(text || '')
      .replace(/\u0000/g, '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}\n…[truncated]…` : out;
  }

  // ─── PDF ────────────────────────────────────────────────────
  // Text lives in content streams as operands to the text-showing operators.
  // We decode every string literal we find: inside a content stream those are
  // essentially always text being drawn.

  function decodeHexString(hex) {
    const clean = hex.replace(/[^0-9a-f]/gi, '');
    // A BOM means UTF-16BE, which is what Word and friends emit for anything
    // outside Latin-1.
    if (/^feff/i.test(clean)) {
      let out = '';
      for (let i = 4; i + 3 < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.substr(i, 4), 16));
      return out;
    }
    let out = '';
    for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    return out;
  }

  function contentStreamText(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (ch === '(') {
        let depth = 1;
        let str = '';
        i++;
        for (; i < s.length && depth > 0; i++) {
          const c = s[i];
          if (c === '\\') {
            const n = s[++i];
            if (n === 'n') str += '\n';
            else if (n === 'r') str += '\r';
            else if (n === 't') str += '\t';
            else if (n >= '0' && n <= '7') {
              let oct = n;
              while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
              str += String.fromCharCode(parseInt(oct, 8));
            } else if (n !== '\n') str += n;
            continue;
          }
          if (c === '(') { depth++; str += c; continue; }
          if (c === ')') { if (--depth) str += c; continue; }
          str += c;
        }
        i--;
        out += str;
        continue;
      }

      if (ch === '<' && s[i + 1] !== '<') {
        const end = s.indexOf('>', i);
        if (end > i && end - i < 4096) {
          out += decodeHexString(s.slice(i + 1, end));
          i = end;
          continue;
        }
      }

      // Text-positioning operators are our only hint at line structure.
      if (ch === 'T' && (s[i + 1] === 'd' || s[i + 1] === 'D' || s[i + 1] === '*' || s[i + 1] === 'm')) {
        out += '\n';
        i++;
      }
    }
    return out;
  }

  async function pdfText(bytes) {
    const raw = latin1(bytes);
    const chunks = [];
    const re = /stream\r?\n/g;
    let m;

    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      if (end === -1) continue;

      // The stream's dictionary is whatever sits between "obj" and "stream".
      const objStart = raw.lastIndexOf('obj', m.index);
      const dict = objStart === -1 ? '' : raw.slice(objStart, m.index);
      // Images and font programs are bulk with no readable text in them.
      if (/\/(Image|DCTDecode|JPXDecode|FontFile\d?|XObject\s*\/Image)/.test(dict)) continue;

      // PDF writes an EOL between the data and "endstream". Including it makes
      // the inflater reject the whole stream as trailing junk, so prefer the
      // declared /Length and fall back to trimming the line break.
      let stop = end;
      const declared = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      if (declared) {
        stop = Math.min(start + Number(declared[1]), end);
      } else {
        while (stop > start && (raw[stop - 1] === '\n' || raw[stop - 1] === '\r')) stop--;
      }

      let data = bytes.subarray(start, stop);
      if (/\/FlateDecode/.test(dict)) {
        try {
          data = await inflate(data, 'deflate');
        } catch {
          try { data = await inflate(data, 'deflate-raw'); } catch { continue; }
        }
      } else if (/\/Filter/.test(dict)) {
        continue; // LZW / ASCII85 / JBIG2 — not worth hand-rolling
      }

      const text = contentStreamText(latin1(data));
      if (text.trim()) chunks.push(text);
      if (chunks.join('').length > MAX_TEXT * 2) break;
    }
    return chunks.join('\n');
  }

  // ─── DOCX / XLSX (zip containers) ───────────────────────────

  async function unzipEntry(bytes, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Find the end-of-central-directory record, scanning back over the comment.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return null;

    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);

    for (let n = 0; n < count; n++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return null;
      const method = view.getUint16(p + 10, true);
      const compressedSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const localOffset = view.getUint32(p + 42, true);
      const name = latin1(bytes.subarray(p + 46, p + 46 + nameLen));

      if (name === wanted) {
        // Local header repeats the name/extra lengths, and they can differ
        // from the central directory's — read them again to find the payload.
        if (view.getUint32(localOffset, true) !== 0x04034b50) return null;
        const lNameLen = view.getUint16(localOffset + 26, true);
        const lExtraLen = view.getUint16(localOffset + 28, true);
        const dataAt = localOffset + 30 + lNameLen + lExtraLen;
        const data = bytes.subarray(dataAt, dataAt + compressedSize);
        if (method === 0) return data;
        if (method === 8) return inflate(data, 'deflate-raw');
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function stripXml(xml) {
    return xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/(?:a:p|text:p)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, code) => {
        if (code[0] === '#') {
          const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
          return Number.isFinite(n) ? String.fromCharCode(n) : full;
        }
        return ENTITIES[code.toLowerCase()] ?? full;
      });
  }

  async function docxText(bytes) {
    const parts = [];
    // Body first, then the headers — letterheads live in the header parts, and
    // that's exactly where a company name tends to hide.
    for (const entry of ['word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml']) {
      const data = await unzipEntry(bytes, entry).catch(() => null);
      if (data) parts.push(stripXml(new TextDecoder('utf-8').decode(data)));
    }
    return parts.join('\n');
  }

  // ─── Dispatch ───────────────────────────────────────────────

  function sniff(bytes, name, mime) {
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const head = latin1(bytes.subarray(0, 4));
    if (head === '%PDF' || ext === 'pdf' || /pdf/.test(mime)) return 'pdf';
    // "PK" — a zip container. Only the XML-based Office formats are readable.
    if (head.startsWith('PK')) return ext === 'docx' || /wordprocessing/.test(mime) ? 'docx' : 'zip';
    if (/^(txt|md|csv|rtf|json|html?)$/.test(ext) || /^text\//.test(mime)) return 'text';
    return 'unknown';
  }

  /**
   * Fetch one attachment and return its readable text.
   * Resolves to '' rather than throwing when a format can't be read — the
   * filename alone is still evidence worth keeping.
   */
  async function extractAttachmentText(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const size = Number(res.headers.get('content-length') || 0);
    if (size > MAX_BYTES) throw new Error('file too large');

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error('file too large');

    const bytes = new Uint8Array(buf);
    const name = decodeURIComponent((url.split('/').pop() || '').split('?')[0]);
    const mime = (res.headers.get('content-type') || '').toLowerCase();

    switch (sniff(bytes, name, mime)) {
      case 'pdf': return tidy(await pdfText(bytes));
      case 'docx': return tidy(await docxText(bytes));
      case 'text': return tidy(new TextDecoder('utf-8').decode(bytes));
      default: return '';
    }
  }

  globalThis.extractAttachmentText = extractAttachmentText;
})();
