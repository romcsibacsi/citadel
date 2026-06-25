// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { OrchestratorConfig, StatePaths } from '../config/types.js';
import type { I18n } from '../i18n/index.js';
import { sanitizeId } from '../trust/sanitize.js';
import type { RouteContext as MessagingRouteContext } from '../messaging/route.js';
import type { MessageStore } from '../messaging/store.js';
import type { DeliveryService } from '../messaging/delivery.js';
import type { MemoryStore } from '../memory/store.js';
import type { ConversationLedger } from '../memory/ledger.js';
import type { SchedulerService } from '../scheduler/runner.js';
import type { ScheduledTaskStore } from '../scheduler/taskStore.js';
import type { KanbanStore } from '../kanban/store.js';
import type { ModuleRegistry } from '../boundary/module/registry.js';
import type { ChannelBindingStore } from '../channels/bindings.js';
import type { IdeaStore } from '../ideas/store.js';
import type { PanelService } from '../judge/service.js';
import type { BackgroundTaskService } from '../background/service.js';
import type { ConnectorService } from '../connectors/service.js';
import type { TokenUsageStore } from '../tokens/store.js';
import type { SettingsStore } from '../settings/store.js';
import type { UpdateService } from '../updates/service.js';
import type { DivergenceMonitor } from '../updates/divergence.js';
import type { StudioService } from '../studio/service.js';
import type { FilesService } from '../files/service.js';
import type { ActivityMonitor } from '../activity/monitor.js';
import type { ActivitySampler } from '../server/activitySampler.js';
import type { AutonomyLadder } from '../autonomy/ladder.js';
import type { SkillStore } from '../skills/store.js';
import type { PluginHost } from '../plugins/host.js';
import type { CoreToolRegistry, CoreToolContext } from '../tools/coreTools.js';
import type { VaultStore } from '../vault/store.js';
import type { AgentSupervisor } from '../runtime/supervisor.js';
import type { DesiredStateStore, Reconciler } from '../runtime/reconciler.js';
import type { AgentWorktreeManager } from '../runtime/gitWorktree.js';
import type { TelegramChannel } from '../channels/telegram.js';
import type { SlackChannel } from '../channels/slack.js';
import type { DiscordChannel } from '../channels/discord.js';
import { atomicWriteFile } from '../core/fsx.js';

/** Everything the API routes and background services share. */
export interface AppContext {
  config: OrchestratorConfig;
  paths: StatePaths;
  db: DatabaseSync;
  i18n: I18n;
  version: string;
  messages: MessageStore;
  delivery: DeliveryService;
  memory: MemoryStore;
  ledger: ConversationLedger;
  scheduler: SchedulerService;
  taskStore: ScheduledTaskStore;
  kanban: KanbanStore;
  channelBindings: ChannelBindingStore;
  ideas: IdeaStore;
  /**
   * #386 FÁZIS-0 seam-inversion: the registered runtime module packs (twin of PolicyRegistry).
   * EMPTY in the public core => default-deny by absence (no vertical stores, no vertical routes).
   * kkv-main registers the accounting ModulePack (cs/bk/nav/engines/portal).
   */
  modules: ModuleRegistry;
  /**
   * The merged store bag from every pack's makeStores(db), keyed by the vertical's OWN names
   * (cs/bk/navStore/bkSimplified/bkDouble/portalAudit/portalFetch). The core types it opaquely
   * (Record<string, unknown>); only the vertical's relocated route modules re-narrow the keys
   * (cast-and-throw via src/modules/accounting/moduleKeys.ts).
   */
  moduleStores: Record<string, unknown>;
  /** NEXUS judge-panel orchestration (BUILD-judge-panel). */
  panels: PanelService;
  background: BackgroundTaskService;
  connectors: ConnectorService;
  tokens: TokenUsageStore;
  settings: SettingsStore;
  updates: UpdateService;
  /** Deploy-checkout divergence monitor (#88) — non-blocking local-vs-origin warning. */
  divergence: DivergenceMonitor;
  studio: StudioService;
  files: FilesService;
  activity: ActivityMonitor;
  /** Background fleet-activity sampler: precomputes the Activity board off the request path. */
  activitySampler: ActivitySampler;
  autonomy: AutonomyLadder;
  skills: SkillStore;
  pluginHost: PluginHost;
  /** Host-owned CORE agent-tool registry (browse / render_chart+render_diagram / transcribe).
   *  Consulted by the /api/agent-tools route alongside pluginHost, behind the same gate. */
  coreTools: CoreToolRegistry;
  /** Build the rich context a CORE tool runs with (Files/settings/runner/vault/fetch + the
   *  images root) for one requesting agent. NEVER exposes saveConfig/billing/token/spawn. */
  buildCoreToolContext(agentId: string): CoreToolContext;
  vault: VaultStore;
  supervisor: AgentSupervisor;
  desired: DesiredStateStore;
  reconciler: Reconciler;
  /** Per-agent git worktree isolation (#44). */
  agentWorktrees: AgentWorktreeManager;
  telegram?: TelegramChannel;
  slack?: SlackChannel;
  discord?: DiscordChannel;
  /** agentId -> scoped API token (loaded from per-agent token files). */
  agentTokens: Map<string, string>;
  /** Ids of the committed seed roster — these agents are never deletable. */
  seedAgentIds: ReadonlySet<string>;
  /** Persist a config mutation atomically and refresh the in-memory copy. */
  saveConfig(mutate: (cfg: OrchestratorConfig) => void): void;
  /** Send a localized message to the operator channel (no-op when unbound). */
  notifyOperator(text: string): Promise<void>;
  /** Idempotent per-agent scaffolding (dirs, docs, token) — never overwrites. */
  scaffoldAgent(agentId: string): void;
  /** Deliberate re-seed: overwrite auto-generated doc stubs, preserve operator edits. */
  reseedAgentDocs(): { changed: string[]; preserved: string[] };
  /** Deliberate re-seed of each agent's settings.json from its profile + the global posture. */
  reseedAgentSettings(): { changed: string[]; preserved: string[] };
  /** Compose the workdir CLAUDE.md from a (possibly edited) persona + operating doc + tools. */
  composeAgentClaude(agentId: string, parts: { persona: string; operating?: string }): string;
}

/** Live snapshot of the roster for the messaging route decision. */
export function buildMessagingRouteContext(config: OrchestratorConfig): MessagingRouteContext {
  const known = new Set<string>();
  const hidden = new Set<string>();
  for (const agent of config.agents) {
    const id = sanitizeId(agent.id);
    if (id === '') continue;
    known.add(id);
    if (agent.hidden === true) hidden.add(id);
  }
  return {
    knownAgentIds: known,
    hiddenAgentIds: hidden,
    hubId: sanitizeId(config.hubId),
    mediaAgentIds: new Set<string>(),
  };
}

export function agentDir(paths: StatePaths, agentId: string): string {
  return join(paths.agentsDir, sanitizeId(agentId));
}

export function persistConfig(paths: StatePaths, config: OrchestratorConfig): void {
  atomicWriteFile(paths.configFile, JSON.stringify(config, null, 2) + '\n', 0o600);
}

/** Reserved/seed roster ids are never deletable (SPEC §4). */
export function isSeedAgent(config: OrchestratorConfig, agentId: string, seedIds: ReadonlySet<string>): boolean {
  const id = sanitizeId(agentId);
  return seedIds.has(id) || id === sanitizeId(config.hubId);
}
