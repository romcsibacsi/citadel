// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';
import { readSharedAuthStatus } from '../../runtime/claude/adapter.js';

/**
 * First-run onboarding wizard backend (BUILD-onboarding-wizard). The wizard is mostly a
 * front-end that ORCHESTRATES existing endpoints (channel config, vault integrations,
 * the per-provider Test routes, ollama/comfy status). This route adds only what's
 * missing: a single cheap STATUS aggregator the wizard reads for live ✓/○/! per step,
 * and a completed/dismissed flag (app_settings) so the wizard auto-shows on first run
 * until the operator finishes or dismisses it.
 *
 * Only ONE step is REQUIRED: subscription auth (the host `claude login`). Everything
 * else is optional/skippable and the system works without it. Operator-gated; never
 * echoes a token (presence is derived from the vault ref resolving, not the value).
 */

const COMPLETED_KEY = 'onboarding:completed';
const DISMISSED_KEY = 'onboarding:dismissed';

export function registerOnboardingRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/onboarding/status', (c) => {
    requireOperator(c);
    const ch = ctx.config.channels;
    const refSet = (ref: string | undefined): boolean =>
      ref !== undefined && ref !== '' && ctx.vault.resolveRef(ref) !== undefined;
    const settingSet = (key: string): boolean => {
      const v = ctx.settings.get(key);
      return v !== undefined && v.trim() !== '';
    };
    const auth = readSharedAuthStatus();
    // The gate is "agents can think" — satisfied by EITHER path: the default shared
    // subscription (recommended) OR the operator-opt-in API mode with a key set. API
    // billing is never forbidden; subscription is just the better default. So an
    // API-mode operator is NOT locked out of the wizard.
    const billingMode = ctx.config.billing?.mode === 'api' ? 'api' : 'subscription';
    const apiKeySet = ctx.vault.getSecretValue('anthropic_api_key') !== undefined;
    const subOk = auth.present && !auth.expired;
    sendJson(c.res, 200, {
      completed: ctx.settings.get(COMPLETED_KEY) === 'true',
      dismissed: ctx.settings.get(DISMISSED_KEY) === 'true',
      steps: {
        // done when the chosen billing path has working credentials
        auth: { done: billingMode === 'api' ? apiKeySet : subOk, present: auth.present, expired: auth.expired, mode: billingMode, apiKeySet },
        telegram: { configured: ch.telegram?.enabled === true && refSet(ch.telegram?.tokenRef) },
        discord: { configured: ch.discord?.enabled === true && refSet(ch.discord?.botTokenRef) },
        ollama: { configured: settingSet('ollama_url') },
        comfy: { configured: settingSet('comfy_url') },
      },
    });
  });

  router.post('/api/onboarding/complete', (c) => {
    requireOperator(c);
    ctx.settings.set(COMPLETED_KEY, 'true');
    sendJson(c.res, 200, { completed: true });
  });

  router.post('/api/onboarding/dismiss', (c) => {
    requireOperator(c);
    ctx.settings.set(DISMISSED_KEY, 'true');
    sendJson(c.res, 200, { dismissed: true });
  });
}
