// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type {
  AgentConfig,
  AutonomyCategorySeed,
  OrchestratorConfig,
  SecurityProfileConfig,
} from './types.js';

/**
 * Safe, brand-neutral fallbacks (SPEC §4: "all reads tolerant of missing/
 * malformed config"). The committed seed supplies the real install values;
 * these defaults only guarantee the system never crashes on a sparse config.
 */

/**
 * Stuck-agent watchman thresholds (#80): how long an agent may stay 'working'
 * with an UNCHANGED tail (no progress) before each escalation. Level 1 alerts the
 * hub + flags the dashboard; level 2 restarts a desired-running agent fresh.
 */
export const DEFAULT_STUCK_THRESHOLDS = { level1Ms: 10 * 60_000, level2Ms: 25 * 60_000 } as const;

/** The default dashboard/API port. Co-located installs collide here (#190) unless offset. */
export const DEFAULT_SERVER_PORT = 7080;

export const DEFAULT_SECURITY_PROFILES: SecurityProfileConfig[] = [
  {
    id: 'sandbox',
    label: 'Sandbox',
    mode: 'strict',
    defaultMode: 'bypassPermissions',
    privilegeLevel: 0,
    allow: ['Read({AGENT_DIR}/**)', 'Write({AGENT_DIR}/**)', 'Edit({AGENT_DIR}/**)'],
    ask: [],
    deny: ['Bash(*)', 'WebFetch(*)', 'Read(/**)', 'Write(/**)'],
  },
  {
    id: 'draft',
    label: 'Draft / read-mostly',
    mode: 'strict',
    defaultMode: 'ask',
    privilegeLevel: 1,
    allow: ['Read(/**)', 'Write({AGENT_DIR}/**)', 'Edit({AGENT_DIR}/**)', 'Bash(git status)', 'Bash(git log *)'],
    ask: ['Bash(*)'],
    deny: ['Write(/etc/**)', 'Bash(sudo *)'],
  },
  {
    id: 'trusted-build',
    label: 'Trusted build',
    mode: 'permissive',
    privilegeLevel: 2,
    allow: ['Read(/**)', 'Write(/**)', 'Edit(/**)', 'Bash(*)'],
    ask: [],
    deny: ['Bash(sudo *)', 'Write(/etc/**)'],
  },
  {
    id: 'full-host',
    label: 'Full host (pre-seeded roster only)',
    mode: 'permissive',
    privilegeLevel: 3,
    allow: ['*'],
    ask: [],
    deny: [],
  },
];

/**
 * Default autonomy ladder (SPEC §12, FIX-autonomy-categories). The full operator
 * category set: the everyday operational dials (kanban / memory / deploy / skill)
 * default to level 1 with headroom to 3, email is capped at 2 (propose + await
 * approval, never act alone), and the five sensitive categories are hard-locked
 * at level 1 — enforced server-side via HARD_LOCKED_CATEGORIES, never config.
 * A missing config must not default to fully-autonomous, so this ships as the
 * floor; on upgrade the ladder only ADDS newly-introduced categories (it never
 * resets an operator-set level — see AutonomyLadder.seed). Keys are the exact
 * operator ids (underscored) so the hard-lock constant matches by identity.
 */
export const DEFAULT_AUTONOMY_SEED: AutonomyCategorySeed[] = [
  { category: 'kanban_archive_done', level: 1, maxLevel: 3, locked: false },
  { category: 'kanban_stuck_nudge', level: 1, maxLevel: 3, locked: false },
  { category: 'memory_maintenance', level: 1, maxLevel: 3, locked: false },
  { category: 'routine_trivial_fix', level: 1, maxLevel: 3, locked: false },
  { category: 'deploy_retry', level: 1, maxLevel: 3, locked: false },
  { category: 'kanban_restructure', level: 1, maxLevel: 3, locked: false },
  { category: 'skill_patch', level: 1, maxLevel: 3, locked: false },
  // capped (max 2, not locked): email may propose + await approval, never act alone
  { category: 'email_send', level: 1, maxLevel: 2, locked: false },
  // hard-locked at level 1 (HARD_LOCKED_CATEGORIES): code-enforced, never raisable
  { category: 'publish_content', level: 1, maxLevel: 1, locked: true },
  { category: 'payment', level: 1, maxLevel: 1, locked: true },
  { category: 'data_delete', level: 1, maxLevel: 1, locked: true },
  { category: 'permission_change', level: 1, maxLevel: 1, locked: true },
  { category: 'external_message', level: 1, maxLevel: 1, locked: true },
  // #123: a NAV data-report submit is a money/legal-consequence action -> never agent-autonomous
  { category: 'nav_submit', level: 1, maxLevel: 1, locked: true },
];

export function defaultHubAgent(): AgentConfig {
  return {
    id: 'hub',
    displayName: 'Hub',
    role: 'Orchestrator',
    securityProfile: 'full-host',
    accentColor: '#7c5cff',
    authMode: 'shared-subscription',
    channel: null,
    team: { role: 'hub', delegatesTo: [], trustFrom: [] },
  };
}

export function defaultConfig(): OrchestratorConfig {
  return {
    branding: { productName: 'Orchestrator' },
    locale: { default: 'hu', agentProse: 'hu' },
    timezone: 'Europe/Budapest',
    server: { host: '127.0.0.1', port: DEFAULT_SERVER_PORT, allowedOrigins: [] },
    hubId: 'hub',
    agents: [defaultHubAgent()],
    lanes: [],
    securityProfiles: DEFAULT_SECURITY_PROFILES,
    channels: {},
    scheduler: {
      catchupWindowMinutes: 5,
      bootCatchupWindowMinutes: 180,
      retryIntervalMinutes: 10,
      fanoutStaggerSeconds: 10,
      autoDigest: true,
    },
    autonomySeed: DEFAULT_AUTONOMY_SEED,
    runtime: {
      adapter: 'claude-code',
      claude: { command: 'claude', staggerSeconds: 15, sessionPrefix: 'orch' },
    },
    modelAliases: {},
    // Subscription is the hard default — API billing is reachable ONLY via the
    // explicit operator toggle, never automatically (FIX-billing-api-optin).
    billing: { mode: 'subscription' },
    // Permissive by default (FIX-agent-permissions-permissive): cautious profiles
    // run without interactive prompts so a dispatched sub-agent never wedges; deny
    // rules are always enforced. A buyer sets 'ask' for a stricter posture.
    defaultPermissionMode: 'permissive',
  };
}
