# CITADEL — Architecture & Current-State Map (Phase 0)

> Basis for the upstream→CITADEL rebuild. Real paths verified against the `citadel-build`
> checkout (upstream `develop` @ d64bb2e), correcting the build spec's approximate paths.
> Raw 7-subsystem map: [`docs/phase0-map.json`](./phase0-map.json).

## Baseline (pre-change, 2026-06-07)

- `npm run typecheck` → **clean**.
- `npx vitest run` → **1012 passed, 1 skipped, 4 failed**. The 4 failures are all in
  `src/__tests__/managed-settings.test.ts` — a **macOS-only** managed-settings/sudo path exercised
  on Linux (pre-existing, environmental, NOT a regression). **Regression bar: no new failures.**
- SDK: `@anthropic-ai/claude-agent-sdk@^0.2.117` — **name unchanged** as of June 2026 (verified).
  Primary model `claude-opus-4-8[1m]` (`src/web/agent-config.ts:14`); heartbeat uses `claude-haiku-4-5`.

## Key naming decisions

- **Product / framework / daemon = CITADEL.** Mechanical identifiers use `citadel`:
  `citadel.db`, `citadel.pid`, systemd `citadel.service`, launchd `com.citadel.app`, `CITADEL_ENV`.
- **Main orchestrator agent (the one I chat with) = NEXUS.** `MAIN_AGENT_ID` default `nexus`,
  `BOT_NAME` default `NEXUS`. This drives tmux session `nexus-channels`, agent dir, routing.
- Main-agent route `routes/nexus.ts` (`/api/nexus`) → `routes/citadel.ts` (`/api/nexus`); update
  current `web/app.js` callers (frontend is fully rebuilt in Phase 7 anyway).

## Two Claude invocation paths (Invariant #1)

| Path | Where | Used by |
|---|---|---|
| **Interactive tmux** (subscription pool) | `src/web/channel-monitor.ts` (`buildMainSessionRespawnCmd`:183, `resumeNexusSession`:208 via `tmux respawn-pane -k`:242, `hardRestartNexusChannels`:440); `src/web/agent-process.ts` (`startAgentProcess`:69); `scripts/channels.sh` | main agent + all sub-agents |
| **SDK headless** (`@anthropic-ai/claude-agent-sdk`) | `src/agent.ts` (`runAgent`:107, `query()`) | `src/memory.ts` daily digest:193; `src/heartbeat.ts`:514 (**already deprecated** — `initHeartbeat()` not called, `index.ts:434-448`) |

Conversational agents **must stay interactive**. The new heartbeat already runs as a tmux interactive
agent (`src/web/heartbeat-agent-scaffold.ts`, haiku) driven by `schedule-runner.ts` — Phase 6 extends it.

## Phase → real files

**P1 Rebrand:** `package.json`, `src/config.ts` (DB/PID/MAIN_AGENT_ID/BOT_NAME), `src/index.ts` (banner),
`src/db.ts`, `src/web.ts` (dispatch), `src/web/routes/nexus.ts`→`citadel.ts`, `scripts/setup.ts`,
`install*.sh`/`install-windows.ps1`, `.env.example`, `web/index.html` title, `web/app.js` `/api/nexus` callers.
Collision-safe: schema/table names unchanged; `MAIN_AGENT_ID` is a derived canonical id (NFKD→ascii→kebab).

**P2 Trim** (DELETE files): `src/web/llm-breakdown.ts`, `src/web/token-usage.ts`, `src/web/routes/token-usage.ts`,
`src/web/channel-invites.ts`, `src/web/discord-group-bootstrap.ts`, `src/web/channel-request-watcher.ts`,
`src/__tests__/token-usage.test.ts`, `src/__tests__/kanban-breakdown.test.ts`, `src/__tests__/slack-manifest.test.ts`,
`scripts/smoke-test-slack-channel.sh`. **Slack:** `src/channel-provider.ts` (drop `slackProvider`, type→`'telegram'|'discord'`),
`src/config.ts` (SLACK_*), `src/web/routes/agents.ts` (VALID_PROVIDERS:99, manifest/smoke endpoints),
`src/web/telegram.ts` (`readNexusSlackConfig`), `src/heartbeat.ts:61-65`, `scripts/channels.sh`,
`src/web/channel-poller-reap.ts`. **Wire-out** in `src/index.ts`/`src/web.ts`: `startInviteMonitor`,
`startChannelRequestWatcher`, `ensureDiscordChannelGroup`, `tryHandleTokenUsage`, kanban breakdown endpoint.
**Watchdogs (P2d): KEEP all 5** (channel-health, stuck-tool-call, auto-restart, reauth-healer, channel-monitor)
— map confirms each guards a real failure mode. Trim is essentially a no-op; document that they're retained.

**P3 ntfy:** add `ntfyProvider` (one-way HTTP POST) to `src/channel-provider.ts`; `src/notify.ts` fan-out;
config `NTFY_URL`/`NTFY_TOPIC` in `src/config.ts` + `.env.example`. Not a Claude channel plugin.

**P4 Roster:** `templates/profiles/` (add `data-analyst`, `homelab-full`); seed 7 agents under `agents/`
with baked `CLAUDE.md`+`SOUL.md`+`agent-config.json`; `src/web/agent-team.ts` defaults = NEXUS-hub graph.
Scaffolding `src/web/agent-scaffold.ts` (`generateClaudeMd`:146/`generateSoulMd`:300) — baked-file roster.
Accents: NEXUS cyan, FORGE ember-gold, SPARK electric-yellow, SIGMA violet, RELAY blue, SCREENER green, ORACLE gold.

**P5 Spawn:** gate already main-only; harden in `src/web/routes/agents.ts` POST (cap, approval, sandbox).
Privilege gate must hook **AFTER** trust classification in `src/web/message-router.ts:141-146` (Invariant #4).
Name-selection + internal(`HIDDEN_AGENT_SENTINEL`)/channel agents; reaper → handoff to vault + archive ledger.

**P6 Heartbeat:** extend `src/web/heartbeat-agent-scaffold.ts` + a CPU triage (heuristics over
calendar/email/kanban/health) that escalates via interactive path then ntfy/Telegram; opt-in WSL-GPU
Ollama hook (fallback-first, never blocks).

**P7 PWA/themes/avatars:** `web/manifest.json`+`web/sw.js` (assets cache-first, `/api/*` network-only),
`src/web/routes/static.ts` route; multi-theme `data-theme` (tokens from `../themes/nexus3` default,
`nexus1` Stark HUD, `nexus2` Arcane Forge); avatars `../citadel-avatars/`, glyphs `../citadel-glyphs/`
(CSS applies frame — no double-frame); Tweaks panel theme switcher. Frontend is `web/app.js` (390KB) +
`web/style.css` (118KB) + `web/index.html` (117KB) — largest effort.

**P8 June-15:** SDK name unchanged (keep); confirm model ids live; minimize SDK (digest is last SDK user).

## Invariants (must NOT break)

1. Interactive agents stay interactive (subscription) — never SDK-route conversational agents.
2. Per-agent session/ledger isolation (`agent-{name}` tmux, `conversation_log` per agent_id+chat_id).
3. Trust model: `from_agent` untrusted; `sanitizeAgentIdent` in `message-router.ts` MUST equal the one in
   `routes/messages.ts` 403 guard; `wrapUntrusted`/`wrapTrustedPeer` strip BOTH tag types.
4. No self-escalation: spawn-gate hooks after trust classification; `isTrustedPeer` returns false for
   unknown sender/target before the main-agent shortcut.
5. Memory continuity: `conversation_log` UNIQUE(agent_id,chat_id,direction,message_id); embeddings async.
6. Single daemon: O_EXCL port/pid lock; shared 360s post-respawn grace; never `kill-session` (use `respawn-pane -k`).
