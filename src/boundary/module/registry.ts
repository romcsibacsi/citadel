// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #386 FÁZIS-0 seam-inversion: the runtime ModuleRegistry — the twin of PolicyRegistry.
// An EMPTY registry is default-deny-by-absence: makeStores()={}, registerRoutes()=no-op, publicPaths()=[],
// ingestSender()=undefined. The public core boots with an empty registry, so /api/cs, /api/bk, /api/portal,
// /api/cs/widget all 404 and the email connector never builds — exactly like an empty PolicyRegistry OPAQUEs
// every leaf. The private kkv-main registers the accounting ModulePack, which is byte-identical to the prior
// hard-wired construction.
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../../server/router.js';
import type { AppContext } from '../../app/context.js';
import type { Migration } from '../../db/database.js';
import type { ModulePack } from './types.js';

export class ModuleRegistry {
  private readonly packs = new Map<string, ModulePack>();

  register(pack: ModulePack): void {
    this.packs.set(pack.id, pack);
  }

  has(id: string): boolean {
    return this.packs.has(id);
  }

  /** Merge every pack's store bag; main.ts gets keyed stores WITHOUT importing classes. EMPTY => {}. */
  makeStores(db: DatabaseSync): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of this.packs.values()) Object.assign(out, p.makeStores(db));
    return out;
  }

  /** Invoke each pack's route-registrar AFTER core routes. EMPTY => no vertical routes mount. */
  registerRoutes(router: Router, ctx: AppContext): void {
    for (const p of this.packs.values()) p.registerRoutes(router, ctx);
  }

  /** Public/unauth paths contributed by every registered pack (merged into AUTH_POLICY.publicPaths). EMPTY => []. */
  publicPaths(): readonly string[] {
    return [...this.packs.values()].flatMap((p) => p.publicPaths ?? []);
  }

  /** The inbound wake-sender contract (the 'cs-inbound' class) from the first registered ingest hook. EMPTY => undefined. */
  ingestSender(): string | undefined {
    for (const p of this.packs.values()) for (const h of p.ingestHooks ?? []) return h.inboundSender;
    return undefined;
  }

  /**
   * Every registered pack's migrations, in registration order. main.ts applies these AFTER the core-schema
   * migrations (so ids stay globally ordered). EMPTY (public core) => [] => no vertical DDL ever runs.
   */
  migrations(): readonly Migration[] {
    return [...this.packs.values()].flatMap((p) => p.migrations ?? []);
  }
}
