// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Upstream provider status (PROMPT-14 §6a). Fetches the provider's public
 * Statuspage v2 summary (components + incidents), derives a verdict, and
 * degrades honestly when the feed is unreachable (overall 'unknown', empty
 * components → the UI shows the "no per-service data" note rather than faking
 * green). No secrets; nothing persisted.
 */

export interface ProviderComponent { name: string; status: string }
export interface ProviderIncident { title: string; description: string; pubDate: string; link: string; status: string }
export interface ProviderStatus {
  overall: 'operational' | 'degraded' | 'unknown';
  components: ProviderComponent[];
  incidents: ProviderIncident[];
  fetchedAt: string;
}

const DEFAULT_FEED = 'https://status.anthropic.com/api/v2/summary.json';

/** Infer an incident's state from its text (resolved/monitoring/identified, else investigating). */
function inferIncidentState(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('resolved')) return 'resolved';
  if (t.includes('monitoring')) return 'monitoring';
  if (t.includes('identified')) return 'identified';
  return 'investigating';
}

interface SummaryShape {
  components?: Array<{ name?: string; status?: string }>;
  incidents?: Array<{ name?: string; status?: string; created_at?: string; shortlink?: string; incident_updates?: Array<{ body?: string }> }>;
}

export async function fetchProviderStatus(feedUrl = DEFAULT_FEED, timeoutMs = 4000, now: () => Date = () => new Date()): Promise<ProviderStatus> {
  const fetchedAt = now().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feedUrl, { signal: controller.signal });
    if (!res.ok) return { overall: 'unknown', components: [], incidents: [], fetchedAt };
    const data = (await res.json()) as SummaryShape;
    const components: ProviderComponent[] = (data.components ?? [])
      .filter((c) => typeof c.name === 'string')
      .map((c) => ({ name: c.name!, status: c.status ?? 'operational' }));
    const incidents: ProviderIncident[] = (data.incidents ?? []).slice(0, 15).map((i) => {
      const body = i.incident_updates?.[0]?.body ?? '';
      return {
        title: i.name ?? '',
        description: body,
        pubDate: i.created_at ?? fetchedAt,
        link: i.shortlink ?? '',
        status: i.status ?? inferIncidentState(body),
      };
    });
    const anyOpen = incidents.some((i) => i.status !== 'resolved') || components.some((c) => c.status !== 'operational');
    const overall: ProviderStatus['overall'] = components.length === 0 && incidents.length === 0 ? 'unknown' : anyOpen ? 'degraded' : 'operational';
    return { overall, components, incidents, fetchedAt };
  } catch {
    return { overall: 'unknown', components: [], incidents: [], fetchedAt };
  } finally {
    clearTimeout(timer);
  }
}
