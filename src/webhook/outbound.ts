// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { CoreTool, CoreToolContext } from '../tools/registry.js';
import { postToTarget } from './events.js';
import { readTargets } from './config.js';
import { SsrfError } from '../tools/ssrf.js';

/**
 * The `webhook_post` agent tool (FIX-plugin-webhook, outbound side).
 *
 * An agent can POST a JSON payload to a CONFIGURED, NAMED outbound target — never
 * an arbitrary URL. The tool resolves the target name against operator config and
 * routes through {@link postToTarget}, which applies the SSRF guard (allowlist +
 * reject localhost/link-local/private/metadata), a per-request timeout, and pulls
 * any auth-header secret from the vault (never logged).
 *
 * It is a CORE tool (not a plugin-host tool) because it needs settings + vault,
 * which the host's `{ agentId }`-only context deliberately withholds. It declares
 * a `WebFetch` capability so the SAME privilege gate the route applies to every
 * core/plugin tool decides whether the requesting agent may use it at all.
 */
export function makeWebhookPostTool(): CoreTool {
  return {
    name: 'webhook_post',
    schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'The NAME of a configured outbound webhook target.' },
        payload: { type: 'object', description: 'A JSON object to POST to the target.' },
      },
      required: ['target'],
    },
    requiredPermission: { tool: 'WebFetch' },
    run: async (args: Record<string, unknown>, ctx: CoreToolContext) => {
      const target = typeof args.target === 'string' ? args.target.trim() : '';
      if (target === '') throw new Error('webhook_post requires a target name');
      // honest, named-only surface: an unknown target is an error, not a silent no-op
      const known = readTargets(ctx.settings).some((t) => t.name === target);
      if (!known) {
        const names = readTargets(ctx.settings).map((t) => t.name);
        throw new Error(`unknown webhook target '${target}' (configured: ${names.join(', ') || 'none'})`);
      }
      const payload = typeof args.payload === 'object' && args.payload !== null ? args.payload : {};
      try {
        const r = await postToTarget(target, { from: ctx.agentId, payload }, { settings: ctx.settings, vault: ctx.vault, fetchImpl: ctx.fetchImpl });
        return { target, status: r.status, ok: r.ok };
      } catch (err) {
        if (err instanceof SsrfError) throw new Error(`webhook target '${target}' refused by the SSRF guard: ${err.message}`);
        throw err;
      }
    },
  };
}
