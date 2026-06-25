// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { createLogger } from '../core/log.js';

const log = createLogger('i18n');

export type Catalog = Record<string, string>;
export type Catalogs = Record<string, Catalog>;

/**
 * Load every <locale>.json in a directory as a flat key->string catalog.
 * Adding a third locale is a drop-in file, no code change (SPEC §7a).
 */
export function loadCatalogs(dir: string): Catalogs {
  const catalogs: Catalogs = {};
  for (const file of readdirSync(dir)) {
    if (extname(file) !== '.json') continue;
    const locale = basename(file, '.json');
    const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) continue;
    const catalog: Catalog = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') catalog[k] = v;
    }
    catalogs[locale] = catalog;
  }
  return catalogs;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/**
 * Backend translator. Lookup order: requested locale -> install default ->
 * English -> the key itself (logged; never expected, catalog parity is
 * enforced by a unit test).
 */
export class I18n {
  private activeLocale: string;

  constructor(
    private readonly catalogs: Catalogs,
    private readonly installDefault: string,
  ) {
    this.activeLocale = installDefault;
  }

  get locale(): string {
    return this.activeLocale;
  }

  /** Runtime switch — takes effect immediately, no restart (SPEC §7a). */
  setLocale(locale: string): void {
    this.activeLocale = locale;
  }

  availableLocales(): string[] {
    return Object.keys(this.catalogs).sort();
  }

  t(key: string, params?: Record<string, string | number>, localeOverride?: string): string {
    const chain = [localeOverride ?? this.activeLocale, this.installDefault, 'en'];
    for (const locale of chain) {
      const hit = this.catalogs[locale]?.[key];
      if (hit !== undefined) return interpolate(hit, params);
    }
    log.error(`missing i18n key in every locale: ${key}`);
    return key;
  }
}
