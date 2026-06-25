// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';

/**
 * Billing mode (FIX-billing-api-optin). The default is `subscription` (shared Max
 * OAuth, no API key). `api` is pay-as-you-go via the operator's vault
 * `anthropic_api_key`. THIS ROUTE (an explicit operator action) is the ONLY writer
 * of `config.billing.mode` — nothing else in the codebase may flip it (no quota/
 * limit handler, no error/retry path, no adapter). Switching to `api` requires a
 * key already in the vault. The change takes effect on the next agent (re)launch.
 */
export function registerBillingRoutes(router: Router, ctx: AppContext): void {
  const apiKeyId = 'anthropic_api_key';

  router.get('/api/billing', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, {
      mode: ctx.config.billing?.mode ?? 'subscription',
      hasApiKey: ctx.vault.getSecretValue(apiKeyId) !== undefined,
    });
  });

  router.put('/api/billing', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as { mode?: string };
    const mode = body.mode === 'api' ? 'api' : body.mode === 'subscription' ? 'subscription' : undefined;
    if (mode === undefined) throw new HttpError(400, ctx.i18n.t('billing.error.mode'));
    // never enable API billing without a key already present (else agents launch creds-less)
    if (mode === 'api' && ctx.vault.getSecretValue(apiKeyId) === undefined) {
      throw new HttpError(400, ctx.i18n.t('billing.error.noKey'));
    }
    ctx.saveConfig((cfg) => {
      cfg.billing = { mode };
    });
    sendJson(c.res, 200, { mode, restartRequired: true });
  });
}
