// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * The single config surface (SPEC §2, §4). Everything brand-, roster-, locale-,
 * port- and path-specific lives here — never in code. The committed seed
 * (seed/seed.config.json) provides the operator's initial values; the live file
 * lives at <stateDir>/config.json and is operator-editable.
 */

export type LocaleCode = string; // 'hu' | 'en' | any drop-in catalog code

export interface BrandingConfig {
  /** Product display name shown in UI/docs/prose — pure data, never logic. */
  productName: string;
  tagline?: string;
}

export interface LocaleConfig {
  /** Install-wide default for UI + generated prose (chosen at install, SPEC §7a). */
  default: LocaleCode;
  /** Language agents write prose in — independent axis from the UI language. */
  agentProse: LocaleCode;
}

export interface ServerConfig {
  /** Loopback by default; non-loopback is a deliberate choice (SPEC §17). */
  host: string;
  port: number;
  /** Extra allowed origins for state-changing requests (beyond the own origin). */
  allowedOrigins: string[];
}

export type AuthMode = 'shared-subscription' | 'own-credentials' | 'api-key';

export interface TeamConfig {
  role: string;
  reportsTo?: string;
  delegatesTo: string[];
  trustFrom: string[];
  /** Leader-only: may the leader split + assign work itself (vs. propose only). */
  autoDelegation?: boolean;
}

export interface AgentLifecycleConfig {
  ephemeral?: boolean;
  doneWhen?: string;
  deadline?: string;
  closed?: boolean;
}

export interface AgentConfig {
  /** Canonical sanitized id (lowercase, [a-z0-9-]). */
  id: string;
  displayName: string;
  /** Short role descriptor for UI + routing prose. */
  role: string;
  /** Model id/alias resolved through the model alias map. */
  model?: string;
  /**
   * Which runtime backend launches this agent (FIX-local-model-agents). 'claude'
   * (default) = Claude Code on the subscription/Anthropic; 'ollama' = a LOCAL-model
   * agent — Claude Code pointed at the operator's private ollama (free, local) via
   * ANTHROPIC_BASE_URL + a dummy token. Explicit, never inferred from model name.
   */
  runtime?: 'claude' | 'ollama';
  securityProfile: string;
  accentColor: string;
  authMode: AuthMode;
  /** Channel binding: provider id or null for dashboard-only agents. */
  channel?: { provider: string; chatId?: string } | null;
  /** Alternate config root override (default: <stateDir>/agents/<id>). */
  configRoot?: string;
  strictTools?: boolean;
  /** Hidden/internal workers: excluded from roster view, scheduler, routing (SPEC §4). */
  hidden?: boolean;
  /**
   * Customer-facing agent (#115/#117 isolation): handles end-customer data and MUST
   * NOT leak it into fleet-wide surfaces. Structurally enforced — such an agent is
   * REFUSED a write to the shared memory tier (PII-to-shared is a code-blocked path,
   * not a persona instruction). End-customer data lives only in the scoped cs_* store.
   */
  customerFacing?: boolean;
  /**
   * Go-live gate for additive seed-roster propagation (#129): a seed agent marked
   * dormant is PRESENT in the seed but NOT propagated into a running config by
   * migrateSeedRoster — it stays out of the live roster until the flag is cleared
   * (e.g. the bookkeeper waits on its financial-data memory-isolation enforcement +
   * holistic QA). It does not affect a fleet that already carries the agent.
   */
  dormant?: boolean;
  /**
   * FAIL-CLOSED visibility marker for additive seed-roster propagation (#129) into a
   * PROFILED (sold-product) deployment: an agent migrated in is HIDDEN unless it sets
   * `productVisible: true`. The single source of truth for "may a newly propagated
   * agent appear in the customer surface?" — an unmarked/future agent defaults hidden
   * (no leak into a customer UI). Product/domain agents (support, the bookkeeper) set
   * it true; internal/dev agents leave it unset. Irrelevant to the own fleet (which
   * has no installedProfile and is never auto-migrated).
   */
  productVisible?: boolean;
  team: TeamConfig;
  lifecycle?: AgentLifecycleConfig;
}

export interface LaneConfig {
  /** Agent id this lane routes to. */
  agentId: string;
  /** Keywords matched with a leading word boundary + prefix expansion (SPEC §11). */
  keywords: string[];
}

export type ProfileMode = 'strict' | 'permissive';
export type PermissionDefaultMode = 'ask' | 'allow' | 'deny' | 'bypassPermissions';
export type PrivilegeLevel = 0 | 1 | 2 | 3;

/**
 * Global default permission posture (FIX-agent-permissions-permissive). The
 * sellability knob for the default prompt behavior of CAUTIOUS profiles:
 *  - 'permissive' (this operator's default): a profile whose fallback is 'ask'
 *    runs without interactive prompts (bypassPermissions) so a dispatched
 *    sub-agent never wedges at a Bash prompt — deny rules are STILL enforced
 *    (deny > everything), so dangerous ops stay blocked.
 *  - 'ask': cautious profiles keep prompting (a buyer who wants stricter posture).
 * It never relaxes deny, and never touches a profile with an explicit
 * allow/deny/bypassPermissions defaultMode.
 */
export type DefaultPermissionPosture = 'permissive' | 'ask';

export interface SecurityProfileConfig {
  id: string;
  label: string;
  mode: ProfileMode;
  defaultMode?: PermissionDefaultMode;
  /** 0 sandbox · 1 draft/read-only · 2 trusted-build (spawn ceiling) · 3 full-host (pre-seeded only). */
  privilegeLevel: PrivilegeLevel;
  /** Rule strings like "Bash(npm run *)" or "Read({AGENT_DIR}/**)" — placeholders resolved per agent. */
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface ChannelTelegramConfig {
  enabled: boolean;
  /** Vault indirection ("vault:<id>") — never a plaintext token (SPEC §16). */
  tokenRef: string;
  /** Operator chat id (numeric string); the reserved operator identity binds here. */
  operatorChatId?: string;
}

export interface ChannelSlackConfig {
  enabled: boolean;
  /** Vault indirection for the Slack bot token (xoxb-…). Never plaintext. */
  botTokenRef: string;
  /** Vault indirection for the Slack app-level token (xapp-…) used by Socket Mode. */
  appTokenRef: string;
  /** Stable workspace/team id — the one-connection-per-workspace guard key. */
  teamId?: string;
  /** Operator channel id; the reserved operator identity binds here. */
  operatorChatId?: string;
}

export interface ChannelDiscordConfig {
  enabled: boolean;
  /** Vault indirection for the Discord bot token. Never plaintext. */
  botTokenRef: string;
  /** Stable application/bot id — the one-connection-per-app guard key. */
  applicationId?: string;
  /** Operator channel id; the reserved operator identity binds here. */
  operatorChatId?: string;
}

/**
 * Customer-service email connector (#118). Per-instance SINGLE-tenant: the connector
 * reads only THIS instance's mailbox (creds in this instance's vault), never routing
 * across instances. enabled=false is the DORMANT default — the connector does nothing
 * until the operator turns it on after roll-up. Host/port are plain (not secret);
 * user/pass are vault refs (mailcow: user == fromAddress, pass == the mailbox password).
 * Per the RELAY #200 contract: IMAPS 993 / SMTPS 465, implicit TLS, mandatory cert-verify.
 */
export interface ChannelEmailConfig {
  enabled: boolean;
  /** The mailbox address replies are sent from (e.g. cs-<tenant>@example.com). */
  fromAddress: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** Vault indirections for the mailbox credentials. Never plaintext. */
  imapUserRef: string;
  imapPasswordRef: string;
  smtpUserRef: string;
  smtpPasswordRef: string;
  /** Inbound poll interval (seconds). Default 60. */
  pollSeconds?: number;
}

export interface ChannelsConfig {
  telegram?: ChannelTelegramConfig;
  slack?: ChannelSlackConfig;
  discord?: ChannelDiscordConfig;
  email?: ChannelEmailConfig;
}

export interface TenantConfig {
  /** Stable tenant slug (SIGMA tenant-manifest #179), e.g. duna_webaruhaz_kft. */
  companyKey: string;
}

export interface SchedulerConfig {
  /** Catch-up window (minutes) on a normal tick. */
  catchupWindowMinutes: number;
  /** Longer window used for the first tick after a restart (SPEC §9). */
  bootCatchupWindowMinutes: number;
  retryIntervalMinutes: number;
  /**
   * Seconds inserted BETWEEN sequential fan-out deliveries of a target:'all' task
   * (heartbeat, board-supervisor). Without it the whole roster starts its turn at nearly
   * the same instant — ~14 Opus agents hitting the subscription at once tripped the
   * 2026-06-18 server-side rate-limit pulses. Default 10. 0 disables it (legacy immediate
   * fan-out). Applies ONLY when a task has >1 target; never delays a single-target task,
   * the first delivery, or anything after the last. OPERATIONAL BOUND: keep
   * (roster size * stagger) safely below the shortest fan-out task's cron cadence so a
   * fan-out always finishes before the same task fires again (e.g. 17 * 10s = 170s is far
   * below the 900s board-supervisor cadence of one fire every 15 minutes).
   */
  fanoutStaggerSeconds?: number;
  /** Off-switch for the nightly auto-digest seed (PROMPT-09 §6C). Default on; set false to disable. */
  autoDigest?: boolean;
  /**
   * Master off-switch for the background learning-loop seed tasks (heartbeat,
   * nightly dream, board-supervisor, cross-agent sync, morning brief, digest).
   * Default on. Set false for low-resource / rate-limited product installs (the
   * kkv-base profile, #104) where an idle machine must not burn the subscription
   * quota on a 30-minute heartbeat fan-out. When false NO learning-loop tasks are
   * seeded; the own fleet (omitted = on) is unchanged.
   */
  learningLoop?: boolean;
}

/**
 * Hub-recovery watchdog tuning (#86). All fields optional — omitted ones fall back to
 * DEFAULT_SESSION_RECOVERY_THRESHOLDS. Kept config-driven so an ORACLE backoff/marker
 * finding (#87) folds in without a code change.
 */
export interface HubRecoveryConfig {
  transientGraceMs?: number;
  hardWedgeMs?: number;
  authGraceMs?: number;
  backoffMs?: number[];
  maxRestarts?: number;
  /** Random ± fraction on each backoff step (thundering-herd guard, #87). */
  jitterFraction?: number;
  /** Extra transient API/network error regex SOURCES, OR'd with the built-in marker set. */
  transientMarkers?: string[];
}

/**
 * Context-window auto-compact (#296): proactively inject /compact into a heavy-but-idle session BEFORE its
 * context window fills and it wedges ("No response from API · Retrying") -- a wedged HUB halts dispatch and
 * stalls the fleet (2026-06-20 incident). OPT-IN (OFF by default, like agentRecovery #175): the operator
 * enables it (or the seed config does for a fresh install) and tunes the trigger. The threshold is window-
 * RELATIVE (a fraction of the model's own window) so it works across the mixed 1M/200k fleet.
 */
export interface AutoCompactConfig {
  /** Master switch. Default ON (#373: opt-OUT) when the runtime wired the I/O callbacks; set false to disable. */
  enabled?: boolean;
  /** Inject /compact when context tokens reach this fraction of the model's window (0..1). Default 0.75
   *  (#336: tightened from 0.85 for retry-on-drop headroom before a busy session reaches 100%). */
  thresholdFraction?: number;
  /** Anti-thrash floor: never inject twice within this window (ms). Default 10min. */
  minIntervalMs?: number;
}

/**
 * Non-hub auto-recovery (#175). The HUB is always recovered (the SPOF watchdog, tuned by
 * hubRecovery above); this extends the SAME conservative state machine to non-hub agents.
 * It is an above-sandbox automated capability, so it is OFF by default — the operator
 * opts in. Thresholds are shared with hubRecovery (same grace/backoff/cap/jitter); this
 * block only carries the fleet switches.
 */
export interface AgentRecoveryConfig {
  /** Master switch for NON-HUB recovery. Default false (dormant) — the hub is unaffected. */
  enabled?: boolean;
  /** Max resume-restart dispatches per tick across the whole fleet (rate-spacer). Default 1. */
  concurrencyCap?: number;
  /** Per-agent override map; set `{ enabled: false }` to exclude a specific agent. */
  perAgent?: Record<string, { enabled?: boolean }>;
}

export interface AutonomyCategorySeed {
  category: string;
  level: 1 | 2 | 3;
  maxLevel: 1 | 2 | 3;
  locked: boolean;
}

export interface RuntimeConfig {
  /** Reference adapter id; 'fake' exists for tests/dev. */
  adapter: 'claude-code' | 'fake';
  claude: {
    command: string;
    /** Seconds between staggered reconciler starts (SPEC §3). */
    staggerSeconds: number;
    /** tmux session name prefix (brand-neutral default). */
    sessionPrefix: string;
    /**
     * Dedicated tmux server socket BASE name (SPEC §3a/§19a). The fleet runs on its
     * OWN tmux server, isolated from the operator's default-server sessions. Defaults
     * to the sessionPrefix when absent.
     *
     * NOTE (#190): this is only the BASE name. It is NOT by itself isolation from a
     * SECOND co-located fleet — two installs with the same socket name on one host
     * would share the same tmux server. main.ts therefore suffixes this with the
     * per-instance id (derived from the state-dir) so each install gets a UNIQUE
     * socket; the primary install (~/.orchestrator) keeps this name verbatim.
     */
    socket?: string;
  };
}

export interface CsConfig {
  /** Auto-send plain CS replies (demo tenants) instead of the gated draft+approval. Default false. */
  autoReply?: boolean;
  /**
   * #399 owner-notification (KKV product). When true, the OWNER (operator channel + dashboard CS badge)
   * is alerted on a NEW inbound customer ticket and when the bot ESCALATES to a human (a CS approval is
   * raised). ABSENT/false on the own fleet => no owner spam. Set true by the kkv-base provisioning profile.
   * Pushes are PII-safe pointers (ticket id only, never the message body). Default false.
   */
  notifyOwner?: boolean;
}

/** One tenant the accountant portal aggregates (#261). */
export interface PortalTenantConfig {
  /** Stable portal-side routing key (e.g. 't1'); the ONLY tenant selector the client sends. */
  key: string;
  /** SIGMA tenant-manifest slug for labeling/audit (e.g. 'kezmu_pekseg_bt'). */
  companyKey: string;
  /** Human display name (cég-váltó tab + áttekintő). */
  displayName: string;
  /** The tenant instance base URL (e.g. 'http://127.0.0.1:7081'); the portal calls <baseUrl>/api/<module>/*. */
  baseUrl: string;
  /** Vault ref for THAT tenant's bookkeeper agent token (least-privilege; never the operator bearer). */
  bookkeeperTokenRef: string;
}

/**
 * Accountant portal (#261). PRESENT only on a dedicated portal instance; ABSENT on tenants
 * and the own fleet. The portal is a TRUSTED CROSS-TENANT CLIENT: it authenticates to each
 * tenant's /api/<module>/* with that tenant's own scoped credential (resolved from the vault,
 * never exposed to the browser). No co-mingled DB; each tenant stays a separate instance.
 */
export interface PortalConfig {
  tenants: PortalTenantConfig[];
  /** Per-tenant outbound call timeout (ms); a never-responding tenant must not stall the portal. */
  timeoutMs?: number;
}

export interface OrchestratorConfig {
  branding: BrandingConfig;
  locale: LocaleConfig;
  timezone: string;
  server: ServerConfig;
  hubId: string;
  agents: AgentConfig[];
  lanes: LaneConfig[];
  securityProfiles: SecurityProfileConfig[];
  channels: ChannelsConfig;
  /**
   * Tenant identity for the per-instance deployment (#118/#179). ABSENT for the own
   * fleet. Provisioning stamps company_key (a stable SIGMA tenant-manifest slug); it
   * is used for labeling/audit, NEVER for runtime routing (the tenant is fixed by the
   * deployment — one instance = one tenant).
   */
  tenant?: TenantConfig;
  /**
   * Customer-service behaviour (#236). ABSENT/`autoReply:false` on the main fleet => the
   * SAFE gated CS reply (draft + channel approval, support.md A2). A DEMO tenant sets
   * `autoReply:true` to let the customer-facing agent send plain replies directly in real
   * time (the cs_* store is the audit; money/data-delete stay approval-gated regardless).
   */
  cs?: CsConfig;
  /** Accountant portal aggregator config (#261). PRESENT only on a dedicated portal instance. */
  portal?: PortalConfig;
  scheduler: SchedulerConfig;
  autonomySeed: AutonomyCategorySeed[];
  runtime: RuntimeConfig;
  /** Hub-recovery watchdog tuning (#86); all optional — omitted fields use built-in defaults. */
  hubRecovery?: HubRecoveryConfig;
  /** Non-hub auto-recovery (#175); OFF by default, the hub is recovered regardless. */
  agentRecovery?: AgentRecoveryConfig;
  /** Context-window auto-compact (#296/#373) — fleet-wide wedge-prevention; ON by default (opt-OUT), operator-tunable. */
  autoCompact?: AutoCompactConfig;
  /** Model alias map — short alias → backend model id (SPEC §5). */
  modelAliases: Record<string, string>;
  /** Billing mode (FIX-billing-api-optin) — default subscription; api is opt-in only. */
  billing: BillingConfig;
  /** Enabled orchestrator extension plugins (FIX-plugins) — none run unless listed. */
  plugins?: PluginsConfig;
  /**
   * Management-plane hooks for the sellable product instance (#106). ABSENT for the
   * own fleet => every hook dormant. Per-machine, content-free, no-shared-key by design.
   */
  management?: ManagementConfig;
  /**
   * Default permission posture for cautious profiles (FIX-agent-permissions-permissive).
   * Defaults to 'permissive' (no prompt-wedging sub-agents; deny still enforced).
   */
  defaultPermissionMode?: DefaultPermissionPosture;
  /**
   * The product seed-profile this instance was installed with (#129), e.g.
   * 'kkv-base'. Persisted at install (installSeedConfig) so a later additive
   * seed-roster migration (migrateSeedRoster) can re-apply that profile's
   * visibility overlay to NEWLY propagated agents. ABSENT for the own fleet
   * (no profile => no hide => additive agents are visible, as before).
   */
  installedProfile?: string;
}

/** Which orchestrator extension plugins the operator has enabled (FIX-plugins Part B). */
export interface PluginsConfig {
  enabled: string[];
}

/**
 * Management-plane hooks (#106) — all OPTIONAL and OFF/absent for the own fleet.
 * These configure the sellable per-machine product instance: how it pulls updates
 * (signed/pinned), where it beats content-free health, and per-machine backup. No
 * shared keys live here; secrets (HMAC, backup key, signing public key) come from
 * the vault/settings, this only carries policy + non-secret endpoints.
 */
export interface ManagementConfig {
  /** Hardened pull-update policy (signed release + version-pin + anti-downgrade). */
  update?: {
    requireSignature?: boolean;
    pinnedVersion?: string;
    minVersion?: string;
    channel?: string;
  };
  /** Content-free outbound health beat to the operator aggregator. */
  health?: {
    enabled?: boolean;
    /** Aggregator URL (non-secret; the HMAC secret is per-machine in the vault). */
    url?: string;
    intervalMinutes?: number;
    /**
     * Opaque per-machine id ('m-' + UUIDv4), assigned by RELAY at provisioning. Plaintext
     * (it is the wire payload's machine_id) and NOT customer-derived. The boot only READS
     * it; absence makes the beat dormant. The per-machine HMAC secret lives in the vault
     * under 'health-webhook-key' (one health key per machine).
     */
    machineId?: string;
  };
  /** Per-machine encrypted backup with crypto-erasure. */
  backup?: {
    enabled?: boolean;
    /** Where the encrypted blob is written/shipped (non-secret; the key lives off-machine). */
    destination?: string;
  };
}

/**
 * Billing mode. `subscription` (default) = shared Max OAuth, NO API key ever
 * injected; `api` = pay-as-you-go via the operator's vault `anthropic_api_key`.
 * The ONLY writer is the explicit operator toggle; nothing flips it automatically
 * (not on quota exhaustion, not on error/retry, not via any env var).
 */
export interface BillingConfig {
  mode: 'subscription' | 'api';
}

/** Resolved install paths derived from the state dir — not stored in config. */
export interface StatePaths {
  stateDir: string;
  configFile: string;
  dbFile: string;
  bearerFile: string;
  masterKeyFile: string;
  lockFile: string;
  agentsDir: string;
  skillsGlobalDir: string;
  logsDir: string;
}
