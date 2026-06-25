// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * Level-0 skill index generation (SPEC §10, progressive loading).
 *
 * The index is the cheapest tier: one line per skill (name + description).
 * Output is deterministic — sorted by name, then scope — so regenerating an
 * unchanged skill set produces a byte-identical file (diff-friendly, no
 * spurious agent-context churn).
 *
 * The index text is agent-facing context (read by LLM agents, not shown to
 * the operator), so it is plain English by design and does not go through
 * i18n.
 */
import { atomicWriteFile } from '../core/fsx.js';
import { compareSkillNames, type SkillMeta, type SkillStore } from './store.js';

const INDEX_HEADER = '# Skills';

/**
 * Render a deterministic Level-0 markdown index: `- **name**: description`
 * per line, sorted by name then scope, locals tagged so an agent can tell
 * its own skills from fleet-wide ones.
 */
export function buildIndex(skills: SkillMeta[]): string {
  const sorted = [...skills].sort(
    (a, b) => compareSkillNames(a.name, b.name) || compareSkillNames(a.scope, b.scope),
  );
  const lines: string[] = [INDEX_HEADER, ''];
  if (sorted.length === 0) {
    lines.push('(no skills installed)');
  } else {
    for (const skill of sorted) {
      const tag = skill.scope === 'local' ? ' [local]' : '';
      lines.push(`- **${skill.name}**${tag}: ${skill.description}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Write one agent's Level-0 index = its effective skill set (global + own
 * locals, locals shadowing). Never contains another agent's locals because
 * effectiveSkills never does. Atomic write so a reader can never observe a
 * half-written index.
 */
export function writeAgentIndex(store: SkillStore, agentId: string, targetFile: string): void {
  atomicWriteFile(targetFile, buildIndex(store.effectiveSkills(agentId)));
}
