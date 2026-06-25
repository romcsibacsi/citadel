// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
// #386 FÁZIS-0 seam-inversion: the runtime ModulePack contract — the twin of the compile-time PolicyPack.
// A vertical (KKV accounting) implements this declarative contract; the CORE never imports a vertical.
// All imports here are core->core only (Router, AppContext, node:sqlite), so this file is vertical-free.
import type { DatabaseSync } from 'node:sqlite';
import type { Router } from '../../server/router.js';
import type { AppContext } from '../../app/context.js'; // core->core only
import type { Migration } from '../../db/database.js'; // core->core only

/** Pointer-only inbound wake-sender contract carrier (the load-bearing 'cs-inbound' class, #269/#270). */
export interface IngestHook {
  id: string;
  inboundSender: string;
}

/** The declarative contract a runtime vertical implements (twin of PolicyPack). */
export interface ModulePack {
  id: string;
  /**
   * Store-factory slot: build the vertical's stores against the shared db. The returned bag is spread into
   * ctx.moduleStores under the vertical's OWN keys (cs/bk/navStore/...). The core types it as
   * Record<string, unknown> and never names those keys.
   */
  makeStores(db: DatabaseSync): Record<string, unknown>;
  /** Route-registration slot: reuses the existing registerXxxRoutes(router, ctx) signature. */
  registerRoutes(router: Router, ctx: AppContext): void;
  /** Optional public/unauth paths this module contributes (e.g. '/api/cs/widget'). */
  publicPaths?: readonly string[];
  /** Optional inbound wake-sender contract carrier(s). */
  ingestHooks?: readonly IngestHook[];
  /**
   * Optional migration slot: the vertical's OWN DDL migrations (the bk_/cs_/nav_/portal_ tables). The core
   * keeps only core-schema migrations; main.ts applies [core, ...registry.migrations()] in id order, so an
   * existing DB no-ops (ids already applied) and a public-core-only DB (empty registry) never creates a
   * vertical table — default-deny by absence, exactly like the store/route slots.
   */
  migrations?: readonly Migration[];
}
