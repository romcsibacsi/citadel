// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { ServerResponse } from 'node:http';

/**
 * Server-sent events helper (SPEC §17): fully async/non-blocking — pushes only
 * what producers hand it, never captures synchronously on an interval.
 */

export interface SseClient {
  send(event: string, data: unknown): void;
  comment(text: string): void;
  close(): void;
  readonly closed: boolean;
}

export function openSseStream(res: ServerResponse, opts?: { heartbeatMs?: number }): SseClient {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  let closed = false;
  const heartbeatMs = opts?.heartbeatMs ?? 25_000;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': keep-alive\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };
  res.on('close', cleanup);

  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (closed) return;
      res.write(`: ${text.replace(/\n/g, ' ')}\n\n`);
    },
    close() {
      cleanup();
      res.end();
    },
  };
}
