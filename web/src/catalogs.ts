// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h } from './dom.js';
import { t } from './i18n.js';
import { api } from './api.js';

/**
 * Shared model + security-profile catalogs (PROMPT-03 §9). The wizard and the
 * detail panel's Settings tab both build their dropdowns from these, so the
 * option text + grouping stay identical. Empty model groups (DeepSeek/Ollama on
 * a subscription-only host) are simply omitted.
 */

export interface ModelEntry {
  id: string;
  label: string;
}
export interface ModelsDto {
  claude: ModelEntry[];
  deepseek: ModelEntry[];
  ollama: ModelEntry[];
  aliases: Record<string, string>;
}
export interface ProfileEntry {
  id: string;
  label: string;
  strict: boolean;
  privilegeLevel: number;
  allow: number;
  ask: number;
  deny: number;
}

export function fetchModels(): Promise<ModelsDto> {
  return api.get<ModelsDto>('/api/models');
}
export function fetchProfiles(): Promise<ProfileEntry[]> {
  return api.get<{ profiles: ProfileEntry[] }>('/api/profiles').then((r) => r.profiles);
}

function group(labelKey: string, entries: ModelEntry[], current: string): HTMLElement | null {
  if (entries.length === 0) return null;
  return h(
    'optgroup',
    { label: t(labelKey) },
    ...entries.map((m) => h('option', { value: m.id, selected: m.id === current }, m.label)),
  );
}

/**
 * Build a grouped <select> of models. The first option is the inherited default
 * (value `inherit`); then a Claude group, and DeepSeek/Ollama groups only when
 * the catalog returned entries for them.
 */
export function buildModelSelect(models: ModelsDto, current: string | null): HTMLSelectElement {
  const value = current && current !== '' ? current : 'inherit';
  const sel = h(
    'select',
    { 'aria-label': t('agents.field.model') },
    h('option', { value: 'inherit', selected: value === 'inherit' }, t('agents.model.inherit')),
    group('agents.model.group.claude', models.claude, value),
    group('agents.model.group.deepseek', models.deepseek, value),
    group('agents.model.group.ollama', models.ollama, value),
  ) as HTMLSelectElement;
  return sel;
}

/** Build a <select> of security profiles; strict profiles get a localized suffix. */
export function buildProfileSelect(profiles: ProfileEntry[], current: string): HTMLSelectElement {
  return h(
    'select',
    { 'aria-label': t('agents.field.profile') },
    ...profiles.map((p) =>
      h('option', { value: p.id, selected: p.id === current }, `${p.label}${p.strict ? ` ${t('agents.profile.strictSuffix')}` : ''}`),
    ),
  ) as HTMLSelectElement;
}

/** Localized description for the selected profile (falls back to a counts line). */
export function profileDescription(profiles: ProfileEntry[], id: string): string {
  const p = profiles.find((x) => x.id === id);
  if (!p) return '';
  const desc = t(`agents.profile.desc.${id}`);
  if (desc !== `agents.profile.desc.${id}`) return desc;
  return t('agents.profile.counts', { allow: p.allow, ask: p.ask, deny: p.deny });
}
