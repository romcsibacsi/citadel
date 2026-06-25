// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { h, mount } from './dom.js';
import { t } from './i18n.js';
import { framedAvatar } from './framedAvatar.js';

/**
 * Shared team-constellation renderer (PROMPT-04 §2 reuse note): a top-down,
 * breadth-first hierarchy of node tiles joined by vertical connectors. Used
 * identically by the dedicated Team page and the Overview's team card, so the
 * two never disagree. The hub is featured + inert; non-hub tiles are clickable.
 */

export interface RosterNode {
  id: string;
  label: string;
  role: 'hub' | 'leader' | 'member';
  running: boolean;
  hasAvatar: boolean;
  avatarUrl: string;
}
export interface TeamGraph {
  hubId: string;
  nodes: RosterNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface TeamGraphOptions {
  /** Resolve an agent's accent color (for the avatar disc tint). */
  accentOf: (id: string) => string;
  /** Click handler for a non-hub tile (the hub tile is always inert). */
  onNodeClick?: (id: string) => void;
  /** Append the "no sub-agents" note when only the hub exists (default true). */
  showEmpty?: boolean;
}

/** Bucket the reports-to graph into top-down levels (hub at level 0, orphans last). */
export function levelsOf(graph: TeamGraph): RosterNode[][] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = childrenOf.get(e.to) ?? [];
    arr.push(e.from);
    childrenOf.set(e.to, arr);
  }
  const levels: RosterNode[][] = [];
  const placed = new Set<string>();
  let frontier = byId.has(graph.hubId) ? [graph.hubId] : [];
  while (frontier.length > 0) {
    const row = frontier.map((id) => byId.get(id)).filter((n): n is RosterNode => n !== undefined);
    if (row.length === 0) break;
    levels.push(row);
    for (const id of frontier) placed.add(id);
    const next: string[] = [];
    for (const id of frontier) for (const child of childrenOf.get(id) ?? []) if (!placed.has(child)) next.push(child);
    frontier = next;
  }
  // any node never reached from the hub (orphan / broken reports-to) goes last
  const orphans = graph.nodes.filter((n) => !placed.has(n.id));
  if (orphans.length > 0) levels.push(orphans);
  return levels;
}

/** Map the graph's role enum to a display label key (the hub reads "main agent"). */
function roleLabel(role: RosterNode['role']): string {
  return t(`team.role.${role === 'hub' ? 'main' : role}`);
}

function avatarFor(node: RosterNode, accent: string, size: number): HTMLElement {
  const disc = framedAvatar(node.label, accent, size);
  // request the avatar image only when one is known to exist; on load failure
  // the <img> removes itself and the monogram shows through.
  if (node.hasAvatar) {
    const img = h('img', { src: node.avatarUrl, alt: '' }) as HTMLImageElement;
    img.addEventListener('error', () => img.remove());
    disc.querySelector('.disc')?.append(img);
  }
  return disc;
}

function teamNode(node: RosterNode, hubId: string, opts: TeamGraphOptions): HTMLElement {
  const accent = opts.accentOf(node.id);
  const isHub = node.id === hubId;
  const inner = h(
    'div',
    { class: 'team-node-inner' },
    avatarFor(node, accent, isHub ? 72 : 56),
    h('div', { class: 'node-name' }, node.label),
    h('div', { class: 'node-role' }, roleLabel(node.role)),
    h(
      'div',
      { class: `node-run ${node.running ? 'on' : 'off'}` },
      h('span', { class: 'run-dot' }, node.running ? '●' : '○'),
      node.running ? t('team.running.yes') : t('team.running.no'),
    ),
  );
  if (isHub) {
    return h('div', { class: 'team-node hub', style: `--ac: ${accent}` }, inner);
  }
  const cls = `team-node${node.role === 'leader' ? ' leader' : ''}`;
  return h('button', { class: cls, style: `--ac: ${accent}`, onclick: () => opts.onNodeClick?.(node.id) }, inner);
}

function levelRow(row: RosterNode[], hubId: string, opts: TeamGraphOptions): HTMLElement {
  return h('div', { class: 'team-level' }, ...row.map((n) => teamNode(n, hubId, opts)));
}

/** Render the constellation for `graph` into `container` (replaces its content). */
export function renderTeamGraph(container: HTMLElement, graph: TeamGraph, opts: TeamGraphOptions): void {
  const levels = levelsOf(graph);
  const subAgentCount = graph.nodes.filter((n) => n.id !== graph.hubId).length;
  const tree = h('div', { class: 'team-tree' });
  levels.forEach((row, idx) => {
    if (idx > 0) tree.append(h('div', { class: 'team-connector' }));
    tree.append(levelRow(row, graph.hubId, opts));
  });
  const children: HTMLElement[] = [tree];
  if (opts.showEmpty !== false && subAgentCount === 0) {
    children.push(h('div', { class: 'muted-note' }, t('team.empty')));
  }
  mount(container, ...children);
}
