// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadCatalogs, I18n } from '../i18n/index.js';
import { loadConfig, resolvePaths, resolveStateDir, memoryIsolatedAgentIds } from '../config/load.js';
import type { OrchestratorConfig } from '../config/types.js';
import { DEFAULT_STUCK_THRESHOLDS } from '../config/defaults.js';
import { openDatabase, migrate } from '../db/database.js';
import { MIGRATIONS } from '../db/migrations.js';
import { createLogger, setLogLevel } from '../core/log.js';
import { assertSubscriptionSafeEnv } from '../core/billing.js';
import { ensureDir } from '../core/fsx.js';
import { PROCESS_SENTINEL, newId } from '../core/ids.js';
import { sanitizeId, OPERATOR_ID, CHANNEL_ID } from '../trust/sanitize.js';
import { MessageStore } from '../messaging/store.js';
import { DeliveryService, type AgentRunState } from '../messaging/delivery.js';
import { MemoryStore } from '../memory/store.js';
import { makeOllamaEmbeddingProvider } from '../memory/ollamaEmbedding.js';
import { PanelStore } from '../judge/store.js';
import { PanelService } from '../judge/service.js';
import { createGitGateRunner } from '../judge/gateRunner.js';
import { createAgentWorktreeManager } from '../runtime/gitWorktree.js';
import { createAuthBroker } from '../runtime/claude/authBroker.js';
import { DEFAULT_SESSION_RECOVERY_THRESHOLDS } from '../runtime/sessionRecovery.js';
import { FleetRecoveryCoordinator, type RecoveryCandidate } from '../runtime/fleetRecovery.js';
import { configureTransientMarkers } from '../runtime/claude/paneState.js';
import { ConversationLedger } from '../memory/ledger.js';
import { SchedulerService } from '../scheduler/runner.js';
import { ScheduledTaskStore } from '../scheduler/taskStore.js';
import { ensureSeedTasks, eligibleForGeneralSchedule } from '../scheduler/learning.js';
import { loadTaskState, buildResumePrompt } from '../scheduler/taskState.js';
import { KanbanStore } from '../kanban/store.js';
import { ChannelBindingStore } from '../channels/bindings.js';
import { IdeaStore } from '../ideas/store.js';
import { ModuleRegistry } from '../boundary/module/registry.js';
import { BackgroundTaskStore } from '../background/store.js';
import { BackgroundTaskService } from '../background/service.js';
import { FakeBackgroundRunner, TmuxBackgroundRunner } from '../background/runner.js';
import { ConnectorStore } from '../connectors/store.js';
import { ConnectorService } from '../connectors/service.js';
import { TokenUsageStore } from '../tokens/store.js';
import { SettingsStore } from '../settings/store.js';
import { UpdateService } from '../updates/service.js';
import { realUpdateDeps, syntheticUpdateDeps, normalizeRepo } from '../updates/deps.js';
import { DivergenceMonitor, createGitDivergenceProbe } from '../updates/divergence.js';
import { StudioService } from '../studio/service.js';
import { FilesService, defaultFileRoots } from '../files/service.js';
import { registerBuiltinTools, defaultCommandRunner, type CoreToolContext } from '../tools/coreTools.js';
import { ActivityMonitor } from '../activity/monitor.js';
import { ActivitySampler, stuckAction } from '../server/activitySampler.js';
import { autoRestartEnabled } from '../server/routes/agentConfig.js';
import { AutonomyLadder } from '../autonomy/ladder.js';
import { SkillStore, SKILL_INDEX_FILE } from '../skills/store.js';
import { writeAgentIndex } from '../skills/index.js';
import { VaultStore } from '../vault/store.js';
import { FileMasterKeyBackend } from '../vault/masterKey.js';
import { AgentSupervisor } from '../runtime/supervisor.js';
import { startHealthBeat, buildHealthSnapshot, allowHostsForUrl } from '../management/healthBeat.js';
import { assertPublicUrl } from '../tools/ssrf.js';
import { DesiredStateStore, Reconciler } from '../runtime/reconciler.js';
import { FakeAdapter } from '../runtime/fakeAdapter.js';
import { ClaudeCodeAdapter } from '../runtime/claude/adapter.js';
import { createTmuxDriver } from '../runtime/claude/tmuxDriver.js';
import type { TmuxDriver } from '../runtime/claude/tmuxDriver.js';
import { WatcherService } from '../runtime/watcherService.js';
import { contextWindowForModel } from '../runtime/watchers.js';
import { readContextTokens } from '../runtime/contextSize.js';
import type { AgentRuntimeAdapter } from '../runtime/types.js';
import { TelegramChannel } from '../channels/telegram.js';
import { SlackChannel } from '../channels/slack.js';
import { DiscordChannel } from '../channels/discord.js';
import { createDiscordGateway } from '../channels/discordGateway.js';
import type { ChannelProvider } from '../channels/provider.js';
import { TypingIndicator } from '../channels/typingIndicator.js';
import { deliverToOperator } from '../messaging/operatorReply.js';
import { InboundRouter } from '../channels/inbound.js';
import { stripSecurityTags } from '../trust/frame.js';
import { acquireSupervisorLock, releaseSupervisorLock, socketLockPath } from './lock.js';
import { deriveInstanceId, instanceName, instancePort } from './instanceId.js';
import { openTlsSocket } from '../email/socket.js';
import { ImapClient } from '../email/imapClient.js';
import { SmtpClient } from '../email/smtpClient.js';
import { EmailIngestor, type CsStoreLike } from '../email/ingest.js';
import { EmailOutbox, type OutboxCsLike } from '../email/outbox.js';
import { assertSafeField } from '../email/creds.js';
import { buildMessagingRouteContext, persistConfig, type AppContext } from './context.js';
import { agentPaths, composeAgentClaude, installSeedAgentSkills, installSeedConfig, installSeedPlugins, installSeedSkills, loadAgentToken, migrateSeedRoster, repoRoot, reseedAgentDocs, reseedAgentSettings, scaffoldAgent, scaffoldAll, seedDir } from './scaffold.js';
import { CostStore } from '../cost/store.js';
import { registerCostDashboard, mergePrices, type BillingMode, type ModelPrice, type BudgetConfig } from '../cost/view.js';
import type { AgentSource } from '../cost/rollup.js';
import { webhookBus, wireOutbound, isAgentFinishEdge } from '../webhook/events.js';
import { PluginHost } from '../plugins/host.js';
import { parseCron, cronMatchesAt } from '../scheduler/cron.js';
import { buildSpecFactory } from './specFactory.js';
import { learningLoopSeeds } from './seedTasks.js';
import { Router } from '../server/router.js';
import { registerAllRoutes, AUTH_POLICY } from '../server/routes/index.js';
import { loadOrCreateBearer } from '../server/auth.js';
import { createHttpServer } from '../server/server.js';

const log = createLogger('main');
const VERSION = '0.1.0';

/**
 * Nudge injected into the hub after the watchdog Escapes a blocking interactive
 * picker it got wedged on (FIX-telegram-hub-reply). The hub has no TTY operator,
 * so it must ask operator decisions on the channel, not in a terminal prompt.
 */
const HUB_MODAL_NUDGE =
  'Rendszerüzenet: nincs interaktív terminál-operátor a paneleden, ezért a kérdés-választó (picker) ' +
  'megakasztott — és amíg arra vársz, az operátor csatorna-üzenetei sem érnek el (holtpont). A pickert ' +
  'eldobtam (NEM választottam helyetted). Ha operátori döntés kell, KÉRDEZD A CSATORNÁN: ' +
  'agentctl msg send operator "<kérdés + számozott opciók>", majd folytasd más munkával; az operátor a ' +
  'csatornán válaszol. Soha ne blokkolj terminál-promptra.';

/**
 * Nudge injected into a NON-hub agent after the watchdog Escapes a picker it wedged
 * on (#233 runtime-net). A sub-agent has no TTY operator either, so it must escalate
 * decisions via agentctl per its operating contract, never block on a terminal prompt.
 */
const AGENT_MODAL_NUDGE =
  'Rendszerüzenet: nincs interaktív terminál-operátor a paneleden, ezért a kérdés-választó (picker) ' +
  'megakasztott. A pickert eldobtam (NEM választottam helyetted). Ha döntés vagy jóváhagyás kell, NE ' +
  'blokkolj terminál-prompton: eszkaláld a kontraktusod szerint (agentctl msg send nexus "<kérdés>", vagy ' +
  'operator ha valódi user-döntés), majd folytasd más munkával. Soha ne várj terminál-pickerre.';

/**
 * Subscription-billing invariant (SPEC §5, §20.11): one shared predicate, the
 * same denylist at boot, in the adapter and in the installer.
 */
export function assertNoApiKey(env: NodeJS.ProcessEnv = process.env): void {
  assertSubscriptionSafeEnv(env, 'supervisor startup');
}

export interface BootOptions {
  initOnly?: boolean;
  localeOverride?: string;
  /** Product seed-profile applied on first install (#104), e.g. 'kkv-base'. */
  profile?: string;
  /**
   * #386 FÁZIS-0: the registered runtime module packs. Omitted (public core) => an EMPTY
   * registry => default-deny by absence (no vertical stores/routes). kkv-main passes a
   * registry with the accounting ModulePack registered.
   */
  modules?: ModuleRegistry;
}

export async function boot(opts: BootOptions = {}): Promise<{ shutdown: () => Promise<void>; adapter?: AgentRuntimeAdapter; boundPort: number } | undefined> {
  assertNoApiKey();
  if (process.env.LOG_LEVEL === 'debug') setLogLevel('debug');

  // --- state dir + config ---
  const stateDir = resolveStateDir();
  ensureDir(stateDir, 0o700);
  const paths = resolvePaths(stateDir);
  const seeded = installSeedConfig(paths, { locale: opts.localeOverride, profile: opts.profile });
  if (seeded) {
    log.info(`installed seed config at ${paths.configFile}`);
  } else {
    // SEED-ONCE gap (#129): installSeedConfig only writes once, so a running config
    // never gains the agents/profiles a later seed introduces. Propagate the missing
    // ones additively (dormant-gated, profile-aware, backed-up). A fresh install
    // above already has everything, so this only matters on an upgrade boot.
    const roster = migrateSeedRoster(paths);
    if (roster.added.length > 0) {
      log.info('seed-roster migration added agents', { added: roster.added, profiles: roster.addedProfiles });
    }
  }
  let config: OrchestratorConfig = loadConfig(paths.configFile);

  // --- per-instance isolation (#190): default-on, derived from the state-dir ---
  // Co-located CITADEL installs on one host share GLOBAL resources (the tmux socket and
  // the HTTP port) even with different state-dirs, so the state-dir-scoped supervisor lock
  // (#187) cannot catch them — the 2026-06-18 dual-main churn. Derive a stable instance id
  // from the state-dir and use it for the tmux socket, the session prefix, and a port
  // offset, so "1 instance = 1 (state-dir, socket, port)" with NO operator config. The
  // primary install (~/.orchestrator → empty id) keeps its legacy names/port unchanged, so
  // a running fleet is never disrupted; only sibling/per-tenant state-dirs get a suffix.
  const instanceId = deriveInstanceId(stateDir);
  const serverPort = instancePort(config.server.port, instanceId, process.env.PORT);
  // The tmux socket name this instance uses (computed once here; reused by bootLocked for
  // both the socket lock below and the tmux driver). The primary install (empty id) keeps
  // the legacy socket name so its running sessions stay re-adoptable; siblings get a suffix.
  const tmuxSocket = instanceName(config.runtime.claude.socket ?? config.runtime.claude.sessionPrefix, instanceId);
  if (instanceId !== '') log.info('per-instance isolation active', { instanceId, serverPort, tmuxSocket });

  // --- supervisor singletons (skipped for pure init runs): hold ALL before booting ---
  // (a) state-dir lock + (b) tmux-socket lock (only for the real tmux runtime). The HTTP
  // port bind (c) is the third singleton, enforced later by server.listen.
  const heldLocks: string[] = [];
  if (!opts.initOnly) {
    acquireSupervisorLock(paths.lockFile);
    heldLocks.push(paths.lockFile);
    if (config.runtime.adapter !== 'fake') {
      const sockLock = socketLockPath(tmuxSocket);
      acquireSupervisorLock(sockLock, { resource: `tmux socket "${tmuxSocket}"` });
      heldLocks.push(sockLock);
    }
  }
  try {
    return await bootLocked();
  } catch (err) {
    // a failed boot (e.g. port in use) must not leave a stale lock behind
    for (const l of heldLocks) releaseSupervisorLock(l);
    throw err;
  }

  // eslint-disable-next-line no-inner-declarations
  async function bootLocked(): Promise<{ shutdown: () => Promise<void>; adapter?: AgentRuntimeAdapter; boundPort: number } | undefined> {

  // --- persistence ---
  const db = openDatabase(paths.dbFile);
  // #416 go-public separation: build the registry BEFORE migrate so each registered vertical's OWN migrations
  // (accounting ids 0016-0025) are applied right after the core-schema entries, in id order. EMPTY registry
  // (public core) => migrations()=[] => only core DDL runs (standalone, no vertical table). kkv-main's registry
  // contributes accountingMigrations, reproducing the pre-separation full 0001-0025 schema byte-for-byte.
  const modules = opts.modules ?? new ModuleRegistry();
  migrate(db, [...MIGRATIONS, ...modules.migrations()]);

  // --- i18n (backend prose) ---
  const i18n = new I18n(loadCatalogs(join(repoRoot(), 'locales')), config.locale.default);

  // --- secrets ---
  const bearerWasCreated = !existsSync(paths.bearerFile);
  const bearer = loadOrCreateBearer(paths.bearerFile);
  const masterKeyBackend = new FileMasterKeyBackend(paths.masterKeyFile);
  masterKeyBackend.load(); // materialize at install/boot (SPEC §23), not first use
  const vault = new VaultStore(db, masterKeyBackend);

  const serverUrl = `http://${config.server.host}:${serverPort}`;

  // --- scaffolding (idempotent, never overwrites) ---
  scaffoldAll({ config, paths, serverUrl });
  // Sync each agent's settings.json to its CURRENT security profile at boot, so a
  // profile change self-heals on the next restart without a manual reseed: a strict
  // profile's permissions are re-rendered, and a (now) permissive profile's leftover
  // settings.json is removed (FIX-agent-settings-sync — the recurring stuck-permission
  // cause). Operator-edited settings.json are preserved. Agents start AFTER this, so
  // they read the fresh permissions on first launch (no restart needed here).
  const settingsSync = reseedAgentSettings({ config, paths, serverUrl });
  if (settingsSync.changed.length > 0) log.info('agent settings synced to profiles at boot', { changed: settingsSync.changed });

  // --- stores ---
  const messages = new MessageStore(db);
  const ledger = new ConversationLedger(db);
  const kanban = new KanbanStore(db, undefined, {
    onDispatch: (card) => {
      webhookBus.emit('kanban.move', { cardId: card.id, to: card.status, title: card.title }); // outbound webhook (FIX-plugin-webhook)
      // dispatch-once wake (SPEC §11): no-op for human/empty/unknown/non-running
      const assignee = sanitizeId(card.assignee ?? '');
      if (assignee === '' || assignee === OPERATOR_ID) return;
      if (!config.agents.some((a) => sanitizeId(a.id) === assignee)) return;
      void (async () => {
        if (!(await supervisor.isRunning(assignee))) return;
        const text =
          `A kanban card was dispatched to you (move it with agentctl when done):\n` +
          `#${card.id} [${card.priority}] ${card.title}\n${card.description ?? ''}`;
        await supervisor.injectInput(assignee, stripSecurityTags(text, PROCESS_SENTINEL), { source: 'machine' });
      })().catch((err: unknown) => log.warn('dispatch wake failed', { card: card.id, error: String(err) }));
    },
    onCardDone: (card) => {
      webhookBus.emit('kanban.card_done', { cardId: card.id, title: card.title }); // outbound webhook (FIX-plugin-webhook)
      ideas.autoArchiveForCard(card.id);
    },
    // #399 owner-notify: when the CS bot ESCALATES to a human it raises a requiresApproval card; alert the
    // OWNER on their operator channel (demo/product-gated; reuses the existing approvals surface). The title
    // is the agent's operator-facing summary (no raw customer body). Fire-and-forget so a hiccup never throws.
    onCardCreated: (card) => {
      if (config.cs?.notifyOwner === true && card.requiresApproval) {
        void notifyOperator(`Ügyfél-ügy emberi jóváhagyásra vár (a bot eszkalált) — #${card.id}: ${card.title}`);
      }
    },
  });
  const ideas = new IdeaStore(db);
  // #386 FÁZIS-0 seam-inversion: the vertical's stores (cs/bk/nav/engines/portal) are built by
  // the registered ModulePack(s), NOT named here. The public core boots an EMPTY registry =>
  // makeStores()={} => /api/cs, /api/bk, /api/portal default-deny by absence. kkv-main registers
  // accountingModule (byte-identical construction against the same db). moduleStores is the merged,
  // vertical-keyed store bag that the relocated route modules re-narrow (moduleKeys.ts cast-and-throw).
  // (`modules` is constructed earlier, before migrate(), so the vertical's migrations run in id order.)
  const moduleStores = modules.makeStores(db);
  const backgroundStore = new BackgroundTaskStore(db);
  const connectors = new ConnectorService(new ConnectorStore(db));
  const tokens = new TokenUsageStore(db);
  const settings = new SettingsStore(db);
  wireOutbound(webhookBus, { settings, vault }); // outbound webhook event dispatch (FIX-plugin-webhook)
  // One-time migration of the legacy hyphenated comfy settings to the README §8
  // underscored keys (FIX-studio-local), so the vault panel reflects them rather
  // than only the runtime fallback. Idempotent: only copies when the new key is unset.
  for (const [legacy, key] of [['comfy-url', 'comfy_url'], ['comfy-wake-host', 'comfy_ssh'], ['comfy-model', 'comfy_checkpoint']] as const) {
    const cur = settings.get(key);
    const old = settings.get(legacy);
    if ((cur === undefined || cur === '') && old !== undefined && old !== '') settings.set(key, old);
  }
  // Memory store with an OPTIONAL local embedding provider (FIX-memory-vectorization):
  // built after settings so it can read the ollama endpoint. undefined when no HTTP
  // ollama is configured → the store stays honestly FTS-only (embeddingEnabled()=false).
  // Reuses the existing ollama_url; embedding_model defaults to a small embed model.
  const memory = new MemoryStore(
    db,
    undefined,
    makeOllamaEmbeddingProvider(settings.get('ollama_url'), settings.get('embedding_model') ?? settings.get('ollama_model')),
    // #115/#117/#124d isolation: memory-isolated agents (customer-facing CS + financial-data
    // bookkeeper) are code-blocked from EVERY memory tier — their sensitive store-data must
    // never leak into memory. Fail-closed (gate R5a): derived from the flag OR the profile.
    new Set([...memoryIsolatedAgentIds(config.agents)].map((id) => sanitizeId(id))),
  );
  // One-time/idempotent vector backfill of pre-existing rows lacking an embedding
  // (no-op + cheap when no provider is configured). Fire-and-forget: never blocks boot.
  if (!opts.initOnly) void memory.backfillEmbeddings().catch((err: unknown) => log.warn('memory backfill failed', { error: String(err) }));
  const channelBindings = new ChannelBindingStore(db);
  const updateDeps = config.runtime.adapter === 'fake'
    ? syntheticUpdateDeps()
    : realUpdateDeps({
        repoRoot: repoRoot(),
        sourceRepo: () => {
          // accept a bare owner/repo or a full URL the operator pasted (normalize at read-time)
          const raw = settings.get('update-repo') ?? process.env.UPDATE_SOURCE_REPO ?? '';
          return raw.trim() === '' ? null : (normalizeRepo(raw) ?? raw.trim());
        },
        token: () => vault.getSecretValue('update-token'),
        provider: () => settings.get('update-provider') ?? process.env.UPDATE_SOURCE_PROVIDER ?? 'github',
        apiBaseUrl: () => settings.get('update-host') ?? process.env.UPDATE_SOURCE_HOST ?? undefined,
        logFile: join(paths.logsDir, 'update.log'),
        updaterScript: join(repoRoot(), 'scripts', 'self-update.sh'),
      });
  const updates = new UpdateService(updateDeps, join(dirname(paths.dbFile), 'update.lock'), undefined, config.runtime.adapter === 'fake');
  const studioRoot = dirname(paths.dbFile);
  // The three media roots are shared by Studio (output dirs) and the Files view
  // (BUILD-22): generated images, generated videos, the operator uploads dir.
  const mediaRoots = {
    image: join(studioRoot, 'comfy', 'Képek'),
    video: join(studioRoot, 'comfy-video', 'Videók'),
    uploads: join(homedir(), 'incoming'),
  };
  const files = new FilesService(defaultFileRoots(mediaRoots.image, mediaRoots.video, mediaRoots.uploads));
  // Studio drives the operator's LOCAL ComfyUI (FIX-studio-local). The fake adapter
  // keeps the synthetic placeholder runner; a real adapter reads the live comfy-*
  // settings per job (so a config change applies without a restart).
  const studio = new StudioService(
    mediaRoots,
    config.runtime.adapter === 'fake',
    {
      // README §8 keys are underscored; read the legacy hyphenated keys as a
      // fallback so an existing install keeps working without a settings edit.
      comfy: () => ({
        url: settings.get('comfy_url') ?? settings.get('comfy-url'),
        ssh: settings.get('comfy_ssh') ?? settings.get('comfy-wake-host'),
        checkpoint: settings.get('comfy_checkpoint') ?? settings.get('comfy-model'),
        ollamaModel: settings.get('ollama_model'),
        ollamaUrl: settings.get('ollama_url'),
        wakeCmd: settings.get('comfy_wake_cmd'),
      }),
    },
  );
  const autonomy = new AutonomyLadder(db);
  autonomy.seed(config.autonomySeed);
  const skills = new SkillStore({
    globalRoot: paths.skillsGlobalDir,
    agentRoot: (agentId) => join(paths.agentsDir, sanitizeId(agentId), 'skills'),
    hubId: config.hubId,
  });
  ensureDir(paths.skillsGlobalDir, 0o700);
  // Seed the committed global skills on first run (idempotent; never clobbers an
  // operator edit), then rebuild the Level-0 indexes (global + per sub-agent) so
  // the seeded skills are listable in the UI and loadable by agents (SEED-skills).
  installSeedSkills(paths.skillsGlobalDir);
  // per-agent seed skills (FIX-agent-skills) — exclude the hub: its skill root IS the
  // global root (see below), so it must never get a per-agent skills dir.
  installSeedAgentSkills(paths.agentsDir, config.agents.filter((a) => sanitizeId(a.id) !== sanitizeId(config.hubId)).map((a) => a.id));
  writeAgentIndex(skills, sanitizeId(config.hubId), join(paths.skillsGlobalDir, SKILL_INDEX_FILE));
  for (const a of config.agents) {
    const aid = sanitizeId(a.id);
    if (aid === sanitizeId(config.hubId)) continue; // the hub's skill root IS the global root
    try { writeAgentIndex(skills, aid, join(paths.agentsDir, aid, 'skills', SKILL_INDEX_FILE)); } catch { /* dir not scaffolded yet */ }
  }
  // --- orchestrator extension host (FIX-plugins Part B) ---
  // Plugins are PRESENT after seeding but DISABLED until enabled (config.plugins.enabled
  // ∪ the runtime settings key). A plugin only ever gets the restricted HostApi.
  const pluginsDir = join(dirname(paths.dbFile), 'plugins');
  installSeedPlugins(pluginsDir);
  const pluginHost = new PluginHost();
  // First-party CORE agent tools (browse / render_chart+render_diagram / transcribe). These need
  // Files/settings/runner/vault, which a third-party plugin's { agentId }-only context deliberately
  // cannot reach, so they live in a host-owned registry the /api/agent-tools route consults behind
  // the SAME privilege gate.
  const coreTools = registerBuiltinTools();

  // First-party COST/USAGE dashboard (FIX-plugin-cost-dashboard): a view + a rollup
  // scheduled task mounted on the SAME host the SPA extension page + scheduler loop read.
  // The rich context is a closure (the restricted HostApi never exposes config/store/notify).
  // billingMode is READ-ONLY here; notify is informational only — the billing invariant is untouched.
  const costStore = new CostStore(db);
  registerCostDashboard(
    {
      registerView: (v) => pluginHost.registerFirstPartyView(v),
      registerScheduledTask: (s) => pluginHost.registerFirstPartyTask(s),
      log: (m) => log.info(`[cost] ${m}`),
    },
    {
      store: costStore,
      billingMode: (): BillingMode => config.billing.mode,
      sources: (): AgentSource[] => config.agents.filter((a) => a.hidden !== true).map((a) => ({
        agentId: sanitizeId(a.id),
        sessionDir: agentPaths(paths, a.id).configRoot, // Claude Code writes session JSONL under CLAUDE_CONFIG_DIR
        defaultModel: config.modelAliases[a.model ?? ''] ?? a.model ?? 'unknown',
      })),
      prices: (): Record<string, ModelPrice> => {
        const raw = settings.get('cost_prices');
        try { return mergePrices(raw === undefined ? undefined : (JSON.parse(raw) as Record<string, ModelPrice>)); } catch { return mergePrices(undefined); }
      },
      budget: (): BudgetConfig => {
        const raw = settings.get('cost_budget');
        try { return raw === undefined ? {} : (JSON.parse(raw) as BudgetConfig); } catch { return {}; }
      },
      notify: (text) => { void notifyOperator(text); },
      t: i18n,
    },
  );

  const enabledPlugins = new Set<string>(config.plugins?.enabled ?? []);
  try { for (const id of JSON.parse(settings.get('plugin-extensions-enabled') ?? '[]') as unknown[]) if (typeof id === 'string') enabledPlugins.add(id); } catch { /* malformed: none */ }
  await pluginHost.loadDir(pluginsDir, enabledPlugins);

  const taskStore = new ScheduledTaskStore(db);
  // The background learning-loop is config-gated (#104): for low-resource /
  // rate-limited product installs (kkv-base) it is turned OFF entirely, so an idle
  // machine never burns subscription quota on the 30-minute heartbeat fan-out. The
  // own fleet (learningLoop omitted = on) is unchanged. The nightly auto-digest is
  // further gated within (PROMPT-09 §6C/§8).
  if (config.scheduler.learningLoop !== false) {
    const autoDigest = config.scheduler.autoDigest !== false;
    ensureSeedTasks(db, learningLoopSeeds(sanitizeId(config.hubId), { autoDigest }));
    if (!autoDigest) taskStore.delete('daily-digest');
  }

  // --- runtime ---
  ensureDir(paths.logsDir, 0o700);
  let adapter: AgentRuntimeAdapter;
  let watcherDriver: TmuxDriver | undefined;
  const sessionPrefix = instanceName(config.runtime.claude.sessionPrefix, instanceId);
  if (config.runtime.adapter === 'fake') {
    const fake = new FakeAdapter();
    // dev/test mode: fake agents echo their input as output so watch+type works,
    // and grow the rendered screen + emit a screen frame so the terminal view has
    // live, scrollable snapshots (FIX-terminal-ux).
    fake.onInput = (id, text) => {
      fake.emitOutput(id, {
        agentId: id,
        ts: new Date().toISOString(),
        kind: 'output',
        text: `[fake:${id}] received: ${text}\n`,
      });
      const grown = `${fake.currentScreen(id) ?? ''}\n> ${text}`;
      fake.setScreen(id, grown);
      fake.emitOutput(id, { agentId: id, ts: new Date().toISOString(), kind: 'screen', text: grown });
    };
    adapter = fake;
  } else {
    // Dedicated tmux socket (SPEC §3a/§19a): the fleet runs on its OWN tmux server,
    // isolated from the operator's default-server sessions. The per-instance-unique name
    // (#190) was computed in boot() and is guarded by the socket lock (b) acquired there.
    watcherDriver = createTmuxDriver({ socket: tmuxSocket });
    adapter = new ClaudeCodeAdapter({
      driver: watcherDriver,
      sessionPrefix,
      logDir: paths.logsDir,
      // Billing resolver (FIX-billing-api-optin), read per-launch: the vault key is
      // injected ONLY when the operator has deliberately set billing.mode='api'.
      // subscription (default) → apiKey undefined → no key ever injected.
      billing: () => ({
        mode: config.billing?.mode ?? 'subscription',
        ...(config.billing?.mode === 'api' ? { apiKey: vault.getSecretValue('anthropic_api_key') } : {}),
      }),
      // Local-model (ollama) endpoint, read per-launch (FIX-local-model-agents): a
      // runtime:'ollama' agent (muse/reel) is pointed here instead of Anthropic, but
      // only when it's a private/local URL — the adapter refuses a public/Anthropic one.
      localOllamaUrl: () => settings.get('ollama_url'),
    });
  }

  const specFactory = buildSpecFactory({ config: () => config, paths, serverUrl });

  // Per-agent git worktree isolation (#44): each agent gets its own worktree at
  // <agentsDir>/<id>/repo on branch agent/<id>, sharing the canonical checkout's
  // .git object store. Same canonical root the panel gate uses (overridable).
  const agentWorktrees = createAgentWorktreeManager({
    repoRoot: process.env.ORCHESTRATOR_AGENT_REPO_ROOT ?? process.env.ORCHESTRATOR_PANEL_REPO_ROOT ?? repoRoot(),
    worktreeRoot: paths.agentsDir,
  });

  // --- background one-shot runner (PROMPT-12) ---
  const backgroundRunner =
    config.runtime.adapter === 'fake' || watcherDriver === undefined
      ? new FakeBackgroundRunner()
      : new TmuxBackgroundRunner(watcherDriver, (id) => specFactory(id, { fresh: true }), paths.logsDir, sessionPrefix);
  const background = new BackgroundTaskService(backgroundStore, backgroundRunner);

  /**
   * SPEC §8/§9 continuity: replay the recent transcript + open question and
   * the saved task state into a freshly (re)started session. Subclassing
   * start() covers restart() too (it delegates to this.start).
   */
  class ContinuitySupervisor extends AgentSupervisor {
    override async start(agentId: string, opts: { fresh?: boolean } = {}): Promise<void> {
      await super.start(agentId, opts);
      void this.injectContinuity(agentId).catch((err: unknown) =>
        log.warn('session-start replay failed', { agentId, error: String(err) }),
      );
    }

    private async injectContinuity(agentId: string): Promise<void> {
      const id = sanitizeId(agentId);
      const parts: string[] = [];
      const chats = new Set(['dashboard']);
      const operatorChat = config.channels.telegram?.operatorChatId;
      if (id === sanitizeId(config.hubId) && operatorChat !== undefined && operatorChat !== '') {
        chats.add(operatorChat);
      }
      for (const chat of chats) {
        const replay = ledger.buildReplay(id, chat);
        if (replay !== '') parts.push(replay);
      }
      const saved = loadTaskState(db, id);
      if (saved !== undefined) parts.push(buildResumePrompt(saved.state));
      if (parts.length === 0) return;
      const text =
        'Session-start continuity replay (system-injected). Recent context follows; resume where you left off.\n\n' +
        parts.join('\n\n');
      await this.injectInput(id, stripSecurityTags(text, PROCESS_SENTINEL), { source: 'machine' });
    }
  }

  const supervisor = new ContinuitySupervisor({
    adapter,
    specFactory,
    // provision the agent's isolated worktree before it starts (#44); best-effort,
    // non-destructive — a git hiccup is logged inside start() and never blocks boot.
    provisionWorktree: (agentId) => agentWorktrees.provision(agentId).then(() => undefined),
    onOperatorInjection: (agentId, text) => {
      // audited, attributed operator typing (SPEC §3, §20.13)
      ledger.recordInbound(agentId, 'dashboard', `op-${newId()}`, `${i18n.t('operator.injected_label')}: ${text}`, 'operator-injection');
    },
    onReauthNeeded: (agentId) => {
      const agent = config.agents.find((a) => sanitizeId(a.id) === sanitizeId(agentId));
      void notifyOperator(i18n.t('channel.reauth_needed', { agent: agent?.displayName ?? agentId }));
    },
  });
  const activity = new ActivityMonitor(supervisor);
  // Background fleet-activity sampler (FIX-activity-sampler): precompute the Activity board off
  // the request path with bounded concurrency, so the dashboard never times out. Its status
  // probes go through statusFast (ttl:0 = force fresh) which also warms the shared status cache,
  // so the fleet LIST endpoint stops re-capturing too.
  const activitySampler = new ActivitySampler({
    agents: () => config.agents.map((a) => ({ id: sanitizeId(a.id), displayName: a.displayName, hidden: a.hidden })),
    hubId: () => sanitizeId(config.hubId),
    isRunning: (id) => supervisor.isRunning(id),
    status: (id) => supervisor.statusFast(id, { ttlMs: 0, timeoutMs: 4000 }),
    tail: (id) => activity.tail(id),
    watch: (id) => activity.watch(id),
    concurrency: 5,
    // Stuck-agent watchman (#80): an agent stuck 'working' with an unchanged tail
    // makes no progress (the MUSE/REEL busy-loop). Notify the hub on level 1; on
    // level 2 restart fresh iff its auto-restart flag is ON, else just escalate. The
    // hub decides whether to surface it to the operator (escalation is its call).
    stuckThresholds: DEFAULT_STUCK_THRESHOLDS,
    onStuck: ({ agentId, displayName, level, sinceMs }) => {
      const mins = Math.round(sinceMs / 60_000);
      const hub = sanitizeId(config.hubId);
      try {
        webhookBus.emit('agent.stuck', { agentId, level, sinceMs });
      } catch (err) {
        log.warn('watchman webhook emit failed', { agentId, error: String(err) });
      }
      // The HUB is ALERT-ONLY here (#86 D2): a single restart driver owns the hub —
      // the supervisor-side hub-recovery watchdog, which RESUMES (not fresh) to keep
      // the orchestration context. The #80 fresh-restart stays for every other agent.
      const isHub = agentId === hub;
      if (!isHub && stuckAction(level, autoRestartEnabled(paths, agentId)) === 'restart-fresh') {
        messages.enqueue({ sender: 'watchman', recipient: hub, body: `[watchman] ${displayName} (${agentId}) has been 'working' with no tail change for ~${mins} min (level 2). Auto-restart is ON — restarting it fresh.` });
        void supervisor.restart(agentId, { fresh: true }).catch((err: unknown) => log.warn('watchman restart-fresh failed', { agentId, error: String(err) }));
      } else {
        const note = isHub && level === 2
          ? ' (hub — restart is owned by the supervisor hub-recovery watchdog #86, which resumes rather than wipes context.)'
          : level === 2 ? ' Auto-restart is OFF — alerting only, no restart.' : '';
        messages.enqueue({ sender: 'watchman', recipient: hub, body: `[watchman] ${displayName} (${agentId}) has been 'working' with no tail change for ~${mins} min (level ${level}) — likely stuck.${note}` });
      }
    },
  });
  // NEXUS judge-panel (BUILD-judge-panel): orchestrates solver fan-out + collection
  // over the EXISTING kanban/supervisor surfaces — never the metered SDK/background path.
  const panelStore = new PanelStore(db);
  const panels = new PanelService({
    store: panelStore,
    kanban: {
      move: (id, to) => kanban.move(id, to),
      comment: (cardId, author, body) => kanban.comment(cardId, author, body),
      update: (id, fields) => kanban.update(id, fields),
      get: (id) => kanban.get(id),
    },
    // repoRoot is the orchestrator's own checkout (panels are the in-product self-improve
    // loop). Defaults to repoRoot() — the git checkout the code lives in (dist/../..) —
    // NOT process.cwd(), so the gate works on a systemd deploy whose WorkingDirectory
    // isn't the source repo (FIX-release-gaps). Overridable via ORCHESTRATOR_PANEL_REPO_ROOT
    // so tests/sandboxes point it at a non-git path (every git op then fails gracefully —
    // worktree prepare → wtOk:false, no mutation).
    gate: createGitGateRunner({ repoRoot: process.env.ORCHESTRATOR_PANEL_REPO_ROOT ?? repoRoot() }),
    artifacts: {
      verdictPath: (panelId, key) => join(dirname(paths.dbFile), 'panel-artifacts', `p${panelId}`, `verdict-${key}.json`),
      read: (p) => { try { return readFileSync(p, 'utf8'); } catch { return undefined; } },
      worktreePath: (panelId, agentId) => join(dirname(paths.dbFile), 'panel-worktrees', `p${panelId}`, `sol-${sanitizeId(agentId)}`),
    },
    isRunning: (id) => supervisor.isRunning(id),
    enqueue: (msg) => { messages.enqueue(msg); },
    inject: (agentId, text) => { void supervisor.injectInput(agentId, text, { source: 'machine' }).catch((err: unknown) => log.warn('panel re-inject failed', { agentId, error: String(err) })); },
    tail: (agentId, n) => activity.tail(agentId, n),
    notifyOperator: (text) => { void notifyOperator(text); },
    roster: () => config.agents.map((a) => a.id),
    lanes: () => config.lanes,
    emitEvent: (kind, data) => { try { webhookBus.emit(kind, data); } catch (err) { log.warn('panel webhook emit failed', { error: String(err) }); } },
  });
  // Collection trigger: a panel-member agent finishing its turn (busy→ready) records
  // its produced solution. Reuses the same agent.finished edge the webhook fires.
  webhookBus.subscribe((event) => {
    if (event.kind !== 'agent.finished') return;
    const agentId = (event.data as { agentId?: unknown }).agentId;
    if (typeof agentId !== 'string') return;
    // onAgentFinished is async (it captures the solver's real commit from its worktree
    // branch tip); fire-and-forget so a slow/failed collect never blocks the webhook bus.
    void panels.onAgentFinished(agentId).catch((err) => log.warn('panel collect failed', { agentId, error: String(err) }));
  });
  const desired = new DesiredStateStore(db);
  const reconciler = new Reconciler({
    desired,
    supervisor: {
      start: (id) => supervisor.start(id, { fresh: false }),
      stop: (id) => supervisor.stop(id),
    },
    isRunning: (id) => supervisor.isRunning(id),
    // hidden agents are excluded from roster VIEW/scheduler/routing (SPEC §4)
    // but they are still real — the reconciler manages them too
    roster: () => config.agents.map((a) => sanitizeId(a.id)),
    staggerMs: config.runtime.claude.staggerSeconds * 1000,
  });

  // --- live run-state snapshot for delivery/scheduler (their state() is sync) ---
  const runStates = new Map<string, AgentRunState>();
  async function refreshRunStates(): Promise<void> {
    // statusFast (not raw status): each probe is timeout-bounded, so one hung agent
    // (e.g. a wedged tmux pane) can never stall the whole sweep. Run in parallel —
    // a serial un-timed loop was a freeze vector.
    await Promise.all(config.agents.map(async (agent) => {
      const id = sanitizeId(agent.id);
      const prev = runStates.get(id);
      try {
        const status = await supervisor.statusFast(id);
        const next: AgentRunState = !status.running ? 'down' : status.busyState === 'ready' ? 'ready' : 'busy';
        runStates.set(id, next);
        // busy -> ready is the natural "agent finished its turn" edge; fire the
        // outbound webhook event (FIX-plugin-webhook). Only on a real transition,
        // so a steady-state ready agent never re-fires.
        if (isAgentFinishEdge(prev, next)) {
          webhookBus.emit('agent.finished', { agentId: id, displayName: agent.displayName });
        }
      } catch {
        runStates.set(id, 'down');
      }
    }));
  }

  // --- operator notification + reply routing (multi-channel: Telegram + Discord) ---
  // Live providers, assigned in their construction blocks below; the reply router
  // reads them at call time (post-boot), so referencing them here is safe.
  let telegram: TelegramChannel | undefined;
  let slack: SlackChannel | undefined;
  let discord: DiscordChannel | undefined;
  const providerById = (id: string): ChannelProvider | undefined =>
    id === 'telegram' ? telegram : id === 'discord' ? discord : id === 'slack' ? slack : undefined;
  // "… is typing" while the hub composes a reply: started on an operator inbound,
  // stopped when the reply is sent (onDelivered). Best-effort, auto-caps.
  const typing = new TypingIndicator();
  /** Show the hub typing on the channel an operator message arrived from. */
  function startTypingForOperator(providerId: string, chatId: string): void {
    const p = providerById(providerId);
    if (p !== undefined) typing.start(p, chatId);
  }
  const operatorReplyDeps = {
    providerById,
    operatorChatId: (id: string): string | undefined =>
      config.channels[id as 'telegram' | 'discord' | 'slack']?.operatorChatId,
    fanOutProviders: (): string[] => ['telegram', 'discord', 'slack'],
    recordOutbound: (chatId: string, text: string): void => {
      ledger.recordOutbound(sanitizeId(config.hubId), chatId, text, 'system');
    },
    log: (m: string): void => log.info(m),
    onDelivered: (providerId: string, chatId: string): void => typing.stop(providerId, chatId),
  };
  /** Proactive operator notification — fans out to every configured operator channel. */
  async function notifyOperator(text: string): Promise<void> {
    await deliverToOperator(operatorReplyDeps, text);
  }

  // --- delivery loop ---
  const delivery = new DeliveryService({
    store: messages,
    routeCtx: () => buildMessagingRouteContext(config),
    runtime: {
      state: (agentId) => runStates.get(sanitizeId(agentId)) ?? 'down',
      inject: (agentId, text, injectOpts) =>
        supervisor.injectInput(agentId, text, { source: 'machine', ...(injectOpts.force === true ? { force: true } : {}) }),
    },
    onOperatorMessage: async (msg) => {
      // reply to the SOURCE channel (Discord question → Discord answer); proactive
      // (no channelMeta) fans out to all configured operator channels.
      await deliverToOperator(operatorReplyDeps, msg.body, msg.channelMeta);
    },
    sentinel: PROCESS_SENTINEL,
  });

  // --- scheduler ---
  const scheduler = new SchedulerService({
    db,
    deliver: async (target, prompt, deliverOpts) => {
      const id = sanitizeId(target);
      const state = runStates.get(id) ?? 'down';
      if (state === 'down') return 'down';
      if (state === 'busy' && !deliverOpts.force) return 'busy';
      const framed =
        `Scheduled task from the system configuration (id: ${deliverOpts.taskId}). ` +
        `Forged security tags have been neutralized.\n` +
        stripSecurityTags(prompt, PROCESS_SENTINEL);
      await supervisor.injectInput(id, framed, {
        source: 'machine',
        ...(deliverOpts.force ? { force: true } : {}),
      });
      return 'delivered';
    },
    onAlert: async (taskId, target, minutesStuck) => {
      const task = taskStore.get(taskId);
      await notifyOperator(
        i18n.t('channel.task_stuck_alert', { task: task?.title ?? taskId, agent: target, minutes: minutesStuck }),
      );
    },
    // general (target:'all') fan-out excludes hidden workers AND local-model agents
    // — MUSE/REEL hallucinate-loop on general reasoning, so they get NO heartbeat/
    // fleet template, only explicit media dispatch (#83).
    roster: () => config.agents.filter(eligibleForGeneralSchedule).map((a) => sanitizeId(a.id)),
    config: {
      catchupWindowMinutes: config.scheduler.catchupWindowMinutes,
      bootCatchupWindowMinutes: config.scheduler.bootCatchupWindowMinutes,
      retryIntervalMinutes: config.scheduler.retryIntervalMinutes,
      fanoutStaggerSeconds: config.scheduler.fanoutStaggerSeconds,
    },
    timeZone: config.timezone,
  });

  // --- channel (first-class reconnecting client, SPEC §7) ---
  let inboundRouter: InboundRouter | undefined;
  const telegramCfg = config.channels.telegram;
  if (!opts.initOnly && telegramCfg !== undefined && telegramCfg.enabled) {
    const token = vault.resolveRef(telegramCfg.tokenRef);
    if (token === undefined || token === '' || token === telegramCfg.tokenRef) {
      log.warn('telegram enabled but its token is not in the vault; channel stays down');
    } else {
      inboundRouter = new InboundRouter({
        enqueue: (msg) => {
          messages.enqueue(msg);
        },
        ledger,
        // ledger-claim + enqueue share this db: one transaction, no loss window
        transact: (fn) => {
          db.exec('BEGIN IMMEDIATE');
          try {
            fn();
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
        },
        hubId: sanitizeId(config.hubId),
        // dynamic allowlist (FIX-channels): operator-approved chats take effect
        // without a restart; an unknown chat is surfaced as a pending pairing.
        isAllowed: (id) => channelBindings.allAllowedChatIds().has(id),
        onUnknownChat: (e) => channelBindings.createPairing(e.provider, e.chatId, e.user),
        ...(telegramCfg.operatorChatId !== undefined && telegramCfg.operatorChatId !== ''
          ? { operatorChatId: telegramCfg.operatorChatId }
          : {}),
      });
      const telegramMediaDir = join(paths.stateDir, 'channels', 'inbox', 'telegram');
      ensureDir(telegramMediaDir, 0o700);
      telegram = new TelegramChannel({
        token,
        db,
        mediaDir: telegramMediaDir,
        onInbound: async (event) => {
          inboundRouter?.handle(event);
          if (event.chatId === telegramCfg.operatorChatId) startTypingForOperator('telegram', event.chatId);
        },
      });
    }
  }

  // --- Slack channel (FIX-plugin-channels-slack-discord) — mirrors telegram; the real
  //     Socket Mode WS transport is a TODO seam (throws), so an enabled-but-unwired
  //     provider backs off honestly (listening:false), never fakes success. ---
  const slackCfg = config.channels.slack;
  if (!opts.initOnly && slackCfg !== undefined && slackCfg.enabled) {
    const botToken = vault.resolveRef(slackCfg.botTokenRef);
    const appToken = vault.resolveRef(slackCfg.appTokenRef);
    if (!botToken || botToken === slackCfg.botTokenRef || !appToken || appToken === slackCfg.appTokenRef) {
      log.warn('slack enabled but its tokens are not in the vault; channel stays down');
    } else {
      const slackRouter = new InboundRouter({
        enqueue: (msg) => { messages.enqueue(msg); },
        ledger,
        transact: (fn) => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; } },
        hubId: sanitizeId(config.hubId),
        isAllowed: (id) => channelBindings.allAllowedChatIds().has(id),
        onUnknownChat: (e) => channelBindings.createPairing(e.provider, e.chatId, e.user),
        ...(slackCfg.operatorChatId !== undefined && slackCfg.operatorChatId !== '' ? { operatorChatId: slackCfg.operatorChatId } : {}),
      });
      slack = new SlackChannel({
        botToken,
        appToken,
        ...(slackCfg.teamId !== undefined ? { teamId: slackCfg.teamId } : {}),
        db,
        onInbound: async (event) => { slackRouter.handle(event); },
        socketFactory: () => { throw new Error('slack Socket Mode transport not wired in this build'); },
      });
    }
  }

  // --- Discord channel (FIX-discord-gateway) — real gateway WS now wired (was a throwing stub). ---
  const discordCfg = config.channels.discord;
  if (!opts.initOnly && discordCfg !== undefined && discordCfg.enabled) {
    const botToken = vault.resolveRef(discordCfg.botTokenRef);
    if (!botToken || botToken === discordCfg.botTokenRef) {
      log.warn('discord enabled but its token is not in the vault; channel stays down');
    } else {
      const discordRouter = new InboundRouter({
        enqueue: (msg) => { messages.enqueue(msg); },
        ledger,
        transact: (fn) => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; } },
        hubId: sanitizeId(config.hubId),
        isAllowed: (id) => channelBindings.allAllowedChatIds().has(id),
        onUnknownChat: (e) => channelBindings.createPairing(e.provider, e.chatId, e.user),
        ...(discordCfg.operatorChatId !== undefined && discordCfg.operatorChatId !== '' ? { operatorChatId: discordCfg.operatorChatId } : {}),
      });
      discord = new DiscordChannel({
        botToken,
        ...(discordCfg.applicationId !== undefined ? { applicationId: discordCfg.applicationId } : {}),
        db,
        onInbound: async (event) => {
          discordRouter.handle(event);
          if (event.chatId === discordCfg.operatorChatId) startTypingForOperator('discord', event.chatId);
        },
        // Real gateway WS (zero-dep, built-in WebSocket); the factory closure holds the
        // resumable session state shared across reconnects.
        gatewayFactory: createDiscordGateway({ botToken }),
      });
    }
  }

  // --- agent API tokens ---
  const agentTokens = new Map<string, string>();
  function reloadAgentTokens(): void {
    for (const agent of config.agents) {
      const token = loadAgentToken(paths, agent.id);
      // a short/empty token file must never become a matchable credential
      if (token !== undefined && token.length >= 32) agentTokens.set(sanitizeId(agent.id), token);
    }
  }
  reloadAgentTokens();

  // --- app context + HTTP server ---
  const seedConfigIds = new Set<string>();
  try {
    const seedFile = join(seedDir(), 'seed.config.json');
    const seedRaw = JSON.parse(existsSync(seedFile) ? readFileSync(seedFile, 'utf8') : '{}') as {
      agents?: Array<{ id?: string }>;
    };
    for (const a of seedRaw.agents ?? []) if (typeof a.id === 'string') seedConfigIds.add(sanitizeId(a.id));
  } catch {
    /* no seed list: only the hub is protected */
  }

  // Deploy-checkout divergence monitor (#88): NON-BLOCKING visibility when the shared
  // checkout's local main picks up a commit not on origin/main (e.g. a direct operator
  // commit outside the PR flow). It warns (durable operator alert + webhook + dashboard),
  // never blocks — the operator owns the repo; the release builds from origin regardless.
  const divergence = new DivergenceMonitor({
    probe: createGitDivergenceProbe(process.env.ORCHESTRATOR_DEPLOY_REPO_ROOT ?? repoRoot()),
    notifyOperator: (text) => { void notifyOperator(text); },
    emitEvent: (status) => { try { webhookBus.emit('deploy.diverged', { aheadCount: status.aheadCount, branch: status.branch, commits: status.commits }); } catch (err) { log.warn('divergence webhook emit failed', { error: String(err) }); } },
  });

  const ctx: AppContext = {
    config,
    paths,
    db,
    i18n,
    version: VERSION,
    messages,
    delivery,
    memory,
    ledger,
    scheduler,
    taskStore,
    kanban,
    channelBindings,
    ideas,
    modules,
    moduleStores,
    panels,
    background,
    connectors,
    tokens,
    settings,
    updates,
    divergence,
    studio,
    files,
    activity,
    activitySampler,
    autonomy,
    skills,
    pluginHost,
    coreTools,
    buildCoreToolContext: (agentId: string): CoreToolContext => ({
      agentId,
      files,
      imagesDir: mediaRoots.image,
      settings,
      runner: defaultCommandRunner,
      vault,
      fetchImpl: fetch,
    }),
    vault,
    supervisor,
    desired,
    reconciler,
    agentWorktrees,
    ...(telegram !== undefined ? { telegram } : {}),
    ...(slack !== undefined ? { slack } : {}),
    ...(discord !== undefined ? { discord } : {}),
    agentTokens,
    seedAgentIds: seedConfigIds,
    saveConfig: (mutate) => {
      mutate(config);
      persistConfig(paths, config);
      config = loadConfig(paths.configFile);
      ctx.config = config;
      reloadAgentTokens();
    },
    notifyOperator,
    scaffoldAgent: (agentId) => {
      scaffoldAgent({ config, paths, serverUrl }, agentId);
      reloadAgentTokens();
    },
    reseedAgentDocs: () => reseedAgentDocs({ config, paths, serverUrl }),
    reseedAgentSettings: () => reseedAgentSettings({ config, paths, serverUrl }),
    composeAgentClaude: (agentId, parts) => {
      const agent = config.agents.find((a) => sanitizeId(a.id) === sanitizeId(agentId));
      if (agent === undefined) throw new Error(`unknown agent: ${agentId}`);
      return composeAgentClaude({ config, paths, serverUrl }, agent, parts);
    },
  };

  const router = new Router();
  registerAllRoutes(router, ctx);
  // #386 FÁZIS-0: mount the registered verticals' routes AFTER the core/horizontal routes.
  // The router scores by static-segment specificity (router.ts), NOT registration order, so
  // post-core registration is safe. EMPTY registry (public core) => no vertical routes mount.
  modules.registerRoutes(router, ctx);

  const staticRoot = join(repoRoot(), 'web', 'dist');
  const server = createHttpServer({
    host: config.server.host,
    port: serverPort,
    bearer,
    router,
    staticRoot,
    ...(config.portal !== undefined ? { rootDoc: 'portal.html' } : {}), // #261: portal instance serves the portal SPA
    extraAllowedOrigins: config.server.allowedOrigins,
    // #386 FÁZIS-0: merge each registered pack's public/unauth paths (e.g. '/api/cs/widget')
    // into the core auth policy. EMPTY registry => no extra public paths (default-deny).
    authPolicy: { ...AUTH_POLICY, publicPaths: [...AUTH_POLICY.publicPaths, ...modules.publicPaths()] },
    agentTokens,
    translate: (key, params) => i18n.t(key, params),
  });

  if (opts.initOnly) {
    // print the bootstrap URL to stderr ONLY (the token never hits stdout/logs)
    process.stderr.write(`\nBootstrap URL: ${serverUrl}/?token=${bearer}\n`);
    db.close();
    return undefined;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(serverPort, config.server.host, () => resolve());
  });
  const boundPort = (server.address() as { port: number }).port;
  // The token is printed only when freshly generated (first run): a recurring
  // print would land in journald/log collectors on every restart. Later runs
  // point at the 0600 token file instead.
  const liveUrl = `http://${config.server.host}:${boundPort}`;
  if (bearerWasCreated) {
    process.stderr.write(`\n${config.branding.productName} dashboard: ${liveUrl}/?token=${bearer}\n\n`);
  } else {
    process.stderr.write(
      `\n${config.branding.productName} dashboard: ${liveUrl}/ (token: see ${paths.bearerFile})\n\n`,
    );
  }
  log.info(`supervisor up (adapter: ${config.runtime.adapter}, locale: ${config.locale.default})`);

  // --- background loops ---
  telegram?.start();
  slack?.start();
  discord?.start();
  const timers: NodeJS.Timeout[] = [];
  const loop = (fn: () => Promise<void> | void, ms: number): void => {
    const t = setInterval(() => {
      void (async () => fn())().catch((err: unknown) => log.error('background loop error', { error: String(err) }));
    }, ms);
    t.unref();
    timers.push(t);
  };
  await refreshRunStates();
  // Start the loops FIRST. The initial reconcile starts agents staggered
  // (staggerSeconds each) and can take minutes for a full roster — awaiting it
  // here would stall delivery/scheduler/status for that whole window. Run it in
  // the background instead so message delivery is live immediately.
  loop(refreshRunStates, 5_000);
  loop(() => delivery.tick(), 5_000);
    // Reconcile-first (SPEC §9): the runner processes the never-abandon retry
    // queue BEFORE new cron fires, so a previously-stuck must-run task wins.
  loop(() => scheduler.reconcileAndTick(), 30_000);
  loop(async () => {
    await reconciler.reconcile();
  }, 60_000);
  void reconciler.reconcile().catch((err: unknown) => log.error('initial reconcile failed', { error: String(err) }));
  loop(() => {
    memory.decay();
    memory.age(14);
  }, 24 * 60 * 60 * 1000);

  // --- background one-shot tasks (PROMPT-12): sweep orphans from the last run,
  // then poll running jobs for completion / the 30-min timeout every ~10s ---
  void background.sweepOrphans().catch((err: unknown) => log.warn('background orphan sweep failed', { error: String(err) }));
  loop(() => background.tick(), 10_000);

  // --- judge-panel per-solver timeout sweep (BUILD-judge-panel): a pending solver
  // past its deadline → timeout (excluded if quorum still holds), every ~60s ---
  loop(() => { try { panels.sweepTimeouts(); } catch (err) { log.warn('panel timeout sweep failed', { error: String(err) }); } }, 60_000);

  // --- shared-subscription auth broker (FIX-agent-auth-broker): every ~5 min, (1) re-link
  // any decoupled agent to the one host credential (self-heal, no restart) and (2) proactively
  // refresh the host OAuth token BEFORE expiry so no agent ever self-refreshes (which would
  // rotate the shared token and cascade the fleet to /login). Subscription OAuth only — never
  // an API key. A run once at boot repairs anything left over from the previous run. ---
  const authBroker = createAuthBroker({
    configDirs: () =>
      config.agents
        .filter((a) => (a.authMode ?? 'shared-subscription') === 'shared-subscription')
        .map((a) => agentPaths(paths, sanitizeId(a.id)).configRoot),
    notifyOperator: (text) => { void notifyOperator(text); },
  });
  void authBroker.tick().catch((err: unknown) => log.warn('auth broker boot tick failed', { error: String(err) }));
  loop(() => { void authBroker.tick().catch((err: unknown) => log.warn('auth broker tick failed', { error: String(err) })); }, 5 * 60_000);

  // --- fleet-activity sampler (FIX-activity-sampler): refresh the cached Activity board every
  // ~5s (bounded concurrency, non-overlapping) so /api/agents/activity + the fleet list serve a
  // warm snapshot instantly instead of capturing 15 panes per request. A boot tick warms it. ---
  void activitySampler.tick().catch((err: unknown) => log.warn('activity sampler boot tick failed', { error: String(err) }));
  loop(() => { void activitySampler.tick().catch((err: unknown) => log.warn('activity sampler tick failed', { error: String(err) })); }, 5_000);

  // --- hub-recovery watchdog (#86): the hub (NEXUS) is a SPOF — if its session wedges
  // on an API error nothing revives it (the scheduler only re-delivers + alerts, never
  // restarts). This supervisor-side (MainPID) watchdog detects a wedged hub (frozen pane
  // while not-ready) and recovers it with a tmux restart+RESUME (--continue, never SDK/
  // headless), bounded by per-episode backoff + a cap, then a DURABLE operator escalation
  // (notifyOperator goes straight to the channels, not through the wedged hub). Resume —
  // not fresh — preserves the orchestration context. The progress guard (frozen tail, not
  // raw busy-time) keeps a legit long orchestration turn from being false-restarted. ---
  // Config-driven tuning (#86/#87): thresholds + backoff merge over the built-in
  // defaults; extra transient markers fold into the pane classifier — so an ORACLE
  // taxonomy/backoff finding lands in config, no code change.
  const { transientMarkers: hubTransientMarkers, ...hubThresholdOverrides } = config.hubRecovery ?? {};
  configureTransientMarkers(hubTransientMarkers ?? []);
  const recoveryThresholds = { ...DEFAULT_SESSION_RECOVERY_THRESHOLDS, ...hubThresholdOverrides };
  const fleetRecovery = new FleetRecoveryCoordinator(recoveryThresholds);
  const agentRec = config.agentRecovery ?? {};
  // #175: one coordinator drives the hub AND (when enabled) non-hub agents, so the
  // fleet-wide restart rate-spacer counts every session. The HUB is ALWAYS a candidate
  // (the SPOF watchdog) — independent of the non-hub switch; non-hub recovery is OFF by
  // default (above-sandbox automated capability the operator opts into).
  const recoveryTick = async (): Promise<void> => {
    const hubId = sanitizeId(config.hubId);
    const candidates: RecoveryCandidate[] = [];
    const observe = async (id: string, isHub: boolean): Promise<void> => {
      let status;
      try {
        status = await supervisor.statusFast(id, { ttlMs: 0, timeoutMs: 4000 });
      } catch {
        return; // a probe failure this tick is not a wedge signal — skip this session
      }
      candidates.push({
        id,
        isHub,
        obs: { now: Date.now(), running: status.running, busyState: status.busyState, apiTransientError: status.apiTransientError === true, tail: activity.tail(id) },
      });
    };
    await observe(hubId, true); // hub: always recovered (SPOF), regardless of agentRecovery.enabled
    if (agentRec.enabled === true) {
      for (const a of config.agents) {
        const id = sanitizeId(a.id);
        if (id === hubId) continue;
        if (agentRec.perAgent?.[id]?.enabled === false) continue; // per-agent opt-out
        if (desired.getDesired(id) !== 'running') continue; // only what the operator wants running
        await observe(id, false);
      }
    }
    if (candidates.length === 0) return;
    await fleetRecovery.tick(candidates, {
      now: Date.now(),
      cap: agentRec.concurrencyCap ?? 1,
      restart: async (id) => { await supervisor.restart(id, { fresh: false }).catch((err: unknown) => log.error('recovery resume-restart failed', { id, error: String(err) })); },
      refreshFleetToken: async () => { await authBroker.refreshNow().catch((err: unknown) => log.warn('recovery token refresh failed', { error: String(err) })); },
      notifyOperator: (msg) => { void notifyOperator(msg); },
      noteQuietly: (msg) => log.warn('fleet-recovery', { note: msg }),
      escalationReachesOperator: autonomy.isAllowed('fleet_recovery', 2),
      authRefreshCooldownMs: recoveryThresholds.authGraceMs,
    });
  };
  loop(() => { void recoveryTick().catch((err: unknown) => log.warn('recovery tick failed', { error: String(err) })); }, 15_000);

  // --- self-update background check (PROMPT-18): a check shortly after boot,
  // then a ~15-minute re-check; the page + nav badge read this cache ---
  void updates.forceCheck().catch((err: unknown) => log.warn('initial update check failed', { error: String(err) }));
  loop(() => void updates.forceCheck(), 15 * 60_000);

  // --- deploy-checkout divergence check (#88): a non-blocking warning if the shared
  // local main has commits not on origin/main. A boot tick warms it; then ~5-minute. ---
  try { divergence.tick(); } catch (err) { log.warn('divergence boot tick failed', { error: String(err) }); }
  loop(() => { try { divergence.tick(); } catch (err) { log.warn('divergence tick failed', { error: String(err) }); } }, 5 * 60_000);

  // --- plugin extension scheduled tasks (FIX-plugins): cron-tick each registered
  // plugin task, ISOLATED (a throwing task is logged, never stalls the loop) and
  // deduped per cron-minute so the 30s loop can't double-fire. ---
  const pluginTaskFiredMin = new Map<string, string>();
  loop(() => {
    const now = new Date();
    const minuteKey = now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    for (const { pluginId, task } of pluginHost.scheduledTasks()) {
      let parsed;
      try { parsed = parseCron(task.schedule); } catch { continue; }
      if (!cronMatchesAt(parsed, now, config.timezone)) continue;
      const key = `${pluginId}:${task.name}`;
      if (pluginTaskFiredMin.get(key) === minuteKey) continue;
      pluginTaskFiredMin.set(key, minuteKey);
      void Promise.resolve().then(() => task.run()).catch((err: unknown) => log.error('plugin task failed', { plugin: pluginId, task: task.name, error: String(err) }));
    }
  }, 30_000);

  // --- customer-service email connector (#118) — DORMANT by default ---
  // Per-instance SINGLE-tenant: reads ONLY this instance's mailbox (creds from this
  // instance's vault). Constructed (and its loops registered) ONLY when the operator
  // has enabled it after roll-up. Inbound: poll UNSEEN -> ingest into the cs_* store ->
  // pointer-notify the CS agent. Outbound: drain the queued reply interactions -> SMTP.
  const emailCfg = config.channels.email;
  if (!opts.initOnly && emailCfg !== undefined && emailCfg.enabled) {
    try {
      // Resolve + HARDEN the credentials at the vault/config boundary (reject CR/LF/NUL:
      // the IMAP quoting does not escape CRLF -> command-injection guard, PROBE flag).
      const imapUser = assertSafeField(vault.resolveRef(emailCfg.imapUserRef) ?? '', 'imap user');
      const imapPass = assertSafeField(vault.resolveRef(emailCfg.imapPasswordRef) ?? '', 'imap password');
      const smtpUser = assertSafeField(vault.resolveRef(emailCfg.smtpUserRef) ?? '', 'smtp user');
      const smtpPass = assertSafeField(vault.resolveRef(emailCfg.smtpPasswordRef) ?? '', 'smtp password');
      const fromAddress = assertSafeField(emailCfg.fromAddress, 'fromAddress');
      const imapHost = assertSafeField(emailCfg.imapHost, 'imapHost');
      const smtpHost = assertSafeField(emailCfg.smtpHost, 'smtpHost');
      const csAgentId = sanitizeId(config.agents.find((a) => a.customerFacing === true)?.id ?? 'support');
      const pollMs = Math.max(15, emailCfg.pollSeconds ?? 60) * 1000;
      const domain = fromAddress.split('@')[1] ?? 'localhost';

      // #386 FÁZIS-0: the connector construction STAYS core-side (it already takes `cs` structurally
      // and owns the SMTP/IMAP transport closures), but its two vertical sources now come from the
      // registry: the `cs` store from moduleStores, the wake-sender class from the ingest hook. The
      // public core (EMPTY registry => cs undefined) never builds the connector — default-deny.
      const cs = moduleStores['cs'] as (CsStoreLike & OutboxCsLike) | undefined;
      const csInboundSender = modules.ingestSender();
      if (cs !== undefined && csInboundSender !== undefined) {
        const ingestor = new EmailIngestor({
          cs,
          csInboundSender,
          enqueue: (msg) => { messages.enqueue(msg); },
          csAgentId,
          newId,
        });
        const outbox = new EmailOutbox({
          cs,
          fromAddress,
          openSmtp: async () => {
            const c = new SmtpClient(() => openTlsSocket({ host: smtpHost, port: emailCfg.smtpPort }), { user: smtpUser, pass: smtpPass });
            await c.connectAndAuth();
            return c;
          },
          newMessageId: () => `<${newId()}@${domain}>`,
          now: () => new Date(),
        });

        // Inbound poll: a fresh IMAP session per tick (connect -> login -> select -> poll -> logout).
        loop(async () => {
          const imap = new ImapClient(() => openTlsSocket({ host: imapHost, port: emailCfg.imapPort }), { user: imapUser, pass: imapPass });
          try {
            await imap.login();
            await imap.selectInbox();
            await ingestor.pollOnce(imap);
          } finally {
            await imap.logout();
          }
        }, pollMs);
        loop(() => outbox.tick(), pollMs);
        log.info('customer-service email connector active', { fromAddress, imapHost, csAgentId });
      } else {
        log.info('customer-service email connector: no cs module registered (public core) — staying down');
      }
    } catch (err) {
      log.error('email connector failed to start; staying down', { error: String(err) });
    }
  }

  // --- substrate watchers (SPEC §19a): only for the real tmux runtime ---
  if (watcherDriver !== undefined) {
    const driver = watcherDriver;
    const watchers = new WatcherService({
      driver,
      roster: () => config.agents.filter((a) => a.hidden !== true).map((a) => sanitizeId(a.id)),
      sessionName: (id) => `${sessionPrefix}-${sanitizeId(id)}`,
      readScreen: async (id) => {
        try {
          return await driver.capturePane(`${sessionPrefix}-${sanitizeId(id)}`, 120);
        } catch {
          return undefined;
        }
      },
      respawn: (id) => supervisor.restart(id, { fresh: false }),
      alertOperator: (id, category, evidence) => {
        const agent = config.agents.find((a) => sanitizeId(a.id) === id);
        void notifyOperator(
          i18n.t('watchers.alert', { agent: agent?.displayName ?? id, category, evidence }),
        );
      },
      // Auto-dismiss the end-of-session survey (FIX-agent-permissions-permissive §4):
      // Escape via the same serialized input FIFO machine/operator input uses.
      dismissSurvey: (id) => supervisor.sendKey(id, 'Escape'),
      // Accept the "Bypass Permissions mode" prompt (Down→"Yes, I accept", Enter) so a
      // bypass agent never wedges on it; Esc would exit (FIX-agent-permissions-permissive).
      acceptBypassPrompt: async (id) => { await supervisor.sendKey(id, 'Down'); await supervisor.sendKey(id, 'Enter'); },
      // Interactive-picker recovery (FIX-telegram-hub-reply + #233 runtime-net): an agent
      // wedged on a blocking AskUserQuestion picker can never answer it locally (no human
      // at its TTY) — for the hub this also gates the operator's inbound messages. Escape it
      // (DECLINES the picker, never selects), then nudge per role (hub -> re-ask on channel,
      // sub-agent -> escalate via agentctl). The nudge goes through the NORMAL readiness-gated
      // inject (NOT force): performInject waits for the pane to be idle before typing, so the
      // nudge can never land inside the still-open picker (which would select an option).
      // Fire-and-forget so a slow readiness wait never stalls the watcher tick; a never-idle
      // agent just drops the nudge (bounded), and the operating.md contract still applies.
      recoverHubModal: async (id) => {
        await supervisor.sendKey(id, 'Escape');
        // The Escape DECLINES the picker for ANY agent (#233 fleet-wide). The follow-up
        // nudge differs by role: the hub re-asks the operator on the channel; a sub-agent
        // (no TTY operator) is told to escalate via agentctl per its contract.
        const nudge = sanitizeId(id) === sanitizeId(config.hubId) ? HUB_MODAL_NUDGE : AGENT_MODAL_NUDGE;
        // Short waitMs: the nudge is best-effort, so it must not sit at the per-agent
        // FIFO head for the full default wait polling a busy agent — that would delay a
        // later operator force-send queued behind it. It lands if the agent idles within
        // the window, otherwise it is dropped (the operating.md contract still applies).
        void supervisor.injectInput(id, nudge, { source: 'machine', waitMs: 5_000 }).catch((err: unknown) => {
          log.warn('picker nudge inject failed', { agentId: id, error: String(err) });
        });
      },
      // Context-window auto-compact (#296): inject /compact into a heavy-but-idle session before it fills its
      // window and wedges (a wedged hub halts dispatch). Readiness-gated (injectInput waits for idle) +
      // /compact preserves task state. Resolves true on a CONFIRMED delivery, false on a drop (busy pane past
      // the readiness wait) so the watcher arms the anti-thrash floor only on success and retries on a drop (#336).
      injectCompact: (id) =>
        supervisor
          .injectInput(id, '/compact', { source: 'machine', waitMs: 5_000 })
          .then(() => true)
          .catch((err: unknown) => {
            log.warn('auto-compact inject dropped (busy pane); will retry next tick', { agentId: id, error: String(err) });
            return false;
          }),
      readContextTokens: (id) => readContextTokens(agentPaths(paths, id).configRoot),
      contextWindow: (id) => {
        const agent = config.agents.find((a) => sanitizeId(a.id) === id);
        const model = agent?.model !== undefined ? (config.modelAliases[agent.model] ?? agent.model) : null;
        return contextWindowForModel(model);
      },
      autoCompact: config.autoCompact,
    });
    loop(() => watchers.tick(), 30_000);
  }

  // #111: content-free outbound health beat. Wired ONLY on a provisioned product
  // instance — config.management.health.{enabled,url,machineId} present AND the
  // per-machine HMAC key in the vault. The own fleet (no management config) and any
  // unprovisioned machine never beat (the driver is also dormant without the secret).
  // A flaky aggregator can never crash the host: each beat's errors are swallowed.
  let stopHealthBeat: (() => void) | undefined;
  const healthCfg = config.management?.health;
  if (healthCfg?.enabled === true && typeof healthCfg.url === 'string' && healthCfg.url !== '' && typeof healthCfg.machineId === 'string' && healthCfg.machineId !== '') {
    const machineId = healthCfg.machineId;
    const aggregatorUrl = healthCfg.url;
    const intervalMs = Math.max(1, Math.floor(healthCfg.intervalMinutes ?? 5)) * 60_000;
    stopHealthBeat = startHealthBeat({
      intervalMs,
      snapshot: async () => buildHealthSnapshot({
        machineId,
        version: VERSION,
        at: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        agents: await Promise.all(config.agents.map(async (a) => {
          const id = sanitizeId(a.id);
          const s = await supervisor.statusFast(id);
          return { id, running: s.running, busyState: s.busyState };
        })),
      }),
      secret: () => vault.getSecretValue('health-webhook-key'),
      url: aggregatorUrl,
      post: async (url, body, headers) => {
        // #164: the configured aggregator is a private VPN-mesh host; allow ONLY that
        // exact configured host past the SSRF guard — every other private/blocked
        // address stays refused (no blanket private-allow).
        const safe = await assertPublicUrl(url, { allowHosts: allowHostsForUrl(aggregatorUrl) });
        const res = await fetch(safe, { method: 'POST', body, headers });
        return { ok: res.ok, status: res.status };
      },
      onError: (err) => log.warn('health beat failed', { err: String(err) }),
    });
    log.info('health beat enabled', { intervalMinutes: intervalMs / 60_000 });
  }

  const shutdown = async (): Promise<void> => {
    log.info('shutting down');
    for (const t of timers) clearInterval(t);
    stopHealthBeat?.();
    await telegram?.stop().catch(() => undefined);
    await slack?.stop().catch(() => undefined);
    await discord?.stop().catch(() => undefined);
    server.close();
    for (const l of heldLocks) releaseSupervisorLock(l);
    db.close();
  };

  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));

  return { shutdown, adapter, boundPort };
  } // end bootLocked
}

// Entry point: `node dist/app/main.js [--init-only] [--locale hu|en] [--profile <name>]`
const isMain = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const initOnly = process.argv.includes('--init-only');
  const localeIdx = process.argv.indexOf('--locale');
  const localeOverride = localeIdx !== -1 ? process.argv[localeIdx + 1] : undefined;
  const profileIdx = process.argv.indexOf('--profile');
  const profile = profileIdx !== -1 ? process.argv[profileIdx + 1] : undefined;
  boot({
    initOnly,
    ...(localeOverride !== undefined ? { localeOverride } : {}),
    ...(profile !== undefined ? { profile } : {}),
  }).catch((err: unknown) => {
    process.stderr.write(`startup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
