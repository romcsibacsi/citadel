// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * URL helpers shared across local-model wiring (FIX-local-model-agents) and
 * integrations. The subscription-billing carve-out (a dummy ANTHROPIC_AUTH_TOKEN +
 * ANTHROPIC_BASE_URL) may be injected ONLY for the operator's OWN private/local
 * endpoint — NEVER a public IP, and NEVER api.anthropic.com or any cloud provider.
 *
 * Two gates back this (FIX-hardening Part A):
 *  - `isPrivateBaseUrl` — the cheap SYNC structural gate: rejects literal public
 *    IPs (incl. encoded/numeric forms) + named cloud FQDNs. It trusts private-use
 *    *names* (`.local`, a bare LAN label, …) STRUCTURALLY but does NOT resolve them.
 *  - `assertPrivateResolvedHost` — the async authority: RESOLVES the host and
 *    refuses unless EVERY A/AAAA record is non-public (so a split-horizon / search-
 *    domain name pointing at a public IP can't slip through). The billing gate runs
 *    BOTH; the sync one alone is not sufficient to trust a name.
 */

import { isIP } from 'node:net';
import { isBlockedIp, defaultResolver, type DnsResolver } from '../tools/ssrf.js';

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url.trim());
}

// Explicit deny: these are PUBLIC/cloud and must never be treated as private even
// if the rest of the heuristic were fooled (defense in depth).
const CLOUD_DENY = /(^|\.)(anthropic\.com|openai\.com|googleapis\.com|amazonaws\.com|azure\.com|azurewebsites\.net)$/i;

/**
 * SYNC structural gate: true only when `raw` is an http(s) URL whose host is a
 * private/local endpoint by structure. Public IPs (incl. decimal/0x-hex/IPv4-mapped
 * encodings), cloud FQDNs, and anything non-http return false. A private-use NAME
 * (`.local`, a bare LAN label) returns true STRUCTURALLY — it is trusted for billing
 * only after `assertPrivateResolvedHost` additionally resolves it to non-public IPs.
 */
export function isPrivateBaseUrl(raw: string): boolean {
  if (!isHttpUrl(raw)) return false;
  let host: string;
  try {
    host = new URL(raw.trim()).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, ''); // strip IPv6 brackets + FQDN root dot
  if (host === '') return false;
  if (CLOUD_DENY.test(host)) return false;

  // loopback + private-use hostnames (NAME-trusted structurally; assertPrivateResolvedHost
  // additionally RESOLVES these before the billing carve-out trusts them).
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (/\.(local|lan|internal|intranet|home|home\.arpa)$/.test(host)) return true;
  // a bare single-label hostname (no dot, not an IPv6 literal) is a LAN host — BUT
  // only a real DNS-ish name, never a numeric/0x-hex blob (those are encoded IP
  // literals like 2130706433 = 127.0.0.1 or 0x08080808 = 8.8.8.8, which must not be
  // trusted by name; let the literal-IP / resolve gates classify them — FIX-hardening).
  if (!host.includes('.') && !host.includes(':')) {
    return /[a-z]/.test(host) && !/^0x[0-9a-f]+$/.test(host) && !/^\d+$/.test(host);
  }

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127) return true; // loopback 127/8
    if (a === 10) return true; // 10/8
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 169 && b === 254) return true; // link-local 169.254/16
    if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale CGNAT 100.64/10 (tunnel)
    return false; // any other IPv4 = public
  }

  // IPv6 ULA fc00::/7 + link-local fe80::/10
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

/**
 * Async authority behind the local-model billing carve-out (FIX-hardening Part A):
 * trust a base URL's host ONLY if it RESOLVES entirely to non-public addresses, so
 * a split-horizon / search-domain name that maps to a public IP can never be billed.
 * Reuses ssrf.ts's hardened classifier — NO IP parsing is re-implemented here.
 *
 * Contract (FAILSAFE — refuse on any doubt):
 *  - literal IP → ACCEPT iff internal (isBlockedIp), REFUSE if public (covers
 *    encoded/IPv4-mapped forms via ssrf.ts);
 *  - localhost / *.localhost / ::1 → accept without DNS;
 *  - otherwise resolve to ALL A/AAAA and ACCEPT only if EVERY address is non-public;
 *  - refuse on resolve error, zero records, or ANY public address.
 * Throws a descriptive Error (host + offending IP). Callers run this AFTER the sync
 * isPrivateBaseUrl gate, BEFORE injecting ANTHROPIC_BASE_URL/AUTH_TOKEN (SPEC §5).
 */
export async function assertPrivateResolvedHost(rawUrl: string, opts: { resolver?: DnsResolver } = {}): Promise<void> {
  let host: string;
  try {
    host = new URL(rawUrl.trim()).hostname.toLowerCase();
  } catch {
    throw new Error(`local-model base URL is not a valid URL: ${rawUrl}`);
  }
  host = host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (host === '') throw new Error('local-model base URL has no host (SPEC §5)');
  // localhost family never resolves to public space — accept without DNS.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return;
  // literal IP (incl. encoded/IPv4-mapped): accept iff internal, refuse if public.
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) return;
    throw new Error(`local-model base URL host ${host} is a PUBLIC IP — refusing (subscription-billing invariant, SPEC §5)`);
  }
  // a NAME: resolve to every A/AAAA and require all of them to be non-public.
  const resolver = opts.resolver ?? defaultResolver;
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new Error(`local-model base URL host ${host} could not be resolved — refusing (SPEC §5)`);
  }
  if (addrs.length === 0) throw new Error(`local-model base URL host ${host} did not resolve — refusing (SPEC §5)`);
  for (const ip of addrs) {
    if (!isBlockedIp(ip)) {
      throw new Error(`local-model base URL host ${host} resolves to a PUBLIC IP (${ip}) — refusing (subscription-billing invariant, SPEC §5)`);
    }
  }
}
