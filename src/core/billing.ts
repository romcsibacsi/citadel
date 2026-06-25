// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Subscription-billing protection (SPEC §5, §20.11) — THE single predicate.
 * A stray credential silently flips even interactive sessions to metered
 * billing; presence alone is refused (an empty ANTHROPIC_API_KEY cannot bill,
 * but divergent empty-vs-present semantics between guards invite drift).
 */

/** Env vars that re-route or re-bill the Claude CLI away from the subscription. */
export const BILLING_ENV_DENYLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

/** Returns the offending variable names present in the given environment. */
export function billingEnvViolations(env: Record<string, string | undefined>): string[] {
  return BILLING_ENV_DENYLIST.filter((name) => Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined);
}

export function assertSubscriptionSafeEnv(env: Record<string, string | undefined>, context: string): void {
  const offending = billingEnvViolations(env);
  if (offending.length > 0) {
    throw new Error(
      `${offending.join(', ')} present in the environment (${context}). This system is subscription-billed ` +
        'only (SPEC §5): such variables silently switch agents to pay-as-you-go or external billing. ' +
        'Unset them and start again.',
    );
  }
}
