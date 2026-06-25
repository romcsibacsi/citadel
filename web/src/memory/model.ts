// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { t } from '../i18n.js';

/** Shared Memory DTOs + tier helpers (PROMPT-08). Spec "tier" = the store's "category". */

export type Tier = 'hot' | 'warm' | 'cold' | 'shared';
export const TIERS: Tier[] = ['hot', 'warm', 'cold', 'shared'];
export const TIER_EMOJI: Record<Tier, string> = { hot: '🔥', warm: '🌡️', cold: '❄️', shared: '🔗' };

export interface Memory {
  id: number;
  agentId: string;
  category: Tier;
  sector: string;
  content: string;
  keywords: string;
  salience: number;
  createdAt: string;
  accessedAt: string | null;
  archivedAt: string | null;
}
export interface MemoryStats {
  total: number;
  byCategory: Record<Tier, number>;
  bySector: { semantic: number; episodic: number };
  avgSalience: number;
  archived: number;
  /** True only when a vector/embedding provider is actually wired (drives Hybrid honesty). */
  embeddingEnabled?: boolean;
  /** Count of memories that carry an embedding (vector coverage). */
  embedded?: number;
}
export interface RosterAgent { id: string; displayName: string; accentColor: string }

/** Deterministic tier heuristic for bulk import when no local model is available. */
export function classifyTier(text: string): Tier {
  const s = text.toLowerCase();
  if (/\b(urgent|asap|now|today|critical|blocker|immediately|sürgős|azonnal|most|ma)\b/.test(s)) return 'hot';
  if (/\b(lesson|learned|archive|deprecated|obsolete|history|retrospective|tanulság|archív|elavult)\b/.test(s)) return 'cold';
  if (/\b(everyone|team|shared|convention|policy|standard|guideline|mindenki|csapat|megosztott|konvenció|szabály)\b/.test(s)) return 'shared';
  return 'warm';
}

/**
 * Split pasted text into sensible chunks, preferring structure over raw newlines:
 * markdown headings first, else blank-line paragraphs, else (the "one memory per
 * line" case the import placeholder instructs) single newlines. So both a pasted
 * document AND a one-per-line list classify per chunk, never collapsing to one.
 */
export function splitImportChunks(raw: string): string[] {
  const text = raw.trim();
  if (text === '') return [];
  const parts = /^#{1,6}\s/m.test(text)
    ? text.split(/\n(?=#{1,6}\s)/)
    : /\n\s*\n/.test(text)
      ? text.split(/\n\s*\n/)
      : text.split(/\n+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 2);
}

export function tierLabel(tier: Tier): string {
  return `${TIER_EMOJI[tier]} ${t(`memory.tier.${tier}`)}`;
}

/** Budapest-localized date+time, regardless of UI language (per spec §10). */
export function fmtMemDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('hu-HU', { timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function splitKeywords(kw: string | string[] | undefined): string[] {
  if (Array.isArray(kw)) return kw.map((k) => k.trim()).filter(Boolean);
  return (kw ?? '').split(',').map((k) => k.trim()).filter(Boolean);
}
