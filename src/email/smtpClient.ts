// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { BufferedReader, type RawSocket, type SocketFactory } from './socket.js';

/**
 * Minimal SMTP submission client (#118 phase-1). Submits to the mailcow SMTP
 * submission endpoint over implicit TLS (SMTPS 465); the external relay is the
 * mailcow smarthost, transparent to us — we only ever submit to our own mailcow.
 *
 * Sequence: greeting -> EHLO -> AUTH LOGIN -> MAIL FROM -> RCPT TO -> DATA -> QUIT.
 * The message body is dot-stuffed and CRLF-normalized before DATA. Like the IMAP
 * client it speaks only over a connected RawSocket; the SocketFactory owns TLS
 * (mandatory cert verification, no insecure fallback).
 */

export interface SmtpConfig {
  user: string;
  pass: string;
  /** EHLO identity; defaults to 'localhost' (mailcow accepts it on the submission port). */
  ehloName?: string;
}

export interface OutgoingEnvelope {
  from: string;
  to: string[];
  /** The full RFC822 message (headers + body). Composition/threading is phase-3. */
  data: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class SmtpClient {
  private socket: RawSocket | undefined;
  private reader: BufferedReader | undefined;

  constructor(
    private readonly connect: SocketFactory,
    private readonly config: SmtpConfig,
  ) {}

  /** Open the socket, read the greeting, EHLO, and authenticate. */
  async connectAndAuth(): Promise<void> {
    this.socket = await this.connect();
    this.reader = new BufferedReader(this.socket);
    await this.expect(220, await this.readReply());
    await this.ehlo();
    await this.authLogin();
  }

  /** Send one message. Each RCPT is checked; DATA carries the dot-stuffed body. */
  async send(env: OutgoingEnvelope): Promise<void> {
    if (env.to.length === 0) throw new SmtpError('no recipients');
    await this.cmd(`MAIL FROM:<${env.from}>`, 250);
    for (const rcpt of env.to) await this.cmd(`RCPT TO:<${rcpt}>`, 250);
    await this.cmd('DATA', 354);
    this.socket!.write(dotStuff(env.data) + '\r\n.\r\n');
    await this.expect(250, await this.readReply());
  }

  /** QUIT then close. Best-effort teardown. */
  async quit(): Promise<void> {
    try {
      if (this.reader !== undefined) {
        this.socket!.write('QUIT\r\n');
        await this.readReply();
      }
    } catch {
      /* tearing down regardless */
    } finally {
      this.socket?.end();
      this.socket = undefined;
      this.reader = undefined;
    }
  }

  // --- protocol plumbing ---

  private async ehlo(): Promise<void> {
    this.socket!.write(`EHLO ${this.config.ehloName ?? 'localhost'}\r\n`);
    const reply = await this.readReply();
    await this.expect(250, reply);
  }

  private async authLogin(): Promise<void> {
    this.socket!.write('AUTH LOGIN\r\n');
    await this.expect(334, await this.readReply());
    this.socket!.write(b64(this.config.user) + '\r\n');
    await this.expect(334, await this.readReply());
    this.socket!.write(b64(this.config.pass) + '\r\n');
    await this.expect(235, await this.readReply());
  }

  private async cmd(line: string, code: number): Promise<void> {
    this.socket!.write(line + '\r\n');
    await this.expect(code, await this.readReply());
  }

  private async expect(code: number, reply: { code: number; text: string }): Promise<void> {
    if (reply.code !== code) {
      throw new SmtpError(`expected ${code}, got ${reply.code}: ${reply.text}`, reply.code);
    }
  }

  /** Read a (possibly multiline) SMTP reply: `NNN-...` lines until a final `NNN ...`. */
  private async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.reader!.readLine();
      lines.push(line);
      // a continuation line has '-' at index 3; the final line has ' ' (or is short)
      if (line.length < 4 || line[3] === ' ') {
        const code = Number(line.slice(0, 3));
        return { code: Number.isInteger(code) ? code : -1, text: lines.join('\n') };
      }
    }
  }
}

/** SMTP dot-stuffing + CRLF normalization: a line starting with '.' gets an extra '.'. */
function dotStuff(data: string): string {
  const normalized = data.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  return normalized
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}
