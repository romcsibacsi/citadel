// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Runtime appearance preferences (SPEC §3/§6/§7 of the design spec): theme,
 * density, glow, and accent. All swap LIVE (no reload) by setting attributes /
 * CSS vars on <html>, are PERSISTED per user in localStorage, and are applied
 * BEFORE FIRST PAINT by the inline bootstrap in index.html (no flash-of-unstyled).
 */

export const THEMES = ['obsidian', 'stark', 'arcane-forge', 'light', 'dark'] as const;
export type ThemeId = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeId = 'obsidian';

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

/** Accent swatches the Tweaks panel offers (sets the global --ac). */
export const ACCENTS = ['#9b79ff', '#34d6f0', '#41e0a3', '#f0822e', '#f2c879', '#ff5d8f'] as const;

const KEY = {
  theme: 'ui.theme',
  density: 'ui.density',
  glow: 'ui.glow',
  accent: 'ui.accent',
} as const;

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: still applies for the session */
  }
}

// ---- theme ----
export function currentTheme(): ThemeId {
  const v = document.documentElement.dataset.theme;
  return (THEMES as readonly string[]).includes(v ?? '') ? (v as ThemeId) : DEFAULT_THEME;
}
export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  store(KEY.theme, theme);
}

// ---- density ----
export function currentDensity(): Density {
  const v = document.documentElement.dataset.density;
  return v === 'compact' ? 'compact' : 'comfortable';
}
export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density;
  store(KEY.density, density);
}

// ---- glow (0..1) ----
export function currentGlow(): number {
  const v = parseFloat(document.documentElement.style.getPropertyValue('--glow'));
  return Number.isFinite(v) ? v : 0.6;
}
export function applyGlow(glow: number): void {
  const clamped = Math.min(1, Math.max(0, glow));
  document.documentElement.style.setProperty('--glow', String(clamped));
  store(KEY.glow, String(clamped));
}

// ---- accent (--ac override; empty string clears it back to the theme default) ----
export function currentAccent(): string {
  return document.documentElement.style.getPropertyValue('--ac').trim();
}
export function applyAccent(accent: string): void {
  if (accent === '') {
    document.documentElement.style.removeProperty('--ac');
    try {
      localStorage.removeItem(KEY.accent);
    } catch {
      /* ignore */
    }
    return;
  }
  document.documentElement.style.setProperty('--ac', accent);
  store(KEY.accent, accent);
}
