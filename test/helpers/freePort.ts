// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { createServer, type AddressInfo } from 'node:net';

/**
 * Allocate a free TCP port from the OS (#139): listen on 0, read the assigned
 * port, release it. Replaces the old fixed random-port bands
 * [BASE, BASE+RANGE) that overlapped host services — notably Plex on
 * 32400/32401/32600 — and leaked test servers, the root cause of the
 * 'listen EADDRINUSE 127.0.0.1:324xx' gate-flake that masked real regressions.
 *
 * The OS never allocates an in-use port, so the chosen port is collision-free at
 * allocation; the caller boots its server on it immediately afterwards.
 */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
