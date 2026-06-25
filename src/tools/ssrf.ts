// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for outbound agent-tool fetches (FIX-plugin-agent-tools §1 security).
 *
 * An agent's `browse` tool fetches an operator-allowed URL. Before any network is
 * touched we MUST refuse a target that resolves to a non-public address — that is
 * the SSRF surface (an attacker who can influence the URL pivoting to localhost,
 * the LAN, or the cloud-metadata endpoint). The guard:
 *   - parses + scheme-checks the URL (http/https only — no file:, gopher:, etc.);
 *   - rejects a literal credentialed/odd host;
 *   - resolves the hostname to its A/AAAA records and rejects ANY that fall in a
 *     loopback / link-local / private-LAN / unique-local / cloud-metadata range
 *     (so a DNS name that points at 127.0.0.1 or 169.254.169.254 is caught too);
 *   - is overridable ONLY by an explicit operator allowlist of exact hostnames
 *     (e.g. an internal box the operator deliberately exposes).
 *
 * Pure + injectable DNS so it is unit-testable offline.
 */

export class SsrfError extends Error {}

export type DnsResolver = (hostname: string) => Promise<string[]>;

/** Default resolver: A + AAAA records (the addresses a fetch would actually use). */
export const defaultResolver: DnsResolver = async (hostname) => {
  const recs = await lookup(hostname, { all: true });
  return recs.map((r) => r.address);
};

/** Parse a dotted IPv4 into its four octets, or null if not a plain IPv4 literal. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number];
  if (o.some((n) => n > 255)) return null;
  return o;
}

/**
 * Is this resolved IP literal in a blocked (non-public) range? Covers, for both
 * v4 and v4-mapped/embedded v6 forms: loopback (127/8, ::1), any-address (0.0.0.0,
 * ::), link-local (169.254/16 incl. cloud metadata 169.254.169.254, fe80::/10),
 * private-LAN (10/8, 172.16-31/12, 192.168/16), CGNAT (100.64/10), and IPv6
 * unique-local (fc00::/7).
 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return true; // not a parseable IP → fail closed

  // IPv6 — fully EXPAND to 8 groups (handles ::, hex-mapped ::ffff:7f00:1, dotted
  // ::ffff:127.0.0.1, 0::1, etc.), then check loopback / v4-mapped / link-local /
  // unique-local. (A regex on the textual form missed the hex-mapped v4 — CVE-class
  // SSRF bypass; expanding is the only robust way.)
  if (v === 6) {
    const g = expandV6(ip);
    if (g === null) return true; // unparseable v6 → fail closed
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
    // v4-mapped (::ffff:a.b.c.d) AND v4-compatible (::a.b.c.d): the last 32 bits are an embedded v4
    const v4embedded = g[5] === 0xffff || g.slice(0, 6).every((x) => x === 0);
    if (v4embedded) {
      const a = (g[6]! >> 8) & 0xff, b = g[6]! & 0xff, c = (g[7]! >> 8) & 0xff, d = g[7]! & 0xff;
      return isBlockedIp(`${a}.${b}.${c}.${d}`);
    }
    // 6to4 (2002:WWXX:YYZZ::/48) tunnels an embedded IPv4 (W.X.Y.Z) — evaluate by it, so a
    // 6to4 wrapping a private/metadata v4 is blocked (DiD); a public-embedded 6to4 is
    // effectively public and passes.
    if (g[0] === 0x2002) {
      const a = (g[1]! >> 8) & 0xff, b = g[1]! & 0xff, c = (g[2]! >> 8) & 0xff, d = g[2]! & 0xff;
      return isBlockedIp(`${a}.${b}.${c}.${d}`);
    }
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    return false;
  }

  const o = ipv4Octets(ip);
  if (o === null) return true;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return false;
}

/**
 * Is `ip` a cloud-metadata / link-local address? Covers the 169.254.0.0/16 range (incl. the
 * canonical 169.254.169.254 instance-metadata endpoint and its v4-mapped IPv6 spellings),
 * IPv6 link-local fe80::/10, and the AWS IPv6 metadata fd00:ec2::254. These are HARD-DENIED
 * BEFORE the operator allowlist bypass (#166 DiD): no legitimate aggregator runs on the
 * metadata range, so the allowlist must never be a path to the instance-metadata SSRF
 * target — not via a misconfigured literal IP, nor a name that rebinds to it. Every OTHER
 * private range stays allow-listable (a real internal aggregator may live at 10.x/192.168.x).
 */
export function isCloudMetadataIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 0) return false;
  if (v === 6) {
    const g = expandV6(ip);
    if (g === null) return false;
    const v4embedded = g[5] === 0xffff || g.slice(0, 6).every((x) => x === 0);
    if (v4embedded) return isCloudMetadataIp(`${(g[6]! >> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >> 8) & 0xff}.${g[7]! & 0xff}`);
    if (g[0] === 0x2002) return isCloudMetadataIp(`${(g[1]! >> 8) & 0xff}.${g[1]! & 0xff}.${(g[2]! >> 8) & 0xff}.${g[2]! & 0xff}`); // 6to4 embedded v4
    if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if (g[0] === 0xfd00 && g[1] === 0x0ec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x0254) return true; // AWS IPv6 metadata fd00:ec2::254
    return false;
  }
  const o = ipv4Octets(ip);
  return o !== null && o[0] === 169 && o[1] === 254; // 169.254.0.0/16 (cloud-metadata range)
}

/** Expand an IPv6 literal (already validated by isIP) to its 8 numeric groups, folding
 *  a trailing embedded IPv4 (`::ffff:1.2.3.4`) into two hex groups. Null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = (ip.split('%')[0] ?? '').toLowerCase();
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (dotted !== null) {
    const o = ipv4Octets(dotted[2]!);
    if (o === null) return null;
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] !== '' && halves[0] !== undefined ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<string>(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (g === '' ? 0 : parseInt(g, 16)));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

export interface SsrfCheckOptions {
  /** Exact hostnames the operator has deliberately allow-listed (bypass the IP block). */
  allowHosts?: string[];
  resolver?: DnsResolver;
}

/**
 * Validate an outbound URL: throws {@link SsrfError} unless it is an http(s) URL
 * whose host resolves entirely to public addresses (or is on the operator
 * allowlist). Returns the parsed URL on success.
 */
export async function assertPublicUrl(rawUrl: string, opts: SsrfCheckOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`unsupported scheme '${url.protocol}' — only http/https are allowed`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('credentials in the URL are not allowed');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') throw new SsrfError('missing host');

  const allow = new Set((opts.allowHosts ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h !== ''));
  const allowed = allow.has(host);
  const resolver = opts.resolver ?? defaultResolver;

  // (#166 DiD) HARD-DENY the cloud-metadata endpoint BEFORE the allowlist bypass. A real
  // aggregator never lives on the link-local metadata range, so the allowlist must not be a
  // path to it: neither an operator misconfig (the metadata IP as its own allowlist entry,
  // since allowHostsForUrl derives the allowlist FROM the url) nor an allowlisted NAME that
  // rebinds to metadata via poisoned internal DNS. This metadata recheck is the ONLY check
  // the allowlist path performs; every other private IP stays allow-listable.
  if (isIP(host) !== 0) {
    if (isCloudMetadataIp(host)) throw new SsrfError(`blocked: ${host} is a cloud-metadata address`);
  } else if (allowed) {
    try {
      for (const ip of await resolver(host)) {
        if (isCloudMetadataIp(ip)) throw new SsrfError(`blocked: ${host} resolves to a cloud-metadata address (${ip})`);
      }
    } catch (err) {
      if (err instanceof SsrfError) throw err; // surface our metadata deny; ignore resolve errors (allowlist trust)
    }
  }

  if (allowed) return url; // operator-allowlisted host bypasses the IP block (metadata denied above)

  // A bare IP literal target — block directly (no DNS needed).
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new SsrfError(`blocked address: ${host} is not a public IP`);
    return url;
  }

  // Obvious local names never resolve to public space — refuse before any DNS.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfError(`blocked host: ${host}`);
  }

  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new SsrfError(`could not resolve host: ${host}`);
  }
  if (addrs.length === 0) throw new SsrfError(`host did not resolve: ${host}`);
  for (const ip of addrs) {
    if (isBlockedIp(ip)) throw new SsrfError(`blocked address: ${host} resolves to a non-public IP (${ip})`);
  }
  return url;
}

/** Parse the operator `browse_allowlist` setting (newline/comma-separated hostnames). */
export function parseAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}
