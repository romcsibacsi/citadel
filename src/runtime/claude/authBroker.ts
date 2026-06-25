// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir } from '../../core/fsx.js';
import { createLogger } from '../../core/log.js';
import { ensureSharedSubscriptionAuth, readSharedAuthStatus } from './adapter.js';

const log = createLogger('auth-broker');

/**
 * Central shared-subscription auth broker (FIX-agent-auth-broker).
 *
 * Background: every shared-subscription agent SYMLINKS the one host credential
 * (`~/.claude/.credentials.json`) so the fleet shares a single, refreshable OAuth
 * token (never a per-agent clone — cloning a refresh token is fatal because OAuth
 * refresh ROTATES it, invalidating every other copy). Two failure modes broke the
 * fleet in production:
 *   1. An in-pane `/login` (or a manual copy) atomic-renames a REAL file over an
 *      agent's symlink → that agent decouples into a standalone token that expires
 *      on its own → endless `/login`. The on-start repair only re-links at the NEXT
 *      restart, so a running decoupled agent stays broken.
 *   2. When the shared token nears expiry, the FIRST agent to need it self-refreshes,
 *      which decouples it AND rotates the shared refresh token out from under everyone
 *      else → a fleet-wide cascade to `/login`.
 *
 * The broker closes both:
 *   (1) SELF-HEAL SWEEP — periodically re-link every shared agent to the host token
 *       (reusing `ensureSharedSubscriptionAuth`), so a decoupled agent re-attaches
 *       WITHOUT waiting for a restart.
 *   (2) PROACTIVE REFRESH — before the host token expires, the broker (the SOLE,
 *       serialized refresher) performs the OAuth refresh_token grant and writes the
 *       rotated token back into the host file IN PLACE (atomic). Because the token is
 *       always fresh when an agent reads it, no agent ever self-refreshes → no
 *       decouple, no rotation cascade.
 *
 * Subscription-billing invariant: this uses the subscription OAuth refresh_token grant
 * only; it NEVER sets ANTHROPIC_API_KEY and never falls back to the metered API. The
 * client_id is a public OAuth client id (not a secret); the refresh_token (the secret)
 * lives only in the host credential file and is written back atomically on rotation.
 */

// Overridable so a change on Anthropic's side is a config tweak, not a code change.
// Endpoint VERIFIED live (2026-06-16, FIX-reauth-autoheal): a dummy-refresh_token probe returns
// HTTP 400 invalid_grant from `claude.ai/v1/oauth/token` (it validates the grant) but only a
// generic HTTP 429 from `console.anthropic.com/v1/oauth/token` (never engages the grant). The
// client_id matches the live `/login` OAuth URL (claude.com/cai/oauth/authorize?...client_id=9d1c…).
const OAUTH_TOKEN_URL = process.env.CLAUDE_OAUTH_TOKEN_URL ?? 'https://claude.ai/v1/oauth/token';
const OAUTH_CLIENT_ID = process.env.CLAUDE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh this far AHEAD of expiry, so an agent never reads a near-expired token. */
const REFRESH_LEAD_MS = 10 * 60 * 1000;

export interface AuthBrokerDeps {
  /** Config dirs of the shared-subscription agents (each holds the symlinked credential). */
  configDirs: () => string[];
  notifyOperator: (text: string) => void;
  homeDir?: string;
  /** Injectable for tests; defaults to global fetch (the real Anthropic token endpoint). */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [k: string]: unknown; // preserve scopes / subscriptionType / rateLimitTier untouched
}

function hostCredPath(homeDir: string): string {
  return join(homeDir, '.claude', '.credentials.json');
}

function readHostCreds(homeDir: string): OAuthCreds | null {
  const p = hostCredPath(homeDir);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as { claudeAiOauth?: OAuthCreds };
    const o = data.claudeAiOauth;
    if (o === undefined || typeof o.refreshToken !== 'string' || o.refreshToken === '') return null;
    return o;
  } catch {
    return null;
  }
}

export interface AuthBroker {
  /** One tick: self-heal symlinks, then proactively refresh the host token if near expiry. */
  tick: () => Promise<void>;
  /** Force a refresh now (used by the manual operator refresh path); returns the outcome. */
  refreshNow: () => Promise<{ ok: boolean; reason: string }>;
}

export function createAuthBroker(deps: AuthBrokerDeps): AuthBroker {
  const now = (): number => (deps.now ?? Date.now)();
  let refreshing = false; // single-flight: two concurrent refreshes would double-rotate the token
  let notifiedExpiry = false; // de-dupe the operator escalation until it recovers

  async function refreshHostToken(homeDir: string): Promise<{ ok: boolean; reason: string; skipped?: boolean }> {
    if (refreshing) return { ok: false, reason: 'refresh already in flight', skipped: true };
    const cur = readHostCreds(homeDir);
    if (cur === null) return { ok: false, reason: 'no host refresh token (keychain/not-logged-in?)' };
    refreshing = true;
    try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: cur.refreshToken, client_id: OAUTH_CLIENT_ID }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return { ok: false, reason: `token endpoint HTTP ${res.status}` };
      const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
        return { ok: false, reason: 'malformed token response' };
      }
      const next: OAuthCreds = {
        ...cur, // keep scopes / subscriptionType / rateLimitTier
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : cur.refreshToken,
        expiresAt: now() + body.expires_in * 1000,
      };
      // atomic in-place write: agents symlink THIS path, so a temp+rename updates the token
      // they all see without breaking a single symlink.
      ensureDir(join(homeDir, '.claude'), 0o700);
      atomicWriteFile(hostCredPath(homeDir), JSON.stringify({ claudeAiOauth: next }, null, 2), 0o600);
      return { ok: true, reason: 'refreshed' };
    } catch (err) {
      return { ok: false, reason: String(err) };
    } finally {
      refreshing = false;
    }
  }

  async function tick(): Promise<void> {
    const homeDir = deps.homeDir ?? process.env.HOME;
    if (homeDir === undefined || homeDir === '') return;

    // (1) self-heal: re-link every decoupled agent to the shared host token (no restart).
    for (const dir of deps.configDirs()) {
      try {
        ensureSharedSubscriptionAuth(dir, homeDir);
      } catch (err) {
        log.warn('shared-auth sweep relink failed', { dir, error: String(err) });
      }
    }

    // (2) proactive refresh — keep the host token ahead of expiry so no agent self-refreshes.
    const status = readSharedAuthStatus(homeDir);
    if (!status.present || status.expiresAt === null) return; // keychain auth / nothing to refresh
    if (status.expiresAt - now() > REFRESH_LEAD_MS) {
      notifiedExpiry = false; // comfortably valid
      return;
    }
    const r = await refreshHostToken(homeDir);
    if (r.ok) {
      notifiedExpiry = false;
      log.info('shared subscription token auto-refreshed by broker', {});
      return;
    }
    if (r.skipped === true) return; // another refresh is already in flight — don't double-notify
    // (3) refresh failed near expiry → escalate ONCE. The self-heal means that once the
    // operator re-auths on the host, the whole fleet recovers automatically (no per-agent action).
    if (!notifiedExpiry) {
      notifiedExpiry = true;
      deps.notifyOperator(
        `Shared subscription token is near/expired and auto-refresh failed (${r.reason}). Re-auth ONCE on the host (\`claude\` login) — every shared agent then self-heals.`,
      );
    }
  }

  return { tick, refreshNow: async () => refreshHostToken(deps.homeDir ?? process.env.HOME ?? '') };
}
