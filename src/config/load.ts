// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTextIfExists } from '../core/fsx.js';
import { createLogger } from '../core/log.js';
import { defaultConfig } from './defaults.js';
import { isReservedId } from '../trust/sanitize.js';
import type { AgentConfig, OrchestratorConfig, SecurityProfileConfig, StatePaths } from './types.js';

const log = createLogger('config');

export const STATE_DIR_ENV = 'ORCHESTRATOR_STATE_DIR';

/** The security profile that, on its own, marks an agent customer-facing (fail-closed). */
export const CUSTOMER_FACING_PROFILE = 'customer-service';

/**
 * The set of agent ids treated as customer-facing for isolation enforcement (#115/#117,
 * gate R5a — FAIL-CLOSED). An agent counts as customer-facing if it EITHER sets
 * `customerFacing: true` OR carries the customer-service security profile. Deriving from
 * the profile means a provisioning that forgets the flag still gets the guard (the flag
 * absence can never fail-open into a shared-write leak).
 */
export function customerFacingAgentIds(agents: ReadonlyArray<AgentConfig>): Set<string> {
  const out = new Set<string>();
  for (const a of agents) {
    if (a.customerFacing === true || a.securityProfile === CUSTOMER_FACING_PROFILE) out.add(a.id);
  }
  return out;
}

/**
 * Security profiles whose agents hold sensitive store-data that must NEVER reach agent
 * memory: customer-service (end-customer PII -> cs_* store) and bookkeeper (company
 * financial data -> bk_* store). The same enforce-not-instruct invariant in both cases.
 */
export const MEMORY_ISOLATED_PROFILES: readonly string[] = [CUSTOMER_FACING_PROFILE, 'bookkeeper'];

/**
 * The set of agent ids barred from writing to ANY memory tier (#124d, generalising the
 * #115/#120 customer-facing all-tier block — FAIL-CLOSED). An agent counts as
 * memory-isolated if it sets `customerFacing: true` OR carries a MEMORY_ISOLATED_PROFILES
 * profile. Deriving from the profile means a provisioning that forgets a flag still gets
 * the guard — sensitive data can never fail-open into a memory/shared leak. The data lives
 * ONLY in the agent's scoped store (cs_* / bk_*) + the vault, never in memory.
 */
export function memoryIsolatedAgentIds(agents: ReadonlyArray<AgentConfig>): Set<string> {
  const out = new Set<string>();
  for (const a of agents) {
    if (a.customerFacing === true || MEMORY_ISOLATED_PROFILES.includes(a.securityProfile)) out.add(a.id);
  }
  return out;
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[STATE_DIR_ENV];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.orchestrator');
}

export function resolvePaths(stateDir: string): StatePaths {
  return {
    stateDir,
    configFile: join(stateDir, 'config.json'),
    dbFile: join(stateDir, 'orchestrator.db'),
    bearerFile: join(stateDir, 'dashboard-token'),
    masterKeyFile: join(stateDir, 'master.key'),
    lockFile: join(stateDir, 'supervisor.lock'),
    agentsDir: join(stateDir, 'agents'),
    skillsGlobalDir: join(stateDir, 'skills'),
    logsDir: join(stateDir, 'logs'),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function mergeAgent(raw: unknown): AgentConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return undefined;
  // a config entry whose id sanitizes to a reserved identity would let its
  // agent token self-stamp a privileged trust tier — refuse it at load time
  if (isReservedId(id)) {
    log.error(`agent id "${id}" sanitizes to a reserved identity and was dropped from the roster`);
    return undefined;
  }
  const team = isRecord(raw.team) ? raw.team : {};
  const channel = isRecord(raw.channel)
    ? { provider: str(raw.channel.provider, ''), ...(typeof raw.channel.chatId === 'string' ? { chatId: raw.channel.chatId } : {}) }
    : null;
  const agent: AgentConfig = {
    id,
    displayName: str(raw.displayName, id),
    role: str(raw.role, 'Specialist'),
    securityProfile: str(raw.securityProfile, 'draft'),
    accentColor: str(raw.accentColor, '#888888'),
    authMode: raw.authMode === 'own-credentials' || raw.authMode === 'api-key' ? raw.authMode : 'shared-subscription',
    channel: channel && channel.provider !== '' ? channel : null,
    team: {
      role: str(team.role, 'specialist'),
      ...(typeof team.reportsTo === 'string' ? { reportsTo: team.reportsTo } : {}),
      delegatesTo: strArray(team.delegatesTo),
      trustFrom: strArray(team.trustFrom),
      ...(typeof team.autoDelegation === 'boolean' ? { autoDelegation: team.autoDelegation } : {}),
    },
  };
  if (typeof raw.model === 'string') agent.model = raw.model;
  if (raw.runtime === 'ollama' || raw.runtime === 'claude') agent.runtime = raw.runtime;
  if (typeof raw.configRoot === 'string') agent.configRoot = raw.configRoot;
  if (typeof raw.strictTools === 'boolean') agent.strictTools = raw.strictTools;
  if (typeof raw.hidden === 'boolean') agent.hidden = raw.hidden;
  if (typeof raw.customerFacing === 'boolean') agent.customerFacing = raw.customerFacing;
  if (typeof raw.dormant === 'boolean') agent.dormant = raw.dormant;
  if (typeof raw.productVisible === 'boolean') agent.productVisible = raw.productVisible;
  if (isRecord(raw.lifecycle)) {
    agent.lifecycle = {
      ephemeral: bool(raw.lifecycle.ephemeral, false),
      closed: bool(raw.lifecycle.closed, false),
      ...(typeof raw.lifecycle.doneWhen === 'string' ? { doneWhen: raw.lifecycle.doneWhen } : {}),
      ...(typeof raw.lifecycle.deadline === 'string' ? { deadline: raw.lifecycle.deadline } : {}),
    };
  }
  return agent;
}

/**
 * Merge a parsed JSON value over the safe defaults. Tolerant by contract
 * (SPEC §4): malformed sections fall back to defaults, never throw.
 */
export function mergeConfig(raw: unknown): OrchestratorConfig {
  const base = defaultConfig();
  if (!isRecord(raw)) return base;

  if (isRecord(raw.branding)) {
    base.branding = {
      productName: str(raw.branding.productName, base.branding.productName),
      ...(typeof raw.branding.tagline === 'string' ? { tagline: raw.branding.tagline } : {}),
    };
  }
  if (isRecord(raw.locale)) {
    base.locale = {
      default: str(raw.locale.default, base.locale.default),
      agentProse: str(raw.locale.agentProse, str(raw.locale.default, base.locale.agentProse)),
    };
  }
  base.timezone = str(raw.timezone, base.timezone);
  if (isRecord(raw.server)) {
    base.server = {
      host: str(raw.server.host, base.server.host),
      port: num(raw.server.port, base.server.port),
      allowedOrigins: strArray(raw.server.allowedOrigins),
    };
  }
  base.hubId = str(raw.hubId, base.hubId);
  if (typeof raw.installedProfile === 'string' && raw.installedProfile.trim() !== '') {
    base.installedProfile = raw.installedProfile;
  }

  if (Array.isArray(raw.agents)) {
    const agents = raw.agents.map(mergeAgent).filter((a): a is AgentConfig => a !== undefined);
    if (agents.length > 0) base.agents = agents;
  }
  if (!base.agents.some((a) => a.id === base.hubId)) {
    log.warn(`hub agent "${base.hubId}" missing from roster; keeping roster but hub features will be degraded`);
  }

  if (Array.isArray(raw.lanes)) {
    base.lanes = raw.lanes
      .filter(isRecord)
      .map((l) => ({ agentId: str(l.agentId, ''), keywords: strArray(l.keywords) }))
      .filter((l) => l.agentId !== '' && l.keywords.length > 0);
  }

  if (Array.isArray(raw.securityProfiles) && raw.securityProfiles.length > 0) {
    const profiles = raw.securityProfiles.filter(isRecord).map((p) => {
      const defaultMode: SecurityProfileConfig['defaultMode'] =
        p.defaultMode === 'ask' || p.defaultMode === 'allow' || p.defaultMode === 'deny' || p.defaultMode === 'bypassPermissions'
          ? p.defaultMode
          : undefined;
      return {
        id: str(p.id, ''),
        label: str(p.label, str(p.id, '')),
        mode: p.mode === 'permissive' ? ('permissive' as const) : ('strict' as const),
        ...(defaultMode !== undefined ? { defaultMode } : {}),
        privilegeLevel: (p.privilegeLevel === 0 || p.privilegeLevel === 1 || p.privilegeLevel === 2 || p.privilegeLevel === 3
          ? p.privilegeLevel
          : 1) as 0 | 1 | 2 | 3,
        allow: strArray(p.allow),
        ask: strArray(p.ask),
        deny: strArray(p.deny),
      };
    });
    const valid = profiles.filter((p) => p.id !== '');
    if (valid.length > 0) base.securityProfiles = valid;
  }

  if (isRecord(raw.channels)) {
    base.channels = {};
    if (isRecord(raw.channels.telegram)) {
      base.channels.telegram = {
        enabled: bool(raw.channels.telegram.enabled, false),
        tokenRef: str(raw.channels.telegram.tokenRef, ''),
        ...(typeof raw.channels.telegram.operatorChatId === 'string'
          ? { operatorChatId: raw.channels.telegram.operatorChatId }
          : {}),
      };
    }
    if (isRecord(raw.channels.slack)) {
      base.channels.slack = {
        enabled: bool(raw.channels.slack.enabled, false),
        botTokenRef: str(raw.channels.slack.botTokenRef, ''),
        appTokenRef: str(raw.channels.slack.appTokenRef, ''),
        ...(typeof raw.channels.slack.teamId === 'string' ? { teamId: raw.channels.slack.teamId } : {}),
        ...(typeof raw.channels.slack.operatorChatId === 'string' ? { operatorChatId: raw.channels.slack.operatorChatId } : {}),
      };
    }
    if (isRecord(raw.channels.discord)) {
      base.channels.discord = {
        enabled: bool(raw.channels.discord.enabled, false),
        botTokenRef: str(raw.channels.discord.botTokenRef, ''),
        ...(typeof raw.channels.discord.applicationId === 'string' ? { applicationId: raw.channels.discord.applicationId } : {}),
        ...(typeof raw.channels.discord.operatorChatId === 'string' ? { operatorChatId: raw.channels.discord.operatorChatId } : {}),
      };
    }
    if (isRecord(raw.channels.email)) {
      const e = raw.channels.email;
      base.channels.email = {
        enabled: bool(e.enabled, false), // DORMANT default
        fromAddress: str(e.fromAddress, ''),
        imapHost: str(e.imapHost, ''),
        imapPort: num(e.imapPort, 993),
        smtpHost: str(e.smtpHost, ''),
        smtpPort: num(e.smtpPort, 465),
        imapUserRef: str(e.imapUserRef, ''),
        imapPasswordRef: str(e.imapPasswordRef, ''),
        smtpUserRef: str(e.smtpUserRef, ''),
        smtpPasswordRef: str(e.smtpPasswordRef, ''),
        ...(e.pollSeconds !== undefined ? { pollSeconds: num(e.pollSeconds, 60) } : {}),
      };
    }
  }

  if (isRecord(raw.tenant) && typeof raw.tenant.companyKey === 'string') {
    base.tenant = { companyKey: raw.tenant.companyKey };
  }

  if (isRecord(raw.cs)) {
    base.cs = {
      autoReply: bool(raw.cs.autoReply, false), // demo-tenant CS auto-reply (#236); default gated
      notifyOwner: bool(raw.cs.notifyOwner, false), // #399 KKV owner-notify; default off (no own-fleet spam)
    };
  }

  if (isRecord(raw.portal) && Array.isArray(raw.portal.tenants)) {
    // Accountant portal (#261): the per-tenant registry. Only fully-specified tenants survive
    // (a key + a baseUrl + a credential ref are mandatory); a malformed entry is dropped, never
    // half-configured (a tenant with no cred ref would never authenticate anyway).
    const tenants = raw.portal.tenants
      .filter(isRecord)
      .map((t) => ({
        key: str(t.key, ''),
        companyKey: str(t.companyKey, ''),
        displayName: str(t.displayName, ''),
        baseUrl: str(t.baseUrl, '').replace(/\/+$/, ''),
        bookkeeperTokenRef: str(t.bookkeeperTokenRef, ''),
      }))
      .filter((t) => t.key !== '' && t.baseUrl !== '' && t.bookkeeperTokenRef !== '');
    if (tenants.length > 0) {
      base.portal = { tenants, timeoutMs: num(raw.portal.timeoutMs, 8000) };
    }
  }

  if (isRecord(raw.scheduler)) {
    base.scheduler = {
      catchupWindowMinutes: num(raw.scheduler.catchupWindowMinutes, base.scheduler.catchupWindowMinutes),
      bootCatchupWindowMinutes: num(raw.scheduler.bootCatchupWindowMinutes, base.scheduler.bootCatchupWindowMinutes),
      retryIntervalMinutes: num(raw.scheduler.retryIntervalMinutes, base.scheduler.retryIntervalMinutes),
      // sequential fan-out stagger (#194); default to the base (10s)
      fanoutStaggerSeconds: num(raw.scheduler.fanoutStaggerSeconds, base.scheduler.fanoutStaggerSeconds ?? 10),
      // preserve the digest off-switch (FIX-09 §3); default to the base (on)
      autoDigest: bool(raw.scheduler.autoDigest, base.scheduler.autoDigest ?? true),
      // master off-switch for the background learning-loop seeds (#104); default on
      learningLoop: bool(raw.scheduler.learningLoop, base.scheduler.learningLoop ?? true),
    };
  }

  // Hub-recovery watchdog tuning (#86) — all optional; surfaced verbatim, the
  // watchdog merges these over its built-in defaults (omitted fields stay default).
  if (isRecord(raw.hubRecovery)) {
    const hr = raw.hubRecovery;
    const numbers = (['transientGraceMs', 'hardWedgeMs', 'authGraceMs', 'maxRestarts', 'jitterFraction'] as const).reduce<Record<string, number>>(
      (acc, k) => (typeof hr[k] === 'number' ? { ...acc, [k]: hr[k] as number } : acc),
      {},
    );
    base.hubRecovery = {
      ...numbers,
      ...(Array.isArray(hr.backoffMs) ? { backoffMs: hr.backoffMs.filter((n): n is number => typeof n === 'number') } : {}),
      ...(Array.isArray(hr.transientMarkers)
        ? { transientMarkers: hr.transientMarkers.filter((m): m is string => typeof m === 'string') }
        : {}),
    };
  }

  if (Array.isArray(raw.autonomySeed)) {
    // UNION-merge over the shipped default set, never a wholesale replace
    // (FIX-autonomy-categories §"on upgrade only ADD newly-introduced categories,
    // never reset operator-set levels"). The canonical category SET + ORDER come
    // from the defaults (autonomy categories are code-tied — a category with no
    // code behind it is meaningless), and a matching config entry overrides its
    // level/cap/lock. So: a code upgrade that adds a category surfaces even when
    // the file carries a stale seed; operator-chosen seed levels survive; and a
    // config-only / obsolete-vocabulary entry is dropped rather than stranding the
    // operator on it. (Hard-locked categories are still re-forced to 1/1/locked by
    // the ladder regardless of any override here — defence in depth.)
    const overrides = new Map<string, { level: 1 | 2 | 3; maxLevel: 1 | 2 | 3; locked: boolean }>();
    for (const s of raw.autonomySeed.filter(isRecord)) {
      const category = str(s.category, '');
      if (category === '') continue;
      overrides.set(category, {
        level: (s.level === 1 || s.level === 2 || s.level === 3 ? s.level : 1) as 1 | 2 | 3,
        maxLevel: (s.maxLevel === 1 || s.maxLevel === 2 || s.maxLevel === 3 ? s.maxLevel : 3) as 1 | 2 | 3,
        locked: bool(s.locked, false),
      });
    }
    base.autonomySeed = base.autonomySeed.map((def) => {
      const o = overrides.get(def.category);
      return o ? { category: def.category, level: o.level, maxLevel: o.maxLevel, locked: o.locked } : def;
    });
  }

  if (isRecord(raw.runtime)) {
    const claude = isRecord(raw.runtime.claude) ? raw.runtime.claude : {};
    const rawStagger = num(claude.staggerSeconds, base.runtime.claude.staggerSeconds);
    const MAX_STAGGER_SECONDS = 60;
    if (rawStagger > MAX_STAGGER_SECONDS) {
      log.warn(`staggerSeconds ${rawStagger} exceeds cap ${MAX_STAGGER_SECONDS}; clamped (roster*stagger overrun risk)`, { rawStagger, cap: MAX_STAGGER_SECONDS });
    }
    base.runtime = {
      adapter: raw.runtime.adapter === 'fake' ? 'fake' : 'claude-code',
      claude: {
        command: str(claude.command, base.runtime.claude.command),
        staggerSeconds: Math.max(1, Math.min(rawStagger, MAX_STAGGER_SECONDS)),
        sessionPrefix: str(claude.sessionPrefix, base.runtime.claude.sessionPrefix),
        ...(typeof claude.socket === 'string' && claude.socket.trim() !== ''
          ? { socket: claude.socket }
          : {}),
      },
    };
  }

  if (isRecord(raw.modelAliases)) {
    const aliases: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.modelAliases)) {
      if (typeof v === 'string') aliases[k] = v;
    }
    base.modelAliases = aliases;
  }

  // Billing mode (FIX-billing-api-optin): only an explicit "api" overrides the
  // subscription default — any other/absent value stays subscription (safe default).
  if (isRecord(raw.billing) && raw.billing.mode === 'api') {
    base.billing = { mode: 'api' };
  }

  // Enabled extension plugins (FIX-plugins): only string ids; absent → none enabled.
  if (isRecord(raw.plugins) && Array.isArray(raw.plugins.enabled)) {
    base.plugins = { enabled: raw.plugins.enabled.filter((x): x is string => typeof x === 'string') };
  }

  // Default permission posture (FIX-agent-permissions-permissive): only the two
  // valid values override the default; anything else keeps the safe default. This
  // explicit parse is required — mergeConfig drops top-level keys it doesn't handle.
  if (raw.defaultPermissionMode === 'permissive' || raw.defaultPermissionMode === 'ask') {
    base.defaultPermissionMode = raw.defaultPermissionMode;
  }

  // Management-plane hooks (#106): absent => undefined => every hook dormant (own
  // fleet). Only explicit, known sub-fields are surfaced (mergeConfig drops the rest).
  if (isRecord(raw.management)) {
    const m = raw.management;
    const out: NonNullable<OrchestratorConfig['management']> = {};
    if (isRecord(m.update)) {
      const u = m.update;
      out.update = {
        ...(typeof u.requireSignature === 'boolean' ? { requireSignature: u.requireSignature } : {}),
        ...(typeof u.pinnedVersion === 'string' ? { pinnedVersion: u.pinnedVersion } : {}),
        ...(typeof u.minVersion === 'string' ? { minVersion: u.minVersion } : {}),
        ...(typeof u.channel === 'string' ? { channel: u.channel } : {}),
      };
    }
    if (isRecord(m.health)) {
      const h = m.health;
      out.health = {
        ...(typeof h.enabled === 'boolean' ? { enabled: h.enabled } : {}),
        ...(typeof h.url === 'string' ? { url: h.url } : {}),
        ...(typeof h.intervalMinutes === 'number' ? { intervalMinutes: h.intervalMinutes } : {}),
      };
    }
    if (isRecord(m.backup)) {
      const b = m.backup;
      out.backup = {
        ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
        ...(typeof b.destination === 'string' ? { destination: b.destination } : {}),
      };
    }
    base.management = out;
  }

  return base;
}

/** Load the live config file, tolerating absence and malformed JSON. */
export function loadConfig(configFile: string): OrchestratorConfig {
  const text = readTextIfExists(configFile);
  if (text === undefined) {
    log.warn(`config file not found at ${configFile}; using safe defaults`);
    return defaultConfig();
  }
  try {
    return mergeConfig(JSON.parse(text));
  } catch (err) {
    log.error(`config file at ${configFile} is not valid JSON; using safe defaults`, { error: String(err) });
    return defaultConfig();
  }
}
