// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';

export function registerStatusRoutes(router: Router, ctx: AppContext): void {
  // public probe: lets the SPA detect the product + that auth is required;
  // localeDefault is non-sensitive and lets the token-hint screen render in
  // the install-default language instead of a hardcoded fallback
  router.get('/api/auth/status', ({ res }) => {
    sendJson(res, 200, {
      product: ctx.config.branding.productName,
      authRequired: true,
      localeDefault: ctx.config.locale.default,
    });
  });

  router.get('/api/status', ({ res }) => {
    sendJson(res, 200, {
      productName: ctx.config.branding.productName,
      tagline: ctx.config.branding.tagline ?? '',
      version: ctx.version,
      localeDefault: ctx.config.locale.default,
      agentProseLocale: ctx.config.locale.agentProse,
      availableLocales: ctx.i18n.availableLocales(),
      timezone: ctx.config.timezone,
      hubId: ctx.config.hubId,
      adapter: ctx.config.runtime.adapter,
      authOk: true,
    });
  });
}
