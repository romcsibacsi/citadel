// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { sanitizeId } from '../../trust/sanitize.js';
import { scanFolder, runImport, MigrationError, type Finding } from '../../migration/scan.js';

/**
 * Migration routes (PROMPT-17): scan a legacy assistant folder for migratable
 * content, then import it as chunked, tier-classified agent memories. Operator-
 * only — an agent identity must never inject memories into another agent.
 */
export function registerMigrationRoutes(router: Router, ctx: AppContext): void {
  router.post('/api/migration/scan', (c) => {
    requireOperator(c);
    const path = ((c.body ?? {}) as { path?: string }).path ?? '';
    try {
      sendJson(c.res, 200, scanFolder(path));
    } catch (err) {
      if (err instanceof MigrationError) {
        throw new HttpError(err.code === 'path_required' ? 400 : 404, ctx.i18n.t(err.code === 'path_required' ? 'migration.error.pathRequired' : 'migration.error.pathMissing'));
      }
      throw err;
    }
  });

  router.post('/api/migration/run', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { findings?: Finding[]; agent?: string };
    const findings = Array.isArray(body.findings) ? body.findings : [];
    const agent = body.agent && body.agent.trim() !== '' ? sanitizeId(body.agent) : sanitizeId(ctx.config.hubId);
    sendJson(c.res, 200, runImport(findings, agent, ctx.memory));
  });
}
