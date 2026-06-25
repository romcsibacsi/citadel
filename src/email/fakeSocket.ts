// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { RawSocket } from './socket.js';

/**
 * Test-support fake socket (#118 phase-1). Not imported by production code — it
 * lets the IMAP/SMTP unit tests drive the exact protocol path without a real
 * server. `onWrite` simulates a server: it fires synchronously on each client
 * write and the simulator feeds the reply back. Data fed before a subscriber is
 * queued (so a greeting can be staged before the client subscribes).
 */
export class FakeSocket implements RawSocket {
  readonly written: string[] = [];
  /** Server simulator: invoked on every client write with the raw command bytes. */
  onWrite?: (data: string) => void;
  ended = false;
  destroyed = false;

  private dataCbs: Array<(c: Buffer) => void> = [];
  private closeCbs: Array<() => void> = [];
  private errorCbs: Array<(e: Error) => void> = [];
  private queued: Buffer[] = [];

  write(data: string): void {
    this.written.push(data);
    this.onWrite?.(data);
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  onData(cb: (c: Buffer) => void): void {
    this.dataCbs.push(cb);
    const q = this.queued;
    this.queued = [];
    for (const b of q) cb(b);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  onError(cb: (e: Error) => void): void {
    this.errorCbs.push(cb);
  }

  // --- test drivers ---

  /** Feed bytes from the simulated server to the client. Queues if no subscriber yet. */
  feed(data: string | Buffer): void {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    if (this.dataCbs.length === 0) {
      this.queued.push(b);
      return;
    }
    for (const cb of this.dataCbs) cb(b);
  }

  /** Simulate the remote closing the connection. */
  closeRemote(): void {
    for (const cb of this.closeCbs) cb();
  }

  /** Simulate a socket error. */
  failRemote(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
}
