// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { SeedTask } from '../scheduler/learning.js';

/**
 * The learning-loop machinery seeds (SPEC §9). CONTENT, not architecture:
 * ensureSeedTasks inserts these only when absent — operator edits are never
 * overwritten. Prompts are agent-facing instructions (English protocol text);
 * each instructs the agent to produce operator-facing prose in the configured
 * language. Background tasks must never message a live channel — only the
 * morning brief deliberately does, and only via the hub.
 */
export function learningLoopSeeds(hubId: string, opts: { autoDigest?: boolean } = {}): SeedTask[] {
  const seeds: SeedTask[] = [
    {
      id: 'heartbeat-consolidate',
      title: 'Consolidation heartbeat',
      prompt:
        'Silent consolidation heartbeat (do NOT message the operator or any channel). ' +
        'If you did real work since the last heartbeat: (1) save what you learned with ' +
        '`agentctl mem save` (shared tier when fleet-relevant), (2) append one daily-log line via ' +
        '`agentctl log`, (3) consider whether a reusable skill is warranted — if yes and it is ' +
        'agent-local, create it; if global, message the hub with the proposal. If the period was idle, do nothing.',
      cron: '*/30 * * * *',
      target: 'all',
      type: 'heartbeat',
      skipIfBusy: true,
    },
    {
      id: 'nightly-dream',
      title: 'Nightly consolidation (dream)',
      prompt:
        'Nightly consolidation. Do NOT message the operator or any channel; your only outputs are the dream file ' +
        'and memory. Read the fleet daily logs and your memory (`agentctl mem search`), then OVERWRITE the dream ' +
        'file via `agentctl dream write` (stdin markdown) with: (1) team recap of the day, (2) skill/process ' +
        'proposals, (3) memory health notes, (4) tomorrow\'s top-3 priorities, and (5) ONLY IF TODAY IS MONDAY an ' +
        'external-opportunity scan section. Write the file in the configured operator language.',
      cron: '30 2 * * *',
      target: hubId,
      type: 'task',
      bypassTriage: true,
    },
    {
      id: 'dream-consumer',
      title: 'Dream consumer — proposals into action',
      prompt:
        'Read the nightly dream file (`agentctl dream read`). Turn proposals into action WITHOUT messaging the ' +
        'operator: create agent-local skills directly where warranted; create kanban cards for concrete work; ' +
        'push operator-facing decisions into the idea box (`agentctl idea add`). Respect skill governance.',
      cron: '0 7 * * *',
      target: hubId,
      type: 'task',
    },
    {
      id: 'board-supervisor',
      title: 'Kanban board supervisor',
      prompt:
        'Board supervisor (do NOT message the operator unless a card genuinely needs an operator DECISION). ' +
        'Review the board with `agentctl kanban board`. For each PLANNED card: if it has an assignee, is ready ' +
        'to start, and does NOT require approval, move it to in_progress with `agentctl kanban move <id> ' +
        'in_progress` — that dispatches the work to its assignee. NEVER start a card that requires approval (it ' +
        'awaits the operator) or one with no assignee (instead leave a comment that it needs an owner). For each ' +
        'IN_PROGRESS card whose assignee has clearly stalled: FIRST read that card\'s comments — if you already left ' +
        'a "[nudge] <ISO-time>" marker within the last ~2 hours, SKIP it (do not re-nudge across runs, no spam). ' +
        'Otherwise send ONE short nudge via `agentctl msg send <assignee> <text>` AND immediately record it with ' +
        '`agentctl kanban comment <id> "[nudge] <current ISO time>"` so the next run sees it and won\'t repeat — ' +
        'at most one nudge per card per run. A card dispatched (moved to in_progress) but never engaged by its ' +
        'assignee counts as stalled and gets this same bounded nudge. Flag duplicate or obviously-stale cards with ' +
        '`agentctl kanban comment <id> <text>`; never run redundant work. If nothing is actionable, do nothing.',
      cron: '*/15 * * * *',
      target: hubId,
      type: 'task',
      skipIfBusy: true,
    },
    {
      id: 'cross-agent-sync',
      title: 'Cross-agent sync',
      prompt:
        'Silent fleet sync (no channel messages). Review the day\'s daily logs across agents and write shared-tier ' +
        'memory observations (`agentctl mem save shared ...`) about who did what and who is good at what, so any ' +
        'agent can recall fleet capabilities tomorrow.',
      cron: '15 3 * * *',
      target: hubId,
      type: 'task',
    },
    {
      id: 'morning-brief',
      title: 'Morning brief',
      prompt:
        'Compose the morning brief for the operator IN THE CONFIGURED OPERATOR LANGUAGE: yesterday\'s recap ' +
        '(daily logs + dream file), board status (in-progress / waiting / done), fresh ideas awaiting review, and ' +
        'today\'s top-3. Send it with `agentctl msg send operator <text>`. This is the one scheduled task that may ' +
        'reach the operator channel.',
      cron: '0 8 * * *',
      target: hubId,
      type: 'task',
      forceSend: true,
    },
  ];
  // Nightly Daily Digest (PROMPT-09 §6C): an agent-authored ~5-8 sentence summary
  // written to the hub's OWN daily log via the append API (`agentctl log`) — never
  // the memory store, never a channel message. Skips silently on a quiet day. The
  // off-switch (config.scheduler.autoDigest = false) drops this seed entirely.
  if (opts.autoDigest !== false) {
    seeds.push({
      id: 'daily-digest',
      title: 'Daily digest',
      prompt:
        'Silent daily digest (do NOT message the operator or any channel). Review today\'s episodic memories and ' +
        'daily-log activity (`agentctl mem search`, `agentctl log` history). If there was NO real activity today, ' +
        'do nothing. Otherwise write a terse ~5-8 sentence summary IN THE CONFIGURED OPERATOR LANGUAGE capturing ' +
        '(1) what tasks were worked on, (2) the important decisions made, and (3) what is still open / the next ' +
        'step — then append it to your OWN daily log via `agentctl log` (a single entry). Do not save it as a ' +
        'memory and do not send any channel message.',
      cron: '0 23 * * *',
      target: hubId,
      type: 'task',
    });
  }
  return seeds;
}
