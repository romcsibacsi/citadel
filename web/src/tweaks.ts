// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import {
  THEMES,
  DENSITIES,
  ACCENTS,
  currentTheme,
  applyTheme,
  currentDensity,
  applyDensity,
  currentGlow,
  applyGlow,
  currentAccent,
  applyAccent,
  type ThemeId,
} from './theme.js';

/**
 * The Tweaks panel (design spec §6): floating, bottom-right, dismissible live
 * customization — theme / density / glow / accent. Every choice is applied LIVE
 * (the theme manager persists it) and the panel re-renders to track the state.
 */

/** A representative chip color per theme for the swatch list. */
const THEME_CHIP: Record<ThemeId, string> = {
  obsidian: '#34d6f0',
  stark: '#46e6ff',
  'arcane-forge': '#e6b249',
  light: '#d97757',
  dark: '#6ea8fe',
};

let panel: HTMLElement | null = null;

export function isTweaksOpen(): boolean {
  return panel !== null;
}

export function closeTweaks(): void {
  panel?.remove();
  panel = null;
}

export function toggleTweaks(): void {
  if (panel) {
    closeTweaks();
    return;
  }
  panel = h('div', { class: 'tweaks', role: 'dialog', 'aria-label': t('tweaks.title') });
  document.body.append(panel);
  renderPanel();
}

function renderPanel(): void {
  if (!panel) return;
  const refresh = (): void => renderPanel();
  const glowReadout = h('span', { class: 'glow-val', 'data-glow-val': '1' }, fmtGlow(currentGlow()));

  mount(
    panel,
    h(
      'div',
      { class: 'tweaks-head' },
      h('h3', null, t('tweaks.title')),
      h('button', { class: 'icon-btn', 'aria-label': t('tweaks.close'), onclick: () => closeTweaks() }, '✕'),
    ),

    // THEME
    section(
      'tweaks.theme',
      h(
        'div',
        { class: 'theme-grid' },
        ...THEMES.map((theme) =>
          h(
            'button',
            {
              class: `theme-swatch${theme === currentTheme() ? ' active' : ''}`,
              'data-theme-id': theme,
              onclick: () => {
                applyTheme(theme);
                refresh();
              },
            },
            h('span', { class: 'chip', style: `background:${THEME_CHIP[theme]}` }),
            t(`theme.${theme}`),
          ),
        ),
      ),
    ),

    // DENSITY
    section(
      'tweaks.density',
      h(
        'div',
        { class: 'seg' },
        ...DENSITIES.map((d) =>
          h(
            'button',
            {
              class: d === currentDensity() ? 'active' : '',
              'data-density-id': d,
              onclick: () => {
                applyDensity(d);
                refresh();
              },
            },
            t(`tweaks.density.${d}`),
          ),
        ),
      ),
    ),

    // GLOW (with a live numeric readout next to the slider — §3a)
    section(
      'tweaks.glow',
      h(
        'div',
        { class: 'glow-row' },
        h('input', {
          type: 'range',
          min: '0',
          max: '1',
          step: '0.05',
          value: String(currentGlow()),
          'aria-label': t('tweaks.glow'),
          'data-glow-slider': '1',
          oninput: (e: Event) => {
            const v = parseFloat((e.target as HTMLInputElement).value);
            applyGlow(v);
            glowReadout.textContent = fmtGlow(v);
          },
        }),
        glowReadout,
      ),
    ),

    // ACCENT
    section(
      'tweaks.accent',
      h(
        'div',
        { class: 'swatch-row' },
        h('button', {
          class: `swatch${currentAccent() === '' ? ' active' : ''}`,
          title: t('tweaks.accent.default'),
          style: 'background: conic-gradient(from 0deg,#34d6f0,#9b79ff,#f2c879,#34d6f0)',
          onclick: () => {
            applyAccent('');
            refresh();
          },
        }),
        ...ACCENTS.map((color) =>
          h('button', {
            class: `swatch${currentAccent().toLowerCase() === color.toLowerCase() ? ' active' : ''}`,
            style: `background:${color}`,
            'aria-label': color,
            onclick: () => {
              applyAccent(color);
              refresh();
            },
          }),
        ),
      ),
    ),
  );
}

function section(labelKey: string, ...children: (HTMLElement | string)[]): HTMLElement {
  return h('div', { class: 'tweaks-section' }, h('div', { class: 'sec-label' }, t(labelKey)), ...children);
}

/** Render the glow value without float artifacts (e.g. 0.6, 0.55). */
function fmtGlow(v: number): string {
  return parseFloat(v.toFixed(2)).toString();
}

/** A footer light/dark quick-toggle (sun/moon) — swaps light <-> the dark default. */
export function quickThemeToggle(onChange: () => void): HTMLElement {
  const isLight = currentTheme() === 'light';
  return h(
    'button',
    {
      class: 'icon-btn',
      'aria-label': t(isLight ? 'tweaks.toDark' : 'tweaks.toLight'),
      onclick: () => {
        applyTheme(isLight ? 'obsidian' : 'light');
        onChange();
      },
    },
    icon(isLight ? 'moon' : 'sun'),
  );
}

/** A footer gear button that opens the Tweaks panel. */
export function tweaksGearButton(): HTMLElement {
  return h(
    'button',
    { class: 'icon-btn', 'data-tweaks-gear': '1', 'aria-label': t('tweaks.title'), onclick: () => toggleTweaks() },
    icon('gear'),
  );
}
