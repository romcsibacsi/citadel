// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { Router } from '../router.js';
import { HttpError, requireOperator, sendJson } from '../router.js';
import type { AppContext } from '../../app/context.js';

/**
 * Operator settings are config-file-backed, not DB rows (SPEC §18); saving
 * takes effect immediately where runtime-switchable (backend prose locale).
 */
export function registerSettingsRoutes(router: Router, ctx: AppContext): void {
  router.get('/api/settings', (c) => {
    requireOperator(c);
    sendJson(c.res, 200, {
      locale: ctx.config.locale,
      timezone: ctx.config.timezone,
      branding: ctx.config.branding,
      server: { host: ctx.config.server.host, port: ctx.config.server.port },
      availableLocales: ctx.i18n.availableLocales(),
    });
  });

  router.post('/api/settings', (c) => {
    requireOperator(c);
    const body = (c.body ?? {}) as {
      localeDefault?: string;
      agentProse?: string;
      timezone?: string;
      productName?: string;
    };
    const locales = ctx.i18n.availableLocales();
    if (body.localeDefault !== undefined && !locales.includes(body.localeDefault)) {
      throw new HttpError(400, `unknown locale: ${body.localeDefault}`);
    }
    if (body.agentProse !== undefined && !locales.includes(body.agentProse)) {
      throw new HttpError(400, `unknown locale: ${body.agentProse}`);
    }
    ctx.saveConfig((cfg) => {
      if (body.localeDefault !== undefined) cfg.locale.default = body.localeDefault;
      if (body.agentProse !== undefined) cfg.locale.agentProse = body.agentProse;
      if (body.timezone !== undefined && body.timezone !== '') cfg.timezone = body.timezone;
      if (body.productName !== undefined && body.productName !== '') cfg.branding.productName = body.productName;
    });
    if (body.localeDefault !== undefined) ctx.i18n.setLocale(body.localeDefault); // live switch, no restart
    sendJson(c.res, 200, { saved: true });
  });
}
