// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { BufferedReader, type RawSocket, type SocketFactory } from './socket.js';

/**
 * Minimal IMAP client (#118 phase-1) — the READ subset the customer-service
 * mailbox poller needs and nothing more:
 *   LOGIN, SELECT INBOX, UID SEARCH UNSEEN, UID FETCH <uid> BODY.PEEK[],
 *   UID STORE <uid> +FLAGS (\Seen), LOGOUT.
 *
 * BODY.PEEK[] is deliberate: it fetches the raw RFC822 message WITHOUT implicitly
 * setting \Seen, so the connector controls the seen-flag explicitly (only after a
 * message is durably ingested — phase-2). The body is returned as raw bytes; MIME
 * parsing belongs to ingestion, not the transport.
 *
 * This client speaks only over a connected RawSocket; it never opens TLS itself —
 * the SocketFactory does, with mandatory cert verification (see openTlsSocket).
 */

export interface ImapConfig {
  user: string;
  pass: string;
}

interface TaggedResponse {
  ok: boolean;
  status: string;
  text: string;
  untagged: string[];
  literals: Buffer[];
}

export class ImapError extends Error {}

export class ImapClient {
  private socket: RawSocket | undefined;
  private reader: BufferedReader | undefined;
  private tagSeq = 0;

  constructor(
    private readonly connect: SocketFactory,
    private readonly config: ImapConfig,
  ) {}

  /** Open the socket, read the server greeting, and LOGIN. */
  async login(): Promise<void> {
    this.socket = await this.connect();
    this.reader = new BufferedReader(this.socket);
    await this.readGreeting();
    // Quoted strings (RFC3501) — escape backslash and double-quote. Credentials
    // never contain CRLF, so quoting is sufficient and avoids a literal round-trip.
    await this.command(`LOGIN ${quote(this.config.user)} ${quote(this.config.pass)}`);
  }

  /** SELECT INBOX. Returns the advertised message count (EXISTS), best-effort. */
  async selectInbox(): Promise<number> {
    const res = await this.command('SELECT INBOX');
    for (const line of res.untagged) {
      const m = /^(\d+) EXISTS$/.exec(line);
      if (m) return Number(m[1]);
    }
    return 0;
  }

  /** UID SEARCH UNSEEN — the UIDs of messages not yet marked \Seen. */
  async searchUnseen(): Promise<number[]> {
    const res = await this.command('UID SEARCH UNSEEN');
    const uids: number[] = [];
    for (const line of res.untagged) {
      // `SEARCH 12 13 14` (or bare `SEARCH` when empty)
      const m = /^SEARCH\b(.*)$/.exec(line);
      if (m) {
        for (const tok of (m[1] ?? '').trim().split(/\s+/)) {
          if (tok === '') continue;
          const n = Number(tok);
          if (Number.isInteger(n) && n > 0) uids.push(n);
        }
      }
    }
    return uids;
  }

  /** UID FETCH <uid> BODY.PEEK[] — the raw RFC822 message bytes (no \Seen side effect). */
  async fetchBody(uid: number): Promise<Buffer> {
    if (!Number.isInteger(uid) || uid <= 0) throw new ImapError(`invalid uid ${uid}`);
    const res = await this.command(`UID FETCH ${uid} BODY.PEEK[]`);
    if (res.literals.length === 0) throw new ImapError(`FETCH ${uid} returned no body literal`);
    return res.literals[0]!;
  }

  /** UID STORE <uid> +FLAGS (\Seen) — mark a message seen AFTER it is ingested. */
  async markSeen(uid: number): Promise<void> {
    if (!Number.isInteger(uid) || uid <= 0) throw new ImapError(`invalid uid ${uid}`);
    await this.command(`UID STORE ${uid} +FLAGS (\\Seen)`);
  }

  /** LOGOUT then close the socket. Best-effort: a logout error still tears down. */
  async logout(): Promise<void> {
    try {
      if (this.reader !== undefined) await this.command('LOGOUT');
    } catch {
      /* tearing down regardless */
    } finally {
      this.socket?.end();
      this.socket = undefined;
      this.reader = undefined;
    }
  }

  // --- protocol plumbing ---

  private async readGreeting(): Promise<void> {
    const line = await this.reader!.readLine();
    // `* OK ...` or `* PREAUTH ...` is fine; `* BYE` means the server refused us.
    if (!/^\* (OK|PREAUTH)\b/.test(line)) {
      throw new ImapError(`unexpected IMAP greeting: ${line}`);
    }
  }

  private async command(cmd: string): Promise<TaggedResponse> {
    const tag = `a${++this.tagSeq}`;
    this.socket!.write(`${tag} ${cmd}\r\n`);
    const res = await this.readResponse(tag);
    if (!res.ok) throw new ImapError(`IMAP ${cmd.split(' ')[0]} failed: ${res.status} ${res.text}`);
    return res;
  }

  private async readResponse(tag: string): Promise<TaggedResponse> {
    const untagged: string[] = [];
    const literals: Buffer[] = [];
    for (;;) {
      const line = await this.readLogicalLine(literals);
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        const sp = rest.indexOf(' ');
        const status = (sp >= 0 ? rest.slice(0, sp) : rest).toUpperCase();
        return { ok: status === 'OK', status, text: rest, untagged, literals };
      }
      if (line.startsWith('* ')) {
        untagged.push(line.slice(2));
        continue;
      }
      // a `+ ` continuation or anything else: keep it, it is not our tagged result
      untagged.push(line);
    }
  }

  /**
   * Read one LOGICAL response line, inlining any `{n}` literals: the literal bytes
   * are captured into `literals` and the textual remainder is stitched back so the
   * caller sees a single line whose tagged/untagged prefix is detectable. Handles
   * multiple literals on one logical line.
   */
  private async readLogicalLine(literals: Buffer[]): Promise<string> {
    let text = await this.reader!.readLine();
    for (;;) {
      const m = /\{(\d+)\}$/.exec(text);
      if (!m) return text;
      const n = Number(m[1]);
      const lit = await this.reader!.readN(n);
      literals.push(lit);
      const cont = await this.reader!.readLine();
      text = text.slice(0, m.index) + cont;
    }
  }
}

/** RFC3501 quoted string: wrap in double quotes, escaping backslash and quote. */
function quote(value: string): string {
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}
