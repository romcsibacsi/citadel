// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * UI i18n (SPEC §17, §7a): keyed catalogs, runtime language switch with no
 * reload (the app re-renders from the newly-active catalog). Persisted per
 * user; missing keys fall back install-default -> en -> never a raw key
 * (en parity is enforced by a server-side test).
 */

type Catalog = Record<string, string>;

const STORAGE_KEY = 'ui.lang';
const catalogs = new Map<string, Catalog>();
let active = document.documentElement.lang || 'hu';
let installDefault = 'hu';

export function availableLocales(): string[] {
  return [...catalogs.keys()].sort();
}

export async function initI18n(defaultLocale: string): Promise<void> {
  installDefault = defaultLocale;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  active = stored ?? defaultLocale;
  document.documentElement.lang = active;
  const wanted = new Set([active, installDefault, 'en']);
  await Promise.all(
    [...wanted].map(async (locale) => {
      if (catalogs.has(locale)) return;
      const res = await fetch(`/i18n/${locale}.json`);
      if (res.ok) catalogs.set(locale, (await res.json()) as Catalog);
    }),
  );
}

export function currentLocale(): string {
  return active;
}

export async function setLocale(locale: string): Promise<void> {
  if (!catalogs.has(locale)) {
    const res = await fetch(`/i18n/${locale}.json`);
    if (res.ok) catalogs.set(locale, (await res.json()) as Catalog);
  }
  active = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* ignore */
  }
}

export function t(key: string, params?: Record<string, string | number>): string {
  const template =
    catalogs.get(active)?.[key] ?? catalogs.get(installDefault)?.[key] ?? catalogs.get('en')?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}
