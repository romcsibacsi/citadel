// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Minimal RFC822/MIME parser (#118 phase-2) — pragmatic, never throws. It extracts
 * exactly what ingestion needs: the sender address, a decoded subject, the
 * threading headers (Message-ID / In-Reply-To / References), and a usable text
 * body. Attachments are deliberately NOT handled (deferred to v2). All extracted
 * fields are UNTRUSTED content; the trust-frame (wrap + tag-strip) is applied at
 * the agent boundary, not here.
 */

export interface ParsedEmail {
  fromHeader: string;
  /** addr-spec extracted from From, lowercased. '' when unparseable. */
  fromAddress: string;
  /** Display name from From, best-effort. '' when absent. */
  fromName: string;
  subject: string;
  messageId: string;
  inReplyTo: string[];
  references: string[];
  date: string;
  /** Decoded text body (text/plain preferred; HTML stripped as a fallback). */
  text: string;
}

/** Split a raw message into the header block and the body at the first blank line. */
function splitHeadersBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Parse a header block into a lowercased-key multimap, unfolding continuations. */
function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = head.split(/\r?\n/);
  const logical: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && logical.length > 0) {
      logical[logical.length - 1] += ' ' + line.trim();
    } else {
      logical.push(line);
    }
  }
  for (const line of logical) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const arr = out.get(key);
    if (arr) arr.push(value);
    else out.set(key, [value]);
  }
  return out;
}

function firstHeader(headers: Map<string, string[]>, key: string): string {
  return headers.get(key)?.[0] ?? '';
}

/** Extract every `<message-id>` token from a header value. */
function messageIds(value: string): string[] {
  const out: string[] = [];
  const re = /<[^<>\s]+>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[0]);
  return out;
}

/** Parse a From-style header into { name, address } (address lowercased). */
function parseAddress(value: string): { name: string; address: string } {
  const angled = /<([^<>]+)>/.exec(value);
  if (angled) {
    const name = value.slice(0, angled.index).trim().replace(/^"|"$/g, '').trim();
    return { name, address: angled[1]!.trim().toLowerCase() };
  }
  const bare = /[^\s<>@]+@[^\s<>@]+/.exec(value);
  return { name: '', address: bare ? bare[0].toLowerCase() : '' };
}

/** Decode RFC2047 encoded-words (`=?charset?B|Q?text?=`) in a header value. */
export function decodeHeaderWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_full, _charset, enc, text: string) => {
    try {
      if (enc.toLowerCase() === 'b') {
        return Buffer.from(text, 'base64').toString('utf8');
      }
      // Q-encoding: '_' is space, =XX is a byte
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '_') bytes.push(0x20);
        else if (c === '=' && i + 2 < text.length) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(c.charCodeAt(0));
      }
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return text;
    }
  });
}

function paramOf(headerValue: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*([^;\\s]+)`, 'i');
  const m = re.exec(headerValue);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/** Decode a body part by its Content-Transfer-Encoding (utf-8 assumed). */
function decodeBody(body: string, cte: string): string {
  const enc = cte.trim().toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    // Collect BYTES (=XX) then decode as UTF-8 — a per-char fromCharCode would split a
    // multi-byte sequence (e.g. =C3=A1 -> 'á') into two Latin-1 chars and corrupt it.
    const unfolded = body.replace(/=\r?\n/g, ''); // soft line breaks
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      const c = unfolded[i]!;
      if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return body; // 7bit / 8bit / binary / none
}

/** Crude HTML -> text fallback used only when no text/plain part exists. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Extract a usable text body. Walks one or more multipart levels, preferring a
 * text/plain part; falls back to a tag-stripped text/html part; otherwise decodes
 * the body by the top-level transfer encoding.
 */
function extractText(contentType: string, cte: string, body: string): string {
  const ct = contentType.toLowerCase();
  if (ct.startsWith('multipart/')) {
    const boundary = paramOf(contentType, 'boundary');
    if (boundary === undefined) return decodeBody(body, cte);
    const parts = splitMultipart(body, boundary);
    let htmlFallback = '';
    for (const part of parts) {
      const { head, body: pbody } = splitHeadersBody(part);
      const ph = parseHeaders(head);
      const pct = firstHeader(ph, 'content-type') || 'text/plain';
      const pcte = firstHeader(ph, 'content-transfer-encoding');
      if (pct.toLowerCase().startsWith('multipart/')) {
        const nested = extractText(pct, pcte, pbody);
        if (nested.trim() !== '') return nested;
      } else if (pct.toLowerCase().startsWith('text/plain')) {
        return decodeBody(pbody, pcte).trim();
      } else if (pct.toLowerCase().startsWith('text/html') && htmlFallback === '') {
        htmlFallback = htmlToText(decodeBody(pbody, pcte));
      }
    }
    return htmlFallback;
  }
  const decoded = decodeBody(body, cte);
  return ct.startsWith('text/html') ? htmlToText(decoded) : decoded.trim();
}

/** Split a multipart body on its boundary delimiters, dropping the preamble/epilogue. */
function splitMultipart(body: string, boundary: string): string[] {
  const segments = body.split(`--${boundary}`);
  const parts: string[] = [];
  // segments[0] is the preamble (before the first delimiter) — always dropped.
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('--')) break; // the closing `--boundary--`; the epilogue follows
    parts.push(seg.replace(/^\r?\n/, '')); // strip the CRLF that follows the delimiter
  }
  return parts;
}

/** Parse a raw RFC822 message. Best-effort and total — never throws. */
export function parseEmail(raw: Buffer | string): ParsedEmail {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const { head, body } = splitHeadersBody(text);
  const headers = parseHeaders(head);
  const from = parseAddress(decodeHeaderWords(firstHeader(headers, 'from')));
  const contentType = firstHeader(headers, 'content-type') || 'text/plain';
  const cte = firstHeader(headers, 'content-transfer-encoding');
  return {
    fromHeader: firstHeader(headers, 'from'),
    fromAddress: from.address,
    fromName: from.name,
    subject: decodeHeaderWords(firstHeader(headers, 'subject')),
    messageId: messageIds(firstHeader(headers, 'message-id'))[0] ?? '',
    inReplyTo: messageIds(firstHeader(headers, 'in-reply-to')),
    references: messageIds(firstHeader(headers, 'references')),
    date: firstHeader(headers, 'date'),
    text: extractText(contentType, cte, body),
  };
}
