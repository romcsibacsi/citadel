// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * NEXUS Judge-Panel view (BUILD-judge-panel Phase 5): the operator's window into a
 * panel run — solvers + judges, per-solution verdicts (scores + refutations), the
 * ranked decision trace (and which step decided), and the four-stage gate with its
 * evidence. The apply/reject actions reuse the operator-gated panel routes; apply is
 * enabled ONLY when the hard gate predicate holds (the server enforces it regardless).
 */

import { defineView } from './registry.js';
import { h, mount } from '../dom.js';
import { t } from '../i18n.js';
import { api, ApiError } from '../api.js';
import { icon } from '../icons.js';
import { toast } from '../toast.js';
import type { Store } from '../store.js';
import type { AppState } from '../main.js';

type PanelStatus = 'soliciting' | 'debating' | 'judging' | 'deciding' | 'gated_review' | 'applied' | 'rejected';
type GateStage = 'branch' | 'test' | 'review' | 'approve' | 'apply';
type GateStatus = 'pending' | 'passed' | 'failed' | 'handoff' | 'absent';

interface PanelRow { id: number; status: PanelStatus; category: string; branchPrefix: string; testCommand: string; appliedAt: string | null; createdAt: string }
interface Solution { id: number; solverAgentId: string; childCardId: number; branch: string; angle: string; commitSha: string | null; tailSummary: string | null; status: string }
interface Judge { role: 'probe' | 'oracle'; judgeAgentId: string; status: string }
interface Refutation { claim: string; severity: 'fatal' | 'major' | 'minor'; evidenceRef?: string }
interface Verdict { solutionId: number; judge: 'probe' | 'oracle'; scores: Record<string, number>; refutations: Refutation[]; recommendation: 'accept' | 'reject' | 'revise'; fatalDefect: boolean }
interface RankedEntry { solutionId: number; vetoed: boolean; composite: number; correctness: number; oracleCorrectness: number; majorDefects: number; minorDefects: number; lanePriorityIndex: number }
interface RuleOutput { winningSolutionId: number | null; decidedBy: string; ranked: RankedEntry[]; trace: string[] }
interface Decision { winningSolutionId: number | null; decidedBy: string; ruleOutput: RuleOutput }
interface Gate { stage: GateStage; status: GateStatus; evidenceRef: string | null }
interface GateSummary { branch: GateStatus; test: GateStatus; review: GateStatus; approve: GateStatus; apply: GateStatus; allPassed: boolean }
interface FullPanel { panel: PanelRow; goal: string; solutions: Solution[]; judges: Judge[]; verdicts: Verdict[]; decision: Decision | undefined; gates: Gate[]; gateSummary: GateSummary }

// selection survives the re-render cycle (module state)
let selectedId: number | null = null;

function statusBadge(s: PanelStatus): HTMLElement {
  return h('span', { class: `badge panel-status panel-status-${s}` }, t(`panel.status.${s}`));
}
function gateBadge(s: GateStatus): HTMLElement {
  return h('span', { class: `badge panel-gate-${s}` }, t(`panel.gatestatus.${s}`));
}
function sevBadge(s: 'fatal' | 'major' | 'minor'): HTMLElement {
  return h('span', { class: `badge panel-sev-${s}` }, t(`panel.severity.${s}`));
}
function scoresText(scores: Record<string, number>): string {
  const e = Object.entries(scores);
  return e.length === 0 ? '—' : e.map(([k, v]) => `${k}=${v}`).join(', ');
}

async function render(host: HTMLElement, store: Store<AppState>): Promise<void> {
  const reload = (): void => void render(host, store);

  let list: PanelRow[] = [];
  try {
    const res = await api.get<{ panels: PanelRow[] }>('/api/panels');
    list = res.panels;
  } catch {
    /* read failure: render chrome; a refresh retries */
  }
  if (selectedId === null && list.length > 0) selectedId = list[0]!.id;
  if (selectedId !== null && !list.some((p) => p.id === selectedId)) selectedId = list[0]?.id ?? null;

  let full: FullPanel | undefined;
  if (selectedId !== null) {
    try { full = await api.get<FullPanel>(`/api/panels/${selectedId}`); } catch { full = undefined; }
  }

  // ---------- left rail: panel list ----------
  const rail = h('div', { class: 'panel-rail' });
  if (list.length === 0) {
    rail.append(h('div', { class: 'muted-note panel-empty' }, t('panel.empty')));
  } else {
    for (const p of list) {
      rail.append(h('button', {
        class: `panel-rail-item${p.id === selectedId ? ' selected' : ''}`,
        onclick: () => { selectedId = p.id; reload(); },
      }, h('span', { class: 'panel-rail-id' }, `#${p.id}`), statusBadge(p.status), h('span', { class: 'panel-rail-cat muted-note' }, p.category)));
    }
  }

  // ---------- actions ----------
  const apply = async (): Promise<void> => {
    if (full === undefined) return;
    if (!window.confirm(t('panel.confirm.apply'))) return;
    try { await api.post(`/api/panels/${full.panel.id}/apply`, {}); toast(t('panel.toast.applied')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : t('panel.toast.applyFail'), true); }
  };
  const reject = async (): Promise<void> => {
    if (full === undefined) return;
    if (!window.confirm(t('panel.confirm.reject'))) return;
    try { await api.post(`/api/panels/${full.panel.id}/reject`, { reason: 'operator rejected from dashboard' }); toast(t('panel.toast.rejected')); reload(); }
    catch (err) { toast(err instanceof ApiError ? err.message : t('panel.toast.rejectFail'), true); }
  };

  // ---------- detail ----------
  const detail = h('div', { class: 'panel-detail' });
  if (full === undefined) {
    detail.append(h('div', { class: 'empty-block' }, h('div', { class: 'muted-note' }, t('panel.empty'))));
  } else {
    const solById = new Map(full.solutions.map((s) => [s.id, s]));
    const terminal = full.panel.status === 'applied' || full.panel.status === 'rejected';
    const canApply = full.gateSummary.allPassed && full.panel.status === 'gated_review';

    // header
    detail.append(h('div', { class: 'panel-detail-head' },
      h('div', null,
        h('h2', null, `#${full.panel.id} · ${full.goal}`),
        h('div', { class: 'panel-meta muted-note' },
          `${t('panel.field.category')}: ${full.panel.category} · ${t('panel.field.test')}: `,
          h('code', null, full.panel.testCommand),
        ),
      ),
      h('div', { class: 'panel-head-actions' },
        statusBadge(full.panel.status),
        h('button', { class: 'btn-mini', onclick: reload }, t('panel.btn.refresh')),
        h('button', { class: 'btn-mini primary', disabled: !canApply, onclick: () => void apply() }, t('panel.btn.apply')),
        h('button', { class: 'btn-mini danger', disabled: terminal, onclick: () => void reject() }, t('panel.btn.reject')),
      ),
    ));

    // solvers
    const solverRows = full.solutions.map((s) => h('div', { class: 'panel-row' },
      h('span', { class: 'panel-cell-agent' }, s.solverAgentId),
      h('span', { class: 'muted-note' }, s.angle || '—'),
      h('code', { class: 'panel-branch' }, s.branch),
      h('span', { class: `badge panel-solstatus-${s.status}` }, s.status),
      h('span', { class: 'muted-note panel-commit' }, s.commitSha ? s.commitSha.slice(0, 8) : '—'),
    ));
    detail.append(h('section', { class: 'panel-section' },
      h('h3', null, t('panel.col.solvers')),
      ...(solverRows.length > 0 ? solverRows : [h('div', { class: 'muted-note' }, '—')]),
    ));

    // judges
    detail.append(h('section', { class: 'panel-section' },
      h('h3', null, t('panel.col.judges')),
      ...full.judges.map((j) => h('div', { class: 'panel-row' },
        h('span', { class: 'panel-cell-agent' }, `${t(`panel.judge.${j.role}`)} · ${j.judgeAgentId}`),
        h('span', { class: 'badge' }, j.status),
      )),
    ));

    // verdicts (grouped by solution)
    const verdictSection = h('section', { class: 'panel-section' }, h('h3', null, t('panel.col.verdicts')));
    if (full.verdicts.length === 0) {
      verdictSection.append(h('div', { class: 'muted-note' }, t('panel.verdict.none')));
    } else {
      const bySol = new Map<number, Verdict[]>();
      for (const v of full.verdicts) { const a = bySol.get(v.solutionId) ?? []; a.push(v); bySol.set(v.solutionId, a); }
      for (const [solId, vs] of bySol) {
        const sol = solById.get(solId);
        const group = h('div', { class: 'panel-verdict-group' },
          h('div', { class: 'panel-verdict-head' }, `solution #${solId}${sol ? ` · ${sol.solverAgentId}` : ''}`),
        );
        for (const v of vs) {
          const refs = v.refutations.map((r) => h('div', { class: 'panel-refutation' }, sevBadge(r.severity), h('span', null, r.claim)));
          group.append(h('div', { class: 'panel-verdict' },
            h('div', { class: 'panel-verdict-row' },
              h('span', { class: 'badge' }, t(`panel.judge.${v.judge}`)),
              h('span', { class: 'muted-note' }, `${t('panel.verdict.scores')}: ${scoresText(v.scores)}`),
              h('span', { class: `badge panel-rec-${v.recommendation}` }, t(`panel.recommendation.${v.recommendation}`)),
              ...(v.fatalDefect ? [h('span', { class: 'badge panel-sev-fatal' }, t('panel.verdict.fatal'))] : []),
            ),
            ...refs,
          ));
        }
        verdictSection.append(group);
      }
    }
    detail.append(verdictSection);

    // decision (ranked trace + which step decided)
    const decSection = h('section', { class: 'panel-section' }, h('h3', null, t('panel.col.decision')));
    if (full.decision === undefined) {
      decSection.append(h('div', { class: 'muted-note' }, t('panel.decision.none')));
    } else {
      const ro = full.decision.ruleOutput;
      const winner = ro.winningSolutionId;
      decSection.append(h('div', { class: 'panel-decision-head' },
        winner === null
          ? h('span', { class: 'badge panel-sev-fatal' }, t('panel.decision.noWinner'))
          : h('span', { class: 'badge panel-rec-accept' }, t('panel.decision.winner', { id: winner })),
        h('span', { class: 'muted-note' }, `${t('panel.decision.by')}: ${ro.decidedBy}`),
      ));
      // ranked table
      const rankHead = h('div', { class: 'panel-rank-row panel-rank-head' },
        h('span', null, '#'), h('span', null, t('panel.decision.composite')), h('span', null, t('panel.severity.major')),
        h('span', null, t('panel.severity.minor')), h('span', null, 'oracle'), h('span', null, t('panel.decision.veto')),
      );
      const rankRows = ro.ranked.map((e) => h('div', { class: `panel-rank-row${e.vetoed ? ' vetoed' : ''}${e.solutionId === winner ? ' winner' : ''}` },
        h('span', null, `#${e.solutionId}`), h('span', null, String(e.composite)), h('span', null, String(e.majorDefects)),
        h('span', null, String(e.minorDefects)), h('span', null, String(e.oracleCorrectness)), h('span', null, e.vetoed ? '✓' : '—'),
      ));
      decSection.append(h('div', { class: 'panel-rank' }, rankHead, ...rankRows));
      // trace
      decSection.append(h('div', { class: 'panel-trace' },
        h('div', { class: 'muted-note' }, t('panel.decision.trace')),
        ...ro.trace.map((line) => h('div', { class: 'panel-trace-line' }, line)),
      ));
    }
    detail.append(decSection);

    // gate stages + evidence
    const gateBy = new Map(full.gates.map((g) => [g.stage, g]));
    const stages: GateStage[] = ['branch', 'test', 'review', 'approve', 'apply'];
    detail.append(h('section', { class: 'panel-section' },
      h('h3', null, t('panel.col.gate')),
      ...stages.map((st) => {
        const g = gateBy.get(st);
        const status: GateStatus = st === 'approve' ? full.gateSummary.approve : (g?.status ?? 'absent');
        return h('div', { class: 'panel-gate-row' },
          h('span', { class: 'panel-gate-stage' }, t(`panel.gate.${st}`)),
          gateBadge(status),
          h('span', { class: 'muted-note panel-gate-evidence' }, g?.evidenceRef ? g.evidenceRef.slice(0, 160) : '—'),
        );
      }),
    ));
  }

  mount(host,
    h('div', { class: 'page-header' },
      h('div', null, h('h1', null, t('panel.title')), h('p', { class: 'subtitle' }, t('panel.subtitle'))),
      h('div', null, h('button', { class: 'primary', onclick: reload }, icon('sync', 16), t('panel.btn.refresh'))),
    ),
    h('div', { class: 'panel-layout' }, rail, detail),
  );
}

defineView('panels', 'nav.panels', (host, store) => {
  void render(host, store);
});
