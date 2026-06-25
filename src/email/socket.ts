// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls';

/**
 * Email transport socket layer (#118 phase-1). The IMAP/SMTP clients are written
 * against this minimal duplex surface so the protocol logic runs deterministically
 * over a FakeSocket in tests AND over a real TLS socket in production — the exact
 * same code path, no live server needed for the unit tests.
 */
export interface RawSocket {
  write(data: string): void;
  end(): void;
  destroy(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

/** A function that opens a connected socket. Production uses TLS; tests inject a fake. */
export type SocketFactory = () => Promise<RawSocket>;

export interface TlsTarget {
  host: string;
  port: number;
}

/**
 * Open an implicit-TLS socket (IMAPS 993 / SMTPS 465) with MANDATORY certificate
 * verification. `rejectUnauthorized` is forced true and there is NO insecure /
 * skip-verify path — a deliberate hard rule for the email connector (#118). The
 * servername drives SNI + hostname verification; an unauthorized peer rejects.
 */
export function openTlsSocket(target: TlsTarget, timeoutMs = 30_000): Promise<RawSocket> {
  return new Promise<RawSocket>((resolve, reject) => {
    const opts: ConnectionOptions = {
      host: target.host,
      port: target.port,
      servername: target.host,
      rejectUnauthorized: true, // HARD: verification is non-negotiable, no insecure fallback
    };
    const onConnectError = (err: Error): void => reject(err);
    const sock: TLSSocket = tlsConnect(opts, () => {
      // rejectUnauthorized already fails the handshake on a bad cert; this is belt-and-suspenders.
      if (!sock.authorized) {
        const err = sock.authorizationError ?? new Error('TLS peer not authorized');
        sock.destroy();
        reject(err);
        return;
      }
      sock.removeListener('error', onConnectError);
      sock.setTimeout(0);
      resolve(wrapNodeSocket(sock));
    });
    sock.once('error', onConnectError);
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('TLS connect timeout')));
  });
}

function wrapNodeSocket(sock: TLSSocket): RawSocket {
  return {
    write: (data) => void sock.write(data),
    end: () => void sock.end(),
    destroy: () => void sock.destroy(),
    onData: (cb) => void sock.on('data', cb),
    onClose: (cb) => void sock.on('close', cb),
    onError: (cb) => void sock.on('error', cb),
  };
}

/**
 * Buffers bytes off a RawSocket and hands the protocol parsers CRLF lines and
 * exact-length literals (the IMAP `{n}` octet count). Reads resolve in arrival
 * order; a close or error mid-read rejects the pending read rather than hanging.
 */
export class BufferedReader {
  private buffer = Buffer.alloc(0);
  private closed = false;
  private failure: Error | undefined;
  private waiters: Array<() => void> = [];

  constructor(socket: RawSocket) {
    socket.onData((chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.onClose(() => {
      this.closed = true;
      this.wake();
    });
    socket.onError((err) => {
      this.failure = err;
      this.wake();
    });
  }

  private wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }

  private wait(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Read one CRLF-terminated line (without the trailing CRLF). */
  async readLine(): Promise<string> {
    for (;;) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx >= 0) {
        const line = this.buffer.subarray(0, idx).toString('utf8');
        this.buffer = this.buffer.subarray(idx + 2);
        return line;
      }
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error('connection closed mid-line');
      await this.wait();
    }
  }

  /** Read exactly `n` bytes (an IMAP literal payload). */
  async readN(n: number): Promise<Buffer> {
    for (;;) {
      if (this.buffer.length >= n) {
        const out = Buffer.from(this.buffer.subarray(0, n));
        this.buffer = this.buffer.subarray(n);
        return out;
      }
      if (this.failure) throw this.failure;
      if (this.closed) throw new Error('connection closed mid-literal');
      await this.wait();
    }
  }
}
