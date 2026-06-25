// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Autonomy (Autonómia) view (PROMPT-15): the operator's per-category trust dial.
 * A legend, a refreshable grid of single-click 1/2/3 level selectors, and a
 * last-modified footer. No modals, no polling. Hard-locked rows are dimmed +
 * non-interactive; capped rows fade segments above the cap. The server enforces
 * the lock + cap regardless of the UI — this is just the policy surface.
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t, currentLocale } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

interface Category { key: string; label: string; level: number; locked: boolean; maxLevel: number }
interface Config { version: number; updatedAt: number; doc: string; categories: Category[] }

function catLabel(key: string, fallback: string): string {
  const k = `autonomy.cat.${key}`;
  const v = t(k);
  return v === k ? fallback : v;
}

function render(host: HTMLElement, store: Store<AppState>): void {
  void store;
  const grid = h('div', { class: 'ladder-grid' });
  const footer = h('div', { class: 'ladder-footer muted-note' });

  const levelSelector = (cat: Category, onPick: (level: number) => void): HTMLElement => {
    const group = h('div', { class: 'level-seg' });
    for (const n of [1, 2, 3]) {
      const overCap = n > cat.maxLevel;
      const active = cat.level === n;
      const disabled = cat.locked || overCap;
      const seg = h('button', {
        class: `seg seg-${n}${active ? ' active' : ''}${overCap ? ' over-cap' : ''}`,
        disabled,
        onclick: disabled ? undefined : () => onPick(n),
      }, String(n));
      group.append(seg);
    }
    return group;
  };

  const load = async (): Promise<void> => {
    mount(grid, h('div', { class: 'muted-note ladder-loading' }, t('autonomy.loading')));
    footer.textContent = '';
    let cfg: Config;
    try { cfg = await api.get<Config>('/api/autonomy'); }
    catch { mount(grid, h('div', { class: 'muted-note err' }, t('autonomy.loadError'))); footer.textContent = ''; return; }

    const pick = (cat: Category, level: number): void => {
      void (async () => {
        try { await api.post('/api/autonomy', { key: cat.key, level }); await load(); }
        catch (err) { toast(err instanceof ApiError ? (err.message || t('autonomy.error')) : t('autonomy.saveError'), true); }
      })();
    };

    mount(grid, ...cfg.categories.map((cat) => {
      const variant = cat.locked ? 'locked' : cat.maxLevel < 3 ? 'capped' : 'normal';
      const marker = cat.locked
        ? h('span', { class: 'ladder-marker locked-marker' }, icon('lock', 14), t('autonomy.lockedMarker'))
        : variant === 'capped'
          ? h('span', { class: 'ladder-marker capped-marker' }, icon('shield', 14), t('autonomy.capMarker', { N: cat.maxLevel }))
          : h('span', { class: 'ladder-marker-spacer' });
      return h('div', { class: `ladder-row variant-${variant}` },
        h('div', { class: 'ladder-label' }, catLabel(cat.key, cat.label)),
        marker,
        levelSelector(cat, (level) => pick(cat, level)),
      );
    }));

    footer.textContent = cfg.updatedAt > 0
      ? t('autonomy.footer.modified', { date: new Date(cfg.updatedAt * 1000).toLocaleString(currentLocale()) })
      : t('autonomy.footer.never');
  };

  mount(host,
    h('div', { class: 'page-header autonomy-header' },
      h('div', null, h('h1', null, t('autonomy.title')), h('p', { class: 'subtitle' }, t('autonomy.subtitle'))),
      h('button', { class: 'secondary', onclick: () => void load() }, icon('refresh', 16), t('autonomy.refresh')),
    ),
    h('div', { class: 'panel ladder-legend' },
      h('div', { class: 'legend-item' }, h('span', { class: 'legend-dot lvl-1' }), h('b', null, '1'), t('autonomy.legend.1')),
      h('div', { class: 'legend-item' }, h('span', { class: 'legend-dot lvl-2' }), h('b', null, '2'), t('autonomy.legend.2')),
      h('div', { class: 'legend-item' }, h('span', { class: 'legend-dot lvl-3' }), h('b', null, '3'), t('autonomy.legend.3')),
    ),
    grid,
    footer,
  );
  void load();
}

defineView('autonomy', 'nav.autonomy', render);
