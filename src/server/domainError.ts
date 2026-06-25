// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { HttpError } from './router.js';

/**
 * Maps domain-store errors (English code-level messages) onto HttpErrors that
 * carry an i18n key, so the boundary renders them in the operator's language
 * (SPEC §7a/§20.14). Stores stay i18n-free by design — translation is a
 * serving-layer concern. First match wins.
 */

interface ErrorRule {
  pattern: RegExp;
  status: number;
  key: string;
  /** Extracts {params} for the catalog template from the regex match. */
  params?: (m: RegExpMatchArray) => Record<string, string | number>;
}

const RULES: ErrorRule[] = [
  // kanban
  { pattern: /kanban card not found/, status: 404, key: 'kanban.error.cardNotFound' },
  { pattern: /parent card not found/, status: 404, key: 'kanban.error.parentNotFound' },
  { pattern: /card title must be/, status: 400, key: 'kanban.error.titleRequired' },
  { pattern: /invalid card status: (.+)/, status: 400, key: 'kanban.error.invalidStatus', params: (m) => ({ status: m[1] ?? '' }) },
  { pattern: /invalid card priority: (.+)/, status: 400, key: 'kanban.error.invalidPriority', params: (m) => ({ priority: m[1] ?? '' }) },
  { pattern: /status (changes go through|cannot be changed)/, status: 400, key: 'kanban.error.statusViaUpdate' },
  { pattern: /(nesting|breakdown) is 1-level only|cannot be its own parent/, status: 400, key: 'kanban.error.nestingDepth' },
  // ideas
  { pattern: /idea not found/, status: 404, key: 'ideas.error.notFound' },
  { pattern: /already promoted to card/, status: 409, key: 'ideas.error.alreadyPromoted' },
  { pattern: /archived ideas (are immutable|cannot)/, status: 409, key: 'ideas.error.archivedImmutable' },
  { pattern: /idea title must be/, status: 400, key: 'ideas.error.titleRequired' },
  { pattern: /invalid idea status: (.+)/, status: 400, key: 'ideas.error.invalidStatus', params: (m) => ({ status: m[1] ?? '' }) },
  // autonomy
  { pattern: /hard-locked at level 1/, status: 403, key: 'autonomy.error.hardLocked', params: extractCategory },
  { pattern: /autonomy category '(.+)' is locked/, status: 403, key: 'autonomy.error.locked', params: (m) => ({ category: m[1] ?? '' }) },
  { pattern: /exceeds maxLevel|invalid autonomy level/, status: 403, key: 'autonomy.error.aboveMax', params: extractCategory },
  { pattern: /unknown autonomy category: (.+)/, status: 404, key: 'autonomy.error.unknownCategory', params: (m) => ({ category: m[1] ?? '' }) },
  // skills
  { pattern: /requires hub approval/, status: 403, key: 'skills.error.approvalRequired' },
  { pattern: /skill is pinned/, status: 403, key: 'skills.error.pinned' },
  { pattern: /skill already exists/, status: 409, key: 'skills.error.duplicate', params: lastWordAsName },
  { pattern: /invalid skill name/, status: 400, key: 'skills.error.invalidName', params: lastWordAsName },
  { pattern: /local skill operations require/, status: 400, key: 'skills.error.agentRequired' },
  { pattern: /skill import rejected: .*(symlink)/, status: 400, key: 'skills.import.symlink', params: () => ({ path: '' }) },
  { pattern: /skill import rejected: .*(escapes|unsafe|traversal)/, status: 400, key: 'skills.import.unsafePath', params: () => ({ path: '' }) },
  { pattern: /skill import rejected: source does not exist/, status: 400, key: 'skills.import.sourceMissing' },
  { pattern: /skill import rejected: .*malformed/, status: 400, key: 'skills.import.malformed' },
  { pattern: /skill file is malformed|skill not found/, status: 404, key: 'skills.error.notFound', params: lastWordAsName },
  // schedules
  { pattern: /scheduled task not found/, status: 404, key: 'schedules.error.notFound' },
  { pattern: /invalid cron/i, status: 400, key: 'schedules.error.invalidCron' },
  // vault
  { pattern: /secret .* not found|no such secret/, status: 404, key: 'vault.secretMissing', params: () => ({ id: '' }) },
];

function extractCategory(m: RegExpMatchArray): Record<string, string | number> {
  const source = m.input ?? '';
  const quoted = source.match(/'([^']+)'/);
  return { category: quoted?.[1] ?? '', level: '', maxLevel: '' };
}

function lastWordAsName(m: RegExpMatchArray): Record<string, string | number> {
  const source = m.input ?? '';
  const tail = source.match(/: ("?)([\w-]+)\1$/);
  return { name: tail?.[2] ?? '' };
}

/** Map a thrown domain error to a keyed HttpError; undefined when no rule fits. */
export function mapDomainError(err: unknown): HttpError | undefined {
  const message = err instanceof Error ? err.message : String(err);
  for (const rule of RULES) {
    const m = message.match(rule.pattern);
    if (m) {
      return new HttpError(rule.status, message, rule.key, rule.params?.(m));
    }
  }
  return undefined;
}
