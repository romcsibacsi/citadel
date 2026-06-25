# Architecture

> **Audience note.** This is the developer-facing architecture document and is written in
> English only (per SPEC §7a, code and engineering prose are English). The **operator-facing
> docs ship bilingually** — see `docs/INSTALL.hu.md` / `docs/INSTALL.en.md`,
> `docs/PREREQUISITES.hu.md` / `docs/PREREQUISITES.en.md`, the operator guide, and
> `README.hu.md` / `README.md`.

This document describes the real, shipped system: module boundaries, the data model, the
three pluggability seams, the trust and privilege model, the supervisor/single-owner design,
the main data flows, the recorded design assumptions, what is deliberately deferred, and how
the test suite is organized. It is written so a new engineer (or a buyer) can own the
codebase from here.

Source references use repository paths. The behavioral contract the system was built against
is `SPEC.md`; the build log is `docs/PROGRESS.md`.

---

## 1. System overview and process model

The system runs a **roster of AI agents** coordinated by one **hub agent**. Each agent is a
real, interactive **Claude Code** session inside a **tmux** session (subscription-billed
OAuth, never the API — see §3.3). The operator talks to the hub over **Telegram** (the v1
channel) or by typing directly into any agent from the **dashboard**; the hub delegates work
to specialists through the **kanban board**; agents exchange messages through a **durable
SQLite-backed queue** wrapped in an explicit **trust frame**. Long-term **memory**, an
**idea box** with an **autonomy ladder**, **scheduled tasks** with a nightly **learning
loop**, a two-tier **skills** system, an encrypted **vault**, and a no-framework **SPA
dashboard** complete the core.

The stack is TypeScript/Node (ESM, strict), with **zero runtime npm dependencies** — only
dev tooling (`typescript`, `tsx`, `esbuild`, `playwright`, `@types/node`). Persistence is the built-in
`node:sqlite` (hence the Node >= 22.5 requirement). Branding, roster, locale, ports and
paths are configuration, never code: the shipped seed (`seed/seed.config.json`) defines the
CITADEL brand with the NEXUS hub and a config-driven roster (14 specialists + 1 hub),
but the code itself is brand-neutral.

### 1.1 Exactly one supervisor process

Per SPEC §1, **exactly one supervising process** owns the scheduler, the delivery loop, the
desired-state reconciler, the channel client and the HTTP server. Two enforcement layers:

1. **Pidfile lock** — `src/app/lock.ts`. `acquireSupervisorLock()` creates
   `<stateDir>/supervisor.lock` with `O_EXCL` (0600). If the file exists and its recorded
   PID is alive, startup refuses with an explanatory error. A stale lock (dead PID, or
   PID <= 1 — the PID-recycling guard) is removed and acquisition retried once. The lock is
   released only by the process that owns it: on clean shutdown, and on a boot that fails
   *after* acquisition (e.g. the port bind fails) — a failed boot cannot leave a stale lock
   behind. The system **never kills** another process to take the lock.
2. **Port bind** — the HTTP listen on `config.server.host:port` (default
   `127.0.0.1:7080`) acts as a second, independent singleton lock.

The composition root is `src/app/main.ts` (`boot()`):

- asserts none of the billing denylist (`BILLING_ENV_DENYLIST` in `src/core/billing.ts`:
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX`) is in the environment (hard refusal),
- resolves the state dir, installs the seed config on first run, loads config,
- acquires the supervisor lock (skipped for `--init-only` runs; released again if boot
  fails after this point),
- opens/migrates the database, loads i18n catalogs, materializes the bearer token and the
  vault master key,
- scaffolds the roster idempotently, constructs every store/service, wires the adapter,
  supervisor (subclassed as `ContinuitySupervisor`: every agent (re)start is followed by a
  machine-source, tag-stripped injection of the recent ledger replay — the dashboard chat,
  plus the operator chat for the hub — and the saved task-state resume prompt), reconciler,
  delivery loop, scheduler and (when enabled) the Telegram client,
- registers all API routes, binds the HTTP server, prints the dashboard URL to **stderr
  only** — **with the `?token=` bearer only on first run** (freshly created token file) and
  on `--init-only`; later boots print the URL plus the 0600 token-file path — and
- starts the background loops: run-state snapshot refresh (5 s), delivery tick (5 s),
  scheduler **`reconcileAndTick`** (30 s — **reconcile-first**, §9: the durable never-abandon
  retry queue is processed *before* new cron fires, so a previously-stuck must-run task takes
  precedence over fresh fires on the same tick), reconciler (60 s), memory decay/aging (24 h).

The **initial** desired-state reconcile is fired **in the background, not awaited**: it
starts the desired agents staggered (`runtime.claude.staggerSeconds` each) and can take
minutes for a full roster, so awaiting it inline would stall the delivery, scheduler and
status loops for that whole window. Running it detached makes message delivery live the
moment the server is up, with agents coming online behind it.

```bash
./scripts/install.sh [--locale hu|en] [--yes]   # one-command install (idempotent)
npm start                                        # node dist/app/main.js
npm run dev                                      # tsx src/app/main.ts
npm test                                         # 1161 tests (unit + integration + boot/smoke)
npm run typecheck                                # backend + web SPA strict typecheck
```

### 1.2 State directory

`$ORCHESTRATOR_STATE_DIR` or `~/.orchestrator` (`src/config/load.ts`):

```
config.json            live config (seeded from seed/seed.config.json on first run; 0600)
orchestrator.db        SQLite, WAL mode, pre-created O_EXCL 0600
dashboard-token        bearer token, 0600
master.key             vault master key, 32 random bytes, 0600
supervisor.lock        pidfile lock, 0600
agents/<id>/           per-agent isolation root:
  workdir/             agent cwd (CLAUDE.md = persona + operating contract + tool guide)
  config-root/         CLAUDE_CONFIG_DIR (settings.json with permission rules for strict profiles)
  skills/              agent-local skill scope (absent for the hub — see §2.10)
  agent-token          scoped per-agent API token, 0600
  persona.md           standalone persona doc
  operating.md         standalone operating-contract doc (non-hub only)
  .session-started     resume marker (see assumptions, §6)
skills/                global skill scope
logs/<id>.log          tmux pipe-pane output logs (live-stream source)
learning/nightly-dream.md  the single, atomically overwritten consolidation file
```

---

## 2. Module map

All non-test sources live under `src/`; the dashboard SPA under `web/`. Module boundaries
follow the SPEC concepts one-to-one. Pure decision logic (trust, gate, permissions, routing,
cron, pane-state, splitting) is kept dependency-free and exhaustively unit-tested next to
each module.

### 2.1 `src/core` — primitives

- `clock.ts` — injectable `Clock` (+ `FixedClock` for tests); all timestamps are ISO-8601
  UTC strings via `isoNow()`.
- `fsx.ts` — `atomicWriteFile` (temp sibling + rename, same filesystem), `createExclusive`
  (`O_EXCL`, closes fresh-install TOCTOU windows), `writeIfAbsent` (the
  scaffolding-never-overwrites primitive), `ensureDir` (0700 default).
- `ids.ts` — UUIDs, `newToken()` (32-byte base64url; bearer + agent tokens), and
  `PROCESS_SENTINEL`: the per-process random sentinel used by tag neutralization (§4.2).
- `log.ts` — leveled component loggers writing to **stderr** (stdout stays clean).

### 2.2 `src/config` — the single config surface

- `types.ts` — `OrchestratorConfig`: branding, locale (`default` + independent
  `agentProse`), timezone, server (host/port/allowedOrigins), `hubId`, agents (display
  name, role, model alias, security profile, accent color, auth mode, channel binding, team
  graph, hidden flag, lifecycle), lanes, security profiles, channels, scheduler windows,
  autonomy seed, runtime adapter selection, and the **model alias map**.
- `load.ts` — `resolveStateDir()` / `resolvePaths()` and the **tolerant merge**: every
  section of a missing/malformed config falls back to safe defaults; loading never throws.
- `defaults.ts` — brand-neutral fallbacks: four security profiles (sandbox/draft/
  trusted-build/full-host with privilege levels 0–3), the hard-locked autonomy seed, a
  minimal hub-only roster, locale `hu`, timezone `Europe/Budapest`.

Config writes go through `AppContext.saveConfig()` (`src/app/context.ts`): mutate, persist
atomically (0600), re-load through the tolerant merge, refresh agent tokens.

### 2.3 `src/db` — one SQLite file, additive idempotent migrations

`database.ts` opens the DB (pre-create `O_EXCL` 0600, `journal_mode=WAL`,
`busy_timeout=5000`, `foreign_keys=ON`, `synchronous=NORMAL`) and runs migrations
transactionally, recording applied ids in `schema_migrations` — re-running is a no-op.
Future schema changes are **appended** as new `Migration` entries, never edits to applied
ones.

`migrations.ts` ships the full v1 schema in one migration; **all checked enums were decided
up front** (SPEC §22.5) so no table-rebuild migration is needed later:

| Table | Purpose | Enums / key constraints |
|---|---|---|
| `messages` | inter-agent queue | `status ∈ pending,delivered,done,failed`; partial index on pending |
| `memories` (+ `memories_fts` FTS5 + 3 sync triggers) | memory tiers | `category ∈ hot,warm,cold,shared`; `sector ∈ semantic,episodic`; `archived_at` soft archive |
| `conversation_ledger` | channel transcript | `direction ∈ in,out`; **unique (agent, chat, direction, message_id) where message_id NOT NULL** |
| `daily_logs` | learning-loop activity lines | — |
| `scheduled_tasks` | task definitions | `type ∈ task,heartbeat` |
| `task_last_run` | persisted last-run map (claim-before-deliver) | — |
| `task_runs` | run log | `outcome ∈ delivered,queued,skipped,failed` |
| `task_retry_queue` | never-abandon retries | `status ∈ pending,delivered,cancelled`; `alerted` flag |
| `kanban_cards` | board | `status ∈ planned,in_progress,waiting,done`; `priority ∈ low,normal,high,urgent`; `dispatched_at` once-only guard; `archived_at`; 1-level `parent_id` |
| `kanban_comments` | append-only trail | FK cascade on hard delete |
| `ideas` | idea box | `status ∈ new,reviewed,kanban,rejected,archived`; **unique kanban_id** (one idea per card) |
| `autonomy_settings` | autonomy ladder | `level/max_level ∈ 1..3`, `CHECK(level <= max_level)` |
| `agent_desired_state` | operator intent | `desired ∈ running,stopped` |
| `spawn_requests` | parked spawn approvals | `status ∈ pending,approved,denied,expired` |
| `channel_offsets`, `channel_dedup` | channel client state | dedup PK `(provider, update_id)` |
| `session_map` | chat→session map | — |
| `agent_task_state` | compaction snapshot, one row per agent | — |
| `vault_secrets`, `vault_bindings` | encrypted secrets + env bindings | binding FK cascades on secret delete |

Operator settings are **not** DB rows: they live in `config.json` (file-backed, SPEC §18)
and apply without restart where runtime-switchable. Skills are filesystem, not DB.

### 2.4 `src/i18n` — backend message catalogs

`loadCatalogs()` reads every `locales/<code>.json` as a flat key→string catalog — adding a
third locale is a drop-in file, no code change. The `I18n` class resolves
requested locale → install default → English → the key itself (logged; HU/EN parity is
enforced by tests so the last step never happens in practice). `setLocale()` switches at
runtime. The dashboard has its own parallel catalog set (`web/i18n/*.json`) loaded by the
SPA (§2.14).

### 2.5 `src/trust` — sanitizer, classifier, framing (security-critical)

See §4 for the full model. Files: `sanitize.ts` (THE one sanitizer + reserved ids),
`classify.ts` (trust tiers), `frame.ts` (delivery framing + tag neutralization).

### 2.6 `src/security` — the privilege gate and permission precedence

- `gate.ts` — `evaluateSpawn()`: pure, exhaustively tested verdict function (§4.4).
- `permission.ts` — `decidePermission()`: precedence **deny > ask > allow > defaultMode**;
  glob rules of the form `Tool(spec)`; `resolveRulePlaceholders()` substitutes per-agent
  variables (e.g. `{AGENT_DIR}`) into profile rules. The scaffold writes the resolved rules
  into each strict agent's `config-root/settings.json`, so the Claude Code runtime enforces
  them (§4.5).

### 2.7 `src/messaging` — store + pure route decision + delivery loop

- `store.ts` (`MessageStore`) — persistence and read models only: enqueue (canonicalizes
  both ids with THE sanitizer), pending scans, forward-only status transitions
  (terminal rows are never overwritten), per-peer threads, id-cursor conversation pages
  (so rarely-active threads page exactly like hot ones), recent list.
- `route.ts` (`decideRoute`) — the **pure routing decision**: operator target is terminal;
  the reserved `channel` target is rejected; unknown and hidden targets are rejected;
  generator→generator messages are **consumed** (the SPEC §13 loop-breaker, already wired
  even though the media module is deferred — `mediaAgentIds` is empty today); everything
  else delivers with the classified trust tier.
- `delivery.ts` (`DeliveryService`) — owns timing and retries. No-message-loss invariants:
  a roster-known target is **never** abandoned (`busy` and `down` both just stay pending,
  with no age check on that path, ever); only roster **absence** ages a message out, and
  existence is re-checked against the live roster **before** age on every tick; operator
  messages are handed to the channel and marked delivered immediately (a failed hand-off
  stays pending). `deliverNow(id, {force})` is the forceSend path; `force` bypasses the
  busy gate but cannot conjure a session for a down agent.

### 2.8 `src/memory` — tiers, FTS, ledger, digest

- `store.ts` (`MemoryStore`) — tiers hot/warm/cold/shared; **`shared` is the only
  cross-agent visibility and every recall/list unions it**; there is **no DELETE statement
  in the module** — decay multiplies salience down to a floor, aging moves stale hot rows
  to cold, archive stamps `archived_at`. Search: FTS5 with the sanitized query, LIKE
  fallback when no token survives or FTS throws; returned rows get a salience boost
  (+0.1, cap 2.0) and an `accessed_at` stamp. Embeddings are **async fire-and-forget**
  through the optional provider seam and can neither delay nor fail a save.
- `ftsQuery.ts` — re-tokenizes arbitrary input into plain word tokens (NFKC, lowercase,
  ≤8 tokens), rebuilds a fully-quoted OR query with prefix expansion for tokens ≥3 chars;
  every FTS5 operator is neutralized by construction.
- `ledger.ts` (`ConversationLedger`) — the continuity invariant: inbound rows are
  idempotent via the unique index (duplicate insert reported as `{inserted: false}`, never
  an error); outbound rows carry `NULL message_id` so they never dedupe against each other.
  `buildReplay()` renders the recent transcript with the **open question** (latest inbound
  with no later outbound) marked inline and restated at the end. The replay is **pushed,
  not just pull-based**: the `ContinuitySupervisor` in `src/app/main.ts` auto-injects it
  (dashboard chat for every agent, plus the operator chat for the hub) together with the
  saved task-state resume prompt into every (re)started session — machine-source,
  tag-stripped; `agentctl ledger recall` remains the on-demand pull path.
- `digest.ts` — daily log lines + deterministic daily digest assembly;
  `writeDigestMemory()` persists a digest as an episodic hot memory.
- `embedding.ts` — the provider interface + BLOB (de)serialization; the **default is no
  provider** (FTS-only), see §7.

### 2.9 `src/scheduler` — pure cron, runner, learning machinery, task store

- `cron.ts` — a pure 5-field cron engine with no date library. Timezone evaluation goes
  through `Intl.DateTimeFormat#formatToParts` against IANA zone names. Supports lists,
  ranges, steps (including the `N/step` vixie extension), `@hourly/@daily/@weekly/@monthly`
  aliases, dow 0–7 with 7→0, and the **vixie dom/dow rule** (both restricted → either
  matches). DST behavior is documented and tested: spring-forward-skipped local times never
  fire; fall-back-repeated times fire twice.
- `runner.ts` (`SchedulerService`) — catch-up windows (boot-sized on the first tick after
  construction; persisted `task_last_run` map prevents re-fires across restarts), and
  **claim-before-deliver**: the fire mark is written to `task_last_run` before any delivery
  attempt, so a crash mid-delivery cannot double-fire. Busy/down targets default to the
  **never-abandon retry queue** (one pending row per task+target); `skipIfBusy` is the
  opt-in silent drop; `forceSend` bypasses the busy gate, and `bypass_triage` is treated
  exactly like `forceSend` (unconditional delivery — the SPEC §9 "runs past triage"
  semantics). **Retry-alert idempotency**: at
  the attempt threshold the `alerted` flag is claimed with a conditional UPDATE **before**
  the send (exactly one winner across concurrent passes) and re-armed only on a transient
  (thrown) send failure.
- `learning.ts` — the learning-loop **machinery**: `ensureSeedTasks` (insert-if-absent;
  operator edits survive every restart/upgrade; seed crons fail fast), the nightly-dream
  file contract (one atomically **overwritten** file, `learning/nightly-dream.md`), and
  `isWeeklySection` (Monday-gated in the install timezone — weekday-gated, never
  file-history-gated, because the file is overwritten nightly).
- `taskState.ts` — compaction save/replay: one normalized snapshot per agent
  ({summary, doneSteps, alreadyDelegated, nextAction, pendingDecision}) and
  `buildResumePrompt()` (English protocol text that frames the stored fields as data).
- `taskStore.ts` — dashboard CRUD over `scheduled_tasks` (the runner only reads),
  pending-retry listing and run history.
- `src/app/seedTasks.ts` — the seed **content**: consolidation heartbeat (all agents,
  every 30 min, skipIfBusy), nightly dream (hub, 02:30), dream consumer (hub, 07:00),
  cross-agent sync (hub, 03:15), morning brief (hub, 08:00, forceSend — the **only**
  scheduled task allowed to reach the operator channel).

### 2.10 `src/kanban`, `src/ideas`, `src/autonomy`

- `kanban/store.ts` — store-level enum validation on top of DB CHECKs; `update()` rejects
  the `status` key entirely so `move()` is **the only transition path**, which is what makes
  dispatch impossible to trigger from a generic update. **Dispatch-once**: moving to
  `in_progress` claims `dispatched_at` with one atomic conditional UPDATE — only the
  winning claim fires `onDispatch`, and re-entering `in_progress` never re-dispatches. All
  move hooks are error-tolerant (the move is committed before hooks run; a throwing hook is
  logged, never propagated). Soft archive; `hardDelete` is an explicit operator action
  (orphans children, cascades comments, transactional). `breakdown()` creates parent +
  children atomically with 1-level nesting enforced and lane-routed child assignees.
- `kanban/laneRouter.ts` — the pure "guess the lane" router: config-driven lanes,
  first-match in config order, keywords matched at a **leading word boundary with free
  suffix** so inflected (Hungarian) forms match ("kutat" → "kutatási").
- `ideas/store.ts` — promote creates the linked card and writes the **bidirectional,
  load-bearing link** (`kanban_id` + `status='kanban'`) in one transaction;
  `autoArchiveForCard()` is wired as the kanban `onCardDone` hook; `reconcile()` is the
  sweep that catches hook failures; archive is always soft; archived ideas are immutable.
- `autonomy/ladder.ts` — per-category level 1–3 with `maxLevel` and `locked`.
  `HARD_LOCKED_CATEGORIES` (publish, payment, data-delete, permission-change,
  external-message) is a **code constant**: those categories read as 1/1/locked even from a
  tampered row, `set()` refuses them before any DB read, `seed()` repairs tampered rows and
  forces hostile seeds back to level 1. A **missing category resolves to level 1**
  (fail-safe floor, never fully-autonomous). Seeding is insert-if-absent — operator-set
  levels survive re-seeds.

### 2.11 `src/skills` — filesystem two-tier storage

A skill is a directory containing `SKILL.md` (line-based frontmatter: name, description,
optional `pinned: true`, then the body) plus optional helper files. Two scopes: **global**
(`<stateDir>/skills/`) and **agent-local** (`agents/<id>/skills/`); a local skill shadows
the global of the same name; an agent's effective set never includes another agent's
locals. **Hub special case:** the hub's skill root *is* the global root — `listLocal(hub)`
is `[]`, and any hub "local" mutation redirects to the global scope, implicitly
hub-approved (`resolveSkillTarget`, shared by store and importer so governance cannot
diverge). Progressive loading: Level 0 = the generated index (`index.ts`, deterministic
sorted output, atomic write), Level 1 = the doc body, Level 2 = helper files. The read
endpoint (`GET /api/skills/read/:scope/:name`) honors an explicit `scope=global`: it
resolves through the hub's view (whose root *is* the global root), so the global version
is readable even when a local skill of the same name shadows it.

Governance: global create/patch/delete requires `approvedByHub`; local is free; **pinned
skills are immutable and undeletable in every scope, even with approval**. The importer
(`importer.ts`) validates the entire source tree before writing anything: lexical path
safety, `lstat`-based symlink rejection on every entry, realpath containment, regular files
only, parseable `SKILL.md`, sanitized frontmatter name = target directory name, refusal to
overwrite an existing name, `COPYFILE_EXCL` copies, destination containment re-checked.

### 2.12 `src/vault` — secrets

- `crypto.ts` — AES-256-GCM with a per-secret key derived via **scrypt**
  (N=16384, r=8, p=1 — pinned) from the master key and a **fresh random salt**, plus a
  fresh random 12-byte IV per encryption. Any tampering fails the GCM auth tag.
- `masterKey.ts` — the `MasterKeyBackend` seam. The shipped `FileMasterKeyBackend` creates
  `master.key` (32 random bytes, `O_EXCL` 0600) on first load; an OS-keychain backend can
  plug in behind the same interface (deferred, §7). Only the file *path* is ever logged.
- `store.ts` — API discipline: `listMetadata()` never returns values;
  `getSecretValue(id)` is the single value-returning read; every write re-encrypts with
  fresh salt+IV; bindings map secret id → env var; `resolveRef()` resolves the
  `vault:<id>` config indirection.
- `launchEnv.ts` — just-in-time resolution of `vault:` env values for child-process
  launches; a missing secret fails the launch loudly, naming the id and env var, never a
  value.

### 2.13 `src/channels` — provider interface + Telegram + inbound router

- `provider.ts` — the `ChannelProvider` interface (§3.2) and the normalized
  `InboundEvent`. The **durable-handoff contract**: an update counts as handed off only
  when the handler's promise resolves; a rejection means "re-deliver".
- `telegram.ts` (`TelegramChannel`) — a first-class owned long-poll client that replaces
  the entire plugin recovery layer of the reference system: `getUpdates(offset)` →
  per-update **dedup claim** (`INSERT OR IGNORE` into `channel_dedup`) → awaited handoff →
  **offset persisted only after the whole batch is handed off** (at-least-once; the dedup
  table suppresses replays; a failed handoff releases its claim so the re-served batch
  retries it). Exponential backoff with jitter; a 409 conflict (another consumer on the
  token) jumps straight to max backoff and logs loudly. Outbound: boundary-aware splitting
  to the 4096-char limit, 429 `retry_after` honoring with a retry cap, `sendDocument` for
  media, `getMe` as the token probe. **The token never escapes**: every error/log string
  passes through `redact()`.
- `split.ts` — pure boundary-aware splitting (paragraph → line → sentence → hard cut) with
  the exact-reassembly invariant: `chunks.join('') === input`, byte for byte.
- `inbound.ts` (`InboundRouter`) — server-side sender stamping: the configured operator
  chat stamps `from=operator`; explicitly allowlisted chats stamp `from=channel`;
  **everything else is default-deny** (dropped and logged without the body). The recipient
  is always the hub. The **ledger is written first** — its uniqueness constraint is the
  idempotency guard, so a provider replay skips the enqueue.

### 2.14 `src/runtime` — adapter seam, supervisor, reconciler, Claude/tmux adapter

- `types.ts` — the `AgentRuntimeAdapter` interface (§3.1) plus `AgentBusyState`
  (`ready | busy | needs-input | reauth-needed`), `OutputEvent` and `AgentLaunchSpec`.
- `supervisor.ts` (`AgentSupervisor`) — **the single owner / single serializer**
  (SPEC §3, §20.13). `injectInput(agentId, text, {source, force})` is the ONE path by which
  anything reaches an agent's input; it funnels into a per-agent promise-chain FIFO, so
  exactly one `adapter.writeInput` is in flight per agent, ever — machine delivery and live
  operator typing can never interleave. Busy/needs-input states are waited out
  (poll, default 250 ms); `force` interrupts a busy agent (Escape) then writes, and answers
  a `needs-input` prompt directly. **Reauth is escalate-only**: a `reauth-needed` agent
  never receives input (no credential injection), `onReauthNeeded` fires exactly once per
  episode, and the injection rejects. Operator-source injections call the
  attribution hook **before** the write — if ledger attribution throws, the input is not
  delivered (no unaudited operator input). `streamOutput()` multicasts a single underlying
  adapter subscription to any number of read-only subscribers; a throwing subscriber cannot
  affect the agent or other subscribers; the last unsubscribe releases the adapter
  subscription.
- `reconciler.ts` — `DesiredStateStore` persists operator intent (`agent_desired_state`;
  absent = stopped, intent is opt-in); the `Reconciler` moves reality toward intent each
  pass: stop the running-but-undesired, start the desired-but-down **staggered**
  (`runtime.claude.staggerSeconds`, first start immediate) to avoid a thundering herd after
  a mass outage. Per-agent failures are logged and skipped. The reconciler's roster is the
  **full** config roster — **hidden agents are reconciled like any other** (they are
  excluded from the roster view, the scheduler and routing, not from lifecycle management).
- `fakeAdapter.ts` — the in-memory adapter for tests and `runtime.adapter = "fake"` dev
  mode: scriptable busy state and input handling, manual output emission, full action
  recording. In fake mode `main.ts` wires an echo (`onInput` re-emits the input as output)
  so dashboard watch+type works end-to-end without Claude or tmux.
- `claude/adapter.ts` (`ClaudeCodeAdapter`) — the reference adapter (§3.1, §3a). One tmux
  session per agent (`<sessionPrefix>-<agentId>`) on the fleet's **own dedicated tmux
  server** (see `tmuxDriver.ts` below). **Server-owned, persistent sessions.** The session
  is owned by the dedicated tmux *server*, not by the supervisor process, so it **outlives a
  supervisor restart**. `start()` is therefore **idempotent and adopts**: if the session
  already exists it re-wires the watch stream and returns — it never recreates it (recreating
  would drop the agent's state and the operator's attach, and "duplicate session" was a real
  bug). A fresh supervisor process finds every agent still alive and adopts them. `start()`
  **refuses any launch spec containing `ANTHROPIC_API_KEY`** and additionally force-unsets it
  via `env -u` in the launch command. **Recovery = respawn-in-place** (`respawn()`): replace
  ONLY this agent's session (stop+start), **never the tmux server** — a peer agent on the
  same server survives one agent's respawn. A **post-respawn grace window**
  (`respawnGraceMs`, default 30 s) makes respawn a no-op if the agent was (re)started within
  the window, so stacked recovery paths cannot restart the same agent repeatedly. **First-run
  seeding** (`ensureClaudeOnboarded`): before the very first
  launch the adapter writes Claude Code's onboarding flags into the agent's isolated
  `$CLAUDE_CONFIG_DIR/.claude.json` — `hasCompletedOnboarding`, the per-workdir project
  trust (`projects[cwd].hasTrustDialogAccepted` + `hasCompletedProjectOnboarding`), and —
  for permissive/bypass profiles launched with `--dangerously-skip-permissions` —
  `bypassPermissionsModeAccepted`. Without these the session would block forever on the
  interactive theme picker, the "do you trust this folder?" dialog, or the one-time bypass
  acceptance prompt. The write is an **idempotent merge**: only missing flags are filled,
  existing state and operator edits are preserved, and it happens before the session
  starts so there is no race with a live agent. **Shared subscription auth**
  (`ensureSharedSubscriptionAuth`): the adapter **symlinks** the host's
  `~/.claude/.credentials.json` into the agent's isolated config dir so every agent runs
  on the host's subscription OAuth login instead of falling back to metered API billing
  (see §3.3 and the assumptions, §6). A symlink rather than a copy means a token refresh
  lands in one place; it is a no-op when the host uses keychain auth or is not logged in
  (the reauth escalation then surfaces it). After `tmux new-session -d` (which returns
  before the pane registers) `start()` **polls `hasSession`** before wiring `pipe-pane`,
  so the new-session liveness race cannot crash it — and a command that exits immediately
  (a misconfigured launch) is reported as such instead. Output streaming: the on-disk
  `pipe-pane` log at `logs/<id>.log` is kept for debug/continuity, but the **live watch
  stream emits full rendered `capture-pane` snapshots** (`pollScreen`, `OutputEvent`
  `kind: 'screen'`) that REPLACE the view — the raw `pipe-pane` byte stream is full of
  cursor-positioning escapes and is unreadable when appended. **Status (discrete classifier,
  §3a):** capture the last 30 pane lines, narrow to the live footer region, classify into
  one discrete state (`idle | busy | typing | error | unknown`). "busy" is **turn-scoped** —
  the adapter keeps a per-agent turn flag (set when input is submitted, cleared only when
  idle is confirmed), so a submitted turn reads as busy via the counter rather than by
  spinner-word matching. An apparent `idle` is **confirmed with a second sample**
  ~`idleConfirmMs` (default 250 ms) later, so a momentary blank between turns is never read
  as ready. **Input delivery (`writeInput`, §3a):** dismiss any modal first (Escape), mark
  the turn active, deliver the text as chunked literal paste plus a **separate** submit
  keystroke (via the driver), then a **bounded retry** (default 2) scoped to the live input
  box — if the footer still shows our un-submitted text, press Enter again. All of this runs
  behind the supervisor's single serializer, so machine and operator input never interleave.
- `claude/paneState.ts` — **pure** discrete-state TUI heuristics (§3a). The discrete state
  set is `idle | busy | typing | error | unknown`. `footerRegion()` **anchors to the live
  input box**: it scopes classification to the region from the last input-affordance line
  (the box border / `>` prompt / status separators) to the end of the last 15 non-padding
  lines, so a busy/error phrase merely *quoted in scrollback* — an agent talking about "esc
  to interrupt", or a spinner verb in history — is excluded and can never classify the agent
  as busy ("permanently stuck" incidents in the reference system). `classifyPaneState(footer,
  turnActive)` combines the stateless footer read with the adapter's **turn counter**, in
  this precedence: auth error (`error`) > active turn — a spinner glyph **with the live
  ellipsis** "…", or "esc to interrupt" (`busy`) > a turn in flight per the counter
  (`typing`) > a modal/permission/trust prompt (`error`) > the idle input box (`idle`) >
  nothing recognized (`unknown`, treated as not-injectable). So a spinner verb is busy **only
  with an active-turn signal**, not on its own; the busy state is owned by the runtime
  counter, not by spinner-word matching. Two refinements from live use: the
  **bypass-permissions idle status** ("⏵⏵ bypass permissions on", "← for agents") reads as
  `idle`, so a ready bypass-mode agent (the hub and trusted-build agents) is no longer
  misread as busy and starved of deliveries; and the **spinner busy-marker requires the live
  ellipsis** "…", so a *completed* action line that keeps the glyph but drops the ellipsis
  ("Brewed for 3s", "Pondered for 12s") is not mistaken for an active turn.
- `claude/tmuxDriver.ts` — thin promisified tmux wrappers over `execFile` (never a shell at
  the Node level; the one string tmux's default-shell interprets is built exclusively from
  `escapeShellArg`'d pieces, env passed via an `env(1)` prefix). **Dedicated socket (§3a/
  §19a):** every command runs against an explicit `-L <socket>` server, so the fleet's agents
  live on their **own** tmux server — fully isolated from the operator's default-server tmux
  sessions and from any other fleet. The system **never touches the default server**. The
  socket comes from `runtime.claude.socket` (config) and **defaults to the `sessionPrefix`**
  when absent (`config.runtime.claude.socket ?? sessionPrefix` in `main.ts`; the seed sets it
  to `citadel-mux`). The server is started by the first session command and daemonizes — it
  is **not a child of the supervisor**, which is why sessions persist across a supervisor
  restart. **`env -i` launch isolation:** `new-session` runs the agent under `env -i`, which
  clears the inherited environment entirely; the agent receives **only** the explicit
  allowlist the spec factory builds (`HOME`, `PATH`, `LANG`, `CLAUDE_CONFIG_DIR`, `AGENT_ID`,
  `AGENT_TOKEN_FILE`, `ORCHESTRATOR_URL`). No inherited channel/bot token and no `ANTHROPIC_*`
  can leak into an agent — this *is* the channel isolation for non-chat agents (§19a): the
  bot token never reaches an agent's env. Targets use `=name` for **exact** session matching
  (plain names are prefix-matched by tmux and could kill the wrong agent) and `=name:` for
  pane-level commands (verified against tmux 3.4 — see §6). Input is **buffer-pasted** through
  a **unique named buffer** per write (`load-buffer -b orch-<pid>-<seq>` from stdin +
  `paste-buffer -d -p -b …`, deleted on paste), chunked under the bracketed-paste cap — the
  anonymous tmux buffer stack is server-global and would cross texts between agents, so named
  buffers make concurrent multi-agent input race-free. Enter is sent as a **separate** key so
  a trailing newline cannot double-submit. `listPanes()` (pane pid + session, for orphan
  attribution, §19a) and `serverRunning()` feed the watchers; `killServer()` is **teardown/
  test only — never a recovery path**.
- `watchers.ts` — **pure**, record-first substrate watchers (§19a). Each watcher records
  evidence before acting and only ever clears a flag it itself set: `evaluateFrozenTool`
  detects a frozen tool-call by **wall-clock stagnation + low CPU** (an unchanged screen for
  `stagnationMs` while CPU is below `cpuIdleBelow` — a real long turn would move the screen
  or burn CPU) and asks for a **respawn-in-place**, grace-guarded against re-firing;
  `evaluateAlertOnly` covers **stuck-permission** and **API-error** as **alert-only** —
  record + notify the operator **exactly once per episode** and **never auto-act**, re-arming
  only when the condition clears; `evaluateStuckInput` re-submits input that never landed,
  bounded so it cannot loop forever.
- `watcherService.ts` (`WatcherService`) — wires the pure watchers to the live runtime. Each
  `tick()` over the roster: alert-only stuck-permission/API-error, then a frozen-tool check
  that **respawns in place** (never the server). `reapOrphans()` runs the orphan reaper
  before a spawn, and `sampleCpu`/`safeListPanes` provide the CPU fraction and live pane set
  from `/proc` + the dedicated tmux server. `safeListPanes()` returns **`undefined`** when
  the pane set genuinely can't be determined, which the reaper treats as the fail-safe below.
- `reaper.ts` — **pure** orphan reaping by **pane attribution** (§19a). A process is an
  orphan **iff** neither it nor any ancestor is a live multiplexer-pane pid — attribution is
  by the process tree, **not** by argv matching (argv matching reaps the wrong process). The
  **fail-safe is load-bearing**: if the live-pane set is `undefined` (undeterminable), it
  **refuses to reap** (`panes-undeterminable`) — a wrongly-reaped live poller would hammer
  the bot token, cause provider 409 conflicts, and read as "down". `procInfo.ts` supplies the
  `/proc` parent-pid and CPU-jiffies helpers (`parentPid`, `cpuJiffies`, `procAvailable`); on
  a non-Linux host the frozen-tool CPU gate simply never fires.

- `gitWorktree.ts` — **per-agent git isolation (#44)**. Each agent works in its own git
  worktree, provisioned into the agent lifecycle (wired through `supervisor.ts` /
  `specFactory.ts`) so concurrent agents never collide on a shared checkout's `HEAD`.
  Provisioning is **fail-safe against data loss**: an existing dirty/edited worktree is
  preserved, not clobbered. The judge-panel solvers reuse the same mechanism — each
  competing solution lives in a separate worktree.

### 2.15 `src/server` — auth, router, SSE, static, routes

- `auth.ts` — `loadOrCreateBearer` (32 random bytes, `O_EXCL` 0600); `tokensEqual`
  (SHA-256 then `timingSafeEqual` — constant-time, no length leak); `checkAuth` implements
  the policy: everything outside `/api/` is public static; `/api/auth/status` and
  `/api/agents/avatar/*` are the public exceptions; `?token=` is accepted only for GETs
  matching the policy predicate (the per-agent SSE stream; the raw-file path is reserved
  for the deferred file browser); bearer = `operator`, a per-agent token = `agent` with
  the agent's identity (§4.3). `checkOrigin` rejects state-changing requests with a
  foreign `Origin` and **allows missing Origin** (same-origin browsers may omit it);
  allowed origins = the server's own bind origins + `server.allowedOrigins`.
- `router.ts` — a minimal router that prefers routes with more static segments, making
  "specific before catch-all" unorderable rather than a registration convention. JSON
  bodies are size-capped (1 MiB) and drained on overflow.
- `sse.ts` — non-blocking SSE helper (push-only, heartbeat comments every 25 s).
- `static.ts` — SPA serving with lexical (`..`) **and** realpath (symlink) containment,
  SPA fallback to `index.html`, no-cache for HTML.
- `server.ts` — the single pipeline: auth gate → origin gate → API router → static last.
  API error responses are **localized at the boundary**: routes (and `domainError.ts`,
  which maps domain-layer errors) throw `HttpError`s carrying a stable i18n key; the
  server translates the key through the backend HU/EN catalogs and responds with
  `{error: <localized message>, key: <stable-key>}` — clients match on the key, humans
  read the message in the operator's language.
- `routes/*.ts` — one file per surface: `status` (public auth probe + `/api/status`),
  `agents` (CRUD, lifecycle, live `:id/stream` SSE, `:id/input`, avatar SVG, hub identity +
  restart, spawn-request queue), `messages` (public write guard, operator endpoint, status
  updates), `memories` (CRUD-without-delete, search, stats, daily log, ledger recall),
  `kanban`, `ideas`, `autonomy`, `schedules` (+ agent task-state + the dream file),
  `skills`, `vault`, `channels` (Telegram bind/test; raw tokens go **into the vault**,
  only the `vault:` ref lands in config), `settings` (locale/timezone/branding; backend
  locale switch is live).

### 2.16 `src/app` — composition

`main.ts` (boot, §1.1), `context.ts` (the `AppContext` shared by routes and services),
`lock.ts` (§1.1), `scaffold.ts` (idempotent roster scaffolding — directories, per-agent
token, `CLAUDE.md` = persona + operating contract + tool guide rendered from the seed
templates in the configured prose language, standalone `persona.md`/`operating.md`,
`settings.json` permission rules for strict profiles; **`writeIfAbsent` everywhere — an
existing file is never overwritten**), `specFactory.ts` (per-agent `AgentLaunchSpec`:
`--continue` only when a session marker exists, model alias resolution,
`--dangerously-skip-permissions` for permissive profiles, env with `CLAUDE_CONFIG_DIR`,
`AGENT_ID`, `AGENT_TOKEN_FILE` (the *path* to the 0600 per-agent token file — the token
value never enters argv or any tmux launch string), `ORCHESTRATOR_URL`, and `scripts/`
prepended to PATH so `agentctl` resolves), `seedTasks.ts` (§2.9).

`scripts/agentctl` is the agent-side CLI: identity comes from the scoped token read from
`AGENT_TOKEN_FILE` (`AGENT_API_TOKEN` is still honored for manual use; the server stamps
`from` from the token — the CLI cannot forge a sender); subcommands cover messages,
memory, kanban (including `kanban add <title> [--desc] [--assignee] [--priority]`), ideas,
daily log, task-state save/load, ledger recall and the dream file.

### 2.17 `web/` — the no-framework SPA

TypeScript bundled by esbuild (`scripts/build-web.mjs`) into `web/dist`; no framework, no
runtime deps. `index.html` applies **theme and language pre-paint** from `localStorage` in
an inline script (no flash of wrong style). `api.ts` performs the one-time `?token=`
bootstrap (store in `localStorage`, strip from the URL via `history.replaceState`).
`theme.ts` swaps the design-token set live via `data-theme` (themes: **arcane** — the
original dark default — and **daylight**; tokens in `web/styles/tokens.css`). `i18n.ts`
mirrors the backend fallback chain and re-renders on switch, no reload. `views/` registers
fleet, agent (live watch + type + interrupt over the SSE stream and the input endpoint —
for the Claude/tmux adapter the watch stream delivers full rendered `kind:'screen'`
snapshots that replace the view, not a raw byte append), kanban, ideas (+ the autonomy
ladder panel), approvals, memories, schedules, skills, vault, channels and settings. PWA: `manifest.webmanifest` + `sw.js`, whose fetch handler is
**network-only for `/api/*`** (API responses are never cached, auth never intercepted);
the static shell is cache-first with background refresh.


---

## 3. The three seams (SPEC §0)

These are the load-bearing pluggability boundaries. Everything fragile or vendor-specific
is contained behind them.

### 3.1 `AgentRuntime` adapter — `src/runtime/types.ts`

```ts
interface AgentRuntimeAdapter {
  start(spec: AgentLaunchSpec): Promise<void>;
  stop(id: string): Promise<void>;
  isRunning(id: string): Promise<boolean>;
  status(id: string): Promise<AgentStatus>;       // running, since, busyState, needsReauth
  writeInput(id: string, text: string): Promise<void>;
  interrupt(id: string): Promise<void>;
  subscribeOutput(id: string, cb: (e: OutputEvent) => void): () => void;
}
```

**Why the reference adapter drives an interactive tmux TUI.** This is a billing constraint,
not an engineering preference (SPEC §5, verified June 2026): the interactive Claude Code
TUI is the only effectively-unlimited subscription-billed surface. The in-process Agent SDK
is pay-as-you-go API with no subscription path; headless `claude -p` draws from a small
capped metered credit. So the default adapter must drive a terminal — and all the
fragility that implies (pane-state heuristics, buffer-paste input, log tailing) is
**contained in `src/runtime/claude/`** and made safe by the supervisor's
single-owner/single-serializer rule: nothing else in the system ever touches tmux, parses a
pane, or writes to an agent's input. The fleet runs on its **own dedicated tmux server**
(`tmux -L <socket>`, §2.14) — isolated from the operator's own tmux and from any other fleet,
and **server-owned** so the agent sessions persist across a supervisor restart and the new
supervisor adopts them. Recovery is **respawn-in-place** (one agent's session, never the
server); the substrate watchers + the pane-attribution orphan reaper keep it healthy (§2.14,
§19a). The billing tripwire is the shared denylist
(`BILLING_ENV_DENYLIST` in `src/core/billing.ts`: `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`), enforced in
three places: `install.sh`, supervisor startup, and the adapter at launch (refusal of any
offending launch spec + `env -u` strip of all four).

**Adding a new adapter:** implement the interface (see `fakeAdapter.ts` for the minimal
shape), honor the busy/ready semantics in `status()`, and add a branch in the adapter
selection in `src/app/main.ts` (today: `'claude-code' | 'fake'` from
`config.runtime.adapter`). Nothing above the supervisor changes — delivery, scheduler,
dashboard watch+type, and the reconciler all talk to the supervisor only.

### 3.2 `ChannelProvider` — `src/channels/provider.ts`

`send`, optional `sendMedia`, `validateToken`, `splitMessage`, a stable `id`, plus the
inbound side via the durable `InboundHandler` contract. Telegram is the v1 reference
provider. **Adding a provider:** implement the interface with its own reconnecting client
(persist offsets in `channel_offsets`, dedup in `channel_dedup`, keyed by your provider
id), reuse `split.ts` for message splitting and `InboundRouter` for stamping/ledger/
enqueue, add a config section (`config.channels.<provider>` with a `vault:` token ref) and
wire it in `boot()` next to the Telegram block. The trust layer needs no changes — inbound
text arrives as a `<channel>`-framed queue message regardless of provider.

### 3.3 LLM / model layer — the alias map

Per-agent `model` strings resolve through `config.modelAliases`
(`src/app/specFactory.ts`); the resolved id is passed as `--model`. No model lineup is
hardcoded anywhere. Auth is the host's subscription OAuth login (the `claude` CLI's own
state under each agent's `CLAUDE_CONFIG_DIR`); per-agent `authMode` is config data for
own-credentials/api-key opt-ins. The per-agent isolation vs single-subscription tension is
resolved by a **shared-credentials symlink** (the adapter's `ensureSharedSubscriptionAuth`,
§2.14): each agent's working state — sessions, transcripts, settings, permissions — is
isolated under its own config dir, but the OAuth login is shared by symlinking the host's
`~/.claude/.credentials.json` into that dir, so every agent runs on the subscription
(Claude Max) rather than metered API billing. A symlink (not a copy) keeps a token refresh
in one place; see the assumption in §6. Alternate backends (Anthropic-compatible base-URL local
models, etc.) plug in by extending the spec factory's env/args for the affected agents —
the seam is the launch spec, and any such key must come from the vault, never config/argv.

**Adding a locale** is a drop-in pair of catalogs: `locales/<code>.json` (backend) +
`web/i18n/<code>.json` (dashboard) — no code change; the switchers list locales
dynamically. **Adding a theme** is a new token block in `web/styles/tokens.css`
(`[data-theme="<id>"]`) plus the id in `THEMES` (`web/src/theme.ts`).

---

## 4. Trust & privilege model

### 4.1 One sanitizer, reserved ids — `src/trust/sanitize.ts`

`sanitizeId()` is THE sanitizer: NFKC normalization (defeats confusable forms), lowercase,
strip everything outside `[a-z0-9-]`, collapse/trim dashes, cap at 64 chars. Stripping
(not replacing) is deliberate: `"op.er.ator"` canonicalizes to `operator` and is caught by
the reserved-id check. The reserved identities `operator` and `channel` are **code
constants**, never config. The same function is used by the public write guard (to
*reject*), the classifier/router (to *match*), the stores (to canonicalize storage), skills
(name hygiene) and scaffolding — a second implementation would be a forgery bypass, so
there is none. Config load applies the same rule to the roster itself: an agent entry
whose id **sanitizes to a reserved identity** (`operator`, `channel`) is dropped at load
time (`src/config/load.ts`, logged) — a config edit cannot smuggle a reserved identity
into the fleet.

### 4.2 Tier classification and framing — `classify.ts`, `frame.ts`

`classifyTrust()` never derives trust from the raw string: reserved tiers match code
constants; the **known-agent check runs before the hub shortcut**, so an unknown id can
never ride the hub's implicit-peer status; everything unknown is `untrusted`. Five tiers:
`operator`, `channel`, `hub`, `trusted-peer`, `untrusted`.

`frameDelivery()` wraps **every** delivery (a freshly restarted agent has no memory of
prior framing) in a typed frame with an inline English preamble explaining the trust
semantics. Before framing, `stripSecurityTags()` neutralizes **all** recognized security
tag names — open, close, self-closing, with attributes, any nesting — replacing each with
a marker carrying the **unpredictable per-process sentinel**
(`PROCESS_SENTINEL`, fresh random hex per process), so a forged tag can neither open nor
close a real frame and the attacker cannot guess the replacement. The `<channel>` envelope
is deliberately preserved with system-supplied routing attributes (source, chat id,
message id, user, ts — defensively escaped); its body remains untrusted.

### 4.3 Per-agent API tokens — server-side stamping beyond spec

Each scaffolded agent gets a 32-byte token in `agents/<id>/agent-token` (0600), loaded
into the auth layer at boot. `checkAuth` resolves a presented bearer to
`{kind: 'agent', agentId}` (constant-time comparisons). The messaging write endpoint then
**overrides any self-asserted `from` with the authenticated agent id**, agents may only
update messages addressed to themselves, memory routes force the agent's own id, the dream
file is hub-only, and programmatic spawn requires an agent token. Agent tokens are also
**self-scoped** (decided and enforced, no longer an open question): an agent token cannot
watch another agent's live stream or read another agent's status (403), and memory
reads/updates/archives are pinned to the holder's own id — another agent's memory row is
simply a 404. This is a hardening layer *on top of* the SPEC §6 reserved-id rejection
(which still protects the non-token path): even a confused agent process cannot
impersonate or probe a peer, the operator, or the channel.

### 4.4 The privilege gate — `src/security/gate.ts`

Pure and exhaustively unit-tested; the caller resolves trust classification and privilege
levels **before** calling, so a forged `from` can never reach the gate claiming to be the
hub. Verdict order:

1. requested level > **2** (`SPAWN_CEILING`) → **deny** — absolute, even for the operator
   via the dashboard; level-3 (full-host) exists only as pre-seeded roster.
2. dashboard origin → **allow** (the operator's authenticated action is the human
   approval, up to the ceiling).
3. programmatic without a requester id → **deny**.
4. programmatic non-hub requester → **deny** (only the hub spawns programmatically).
5. requested level > requester's own level → **deny** (no self-escalation).
6. requested level ≤ 0 (`AUTO_SPAWN_MAX`) → **allow**; levels 1–2 → **park** as a pending
   `spawn_requests` row requiring dashboard approval (which re-runs the gate as a
   dashboard-origin evaluation).

Seed-roster agents (ids from `seed/seed.config.json`, plus the hub) are delete-protected
in the API. The spawn ceiling applies to **profile changes too**: `PATCH /api/agents/:id`
refuses any profile above level 2 for every agent, seed or not — the full-host profile
exists only as pre-seeded config and cannot be assigned through any API path.

### 4.5 Permission precedence and the strict sandbox — `src/security/permission.ts`

`decidePermission()` implements **deny > ask > allow > defaultMode**; with
`defaultMode = bypassPermissions` the result is "no prompts, but deny rules still win" —
which is what makes `strict` + `bypassPermissions` a **real sandbox** (the seed `sandbox`
profile: agent-dir-only file access, `Bash(*)`/`WebFetch(*)`/global reads denied). For
strict profiles the scaffold writes the resolved rules into the agent's
`config-root/settings.json`, so the Claude Code runtime itself enforces them; permissive
profiles launch with `--dangerously-skip-permissions` (the lists become advisory, which is
the documented meaning of "permissive"). Rule globs treat `*` as crossing `/` — see §6.

---

## 5. Data flows

### 5.1 Inbound Telegram → hub

```
Telegram getUpdates(offset)                      src/channels/telegram.ts
  → dedup claim (channel_dedup INSERT OR IGNORE)  — replays suppressed
  → InboundRouter.handle()                        src/channels/inbound.ts
      chat = operatorChatId  → from=operator (server-stamped)
      chat allowlisted       → from=channel
      otherwise              → default-deny drop
      ledger.recordInbound() FIRST — unique index = idempotency guard
      messages.enqueue({sender, recipient: hub, channelMeta})
  → offset persisted only after the whole batch is handed off (at-least-once)
DeliveryService.tick() (5 s)                      src/messaging/delivery.ts
  → decideRoute() against the live roster
  → frameDelivery() (<operator>/<channel> frame, tags neutralized w/ sentinel)
  → supervisor.injectInput(hub, framed, {source:'machine'})  — the single serializer
  → markDelivered (busy/down: stays pending, retried forever)
```

The hub replies by `agentctl msg send operator <text>` → queue → `operator-terminal` route
→ `notifyOperator()` → Telegram send (split into ≤4096-char chunks) + an outbound ledger
row (NULL message id).

### 5.2 Operator dashboard typing (watch + type)

```
SPA agent view: EventSource /api/agents/:id/stream?token=…   (SSE; query token allowed)
  ← supervisor.streamOutput() — one adapter subscription, multicast fan-out
POST /api/agents/:id/input {text, force?}                    (bearer; operator-only)
  → supervisor.injectInput(id, text, {source:'operator', force})
      attribution hook runs BEFORE the write:
        ledger.recordInbound(agent, 'dashboard', 'op-<uuid>', '<operator-injected label>: …')
      a throwing ledger aborts the write — no unaudited operator input
      force=true interrupts (Escape) a busy agent, then writes
```

The dashboard is one `streamOutput` subscriber and one `injectInput` producer; it is never
wired to tmux directly.

### 5.3 Kanban dispatch-once

```
POST /api/kanban/cards/:id/move {status:'in_progress'}
  → KanbanStore.move(): status UPDATE commits first
  → atomic claim: UPDATE … SET dispatched_at=now WHERE id=? AND dispatched_at IS NULL
  → only the winning claim runs onDispatch (error-tolerant):
      sanitize assignee; no-op for '', operator, unknown roster id, non-running agent
      supervisor.injectInput(assignee, wake text, {source:'machine'})
  → re-entering in_progress later: claim loses, no re-dispatch
  → move to done: onCardDone → ideas.autoArchiveForCard (the soft auto-archive);
      ideas.reconcile() sweeps anything a failed hook missed
```

### 5.4 Scheduler fire → busy → retry queue → alert

```
SchedulerService.tick() (30 s; boot window on the first tick)
  for each enabled task: firesInWindow(cron, max(window start, last_run), now, tz)
    CLAIM the mark in task_last_run BEFORE delivering (crash ⇒ no double fire)
    deliver(target or roster fan-out for 'all'):
      delivered → task_runs('delivered')
      busy/down + skipIfBusy → task_runs('skipped')        (opt-in silent drop)
      busy/down otherwise → task_retry_queue (one pending row per task+target)
processRetryQueue() (same 30 s loop)
  rows whose last attempt ≥ retryIntervalMinutes old → re-deliver
  at attempts ≥ threshold (6): claim alerted=1 (conditional UPDATE, one winner)
    → onAlert → operator channel; a THROWN send re-arms alerted=0
  operator cancel: POST /api/schedules/retries/:id/cancel
```

### 5.5 Nightly learning loop (seed content, hub-targeted)

```
*/30 * * * *  heartbeat (all agents, skipIfBusy): memory save + daily-log line + skill reflection — silent
02:30         nightly dream (hub): reads daily logs + memory, OVERWRITES learning/nightly-dream.md
              (atomic replace; weekly section only on Mondays — weekday-gated)
03:15         cross-agent sync (hub): shared-tier observations about the fleet
07:00         dream consumer (hub): proposals → local skills / kanban cards / idea box — silent
08:00         morning brief (hub, forceSend): the ONE scheduled task allowed to message the operator
```

Background tasks must never message a live channel; only the morning brief deliberately
does, via the hub.

---

## 6. ASSUMPTIONS (recorded design decisions)

These are deliberate, documented choices a maintainer should not "fix" casually.

1. **Security-frame preambles are English protocol text.** The trust-frame preambles, the
   ledger replay header, the resume-prompt skeleton, the skill index and the scheduled-task
   wrapper are machine-protocol text addressed to the agent, not operator prose — the
   SPEC §7a localization rule applies to operator-facing surfaces. (Agents are separately
   instructed to *write operator-facing prose* in the configured language.)
2. **Permission rule globs: `*` crosses `/`.** `src/security/permission.ts` compiles both
   `*` and `**` to `.*`. Over-matching is deny-biased: precedence gives deny absolute
   priority, so a greedy wildcard can only ever widen a deny, never weaken one. Allow-rule
   authors should write precise rules.
3. **tmux pane target form `=name:`** — the `=` prefix forces exact session-name matching
   (plain names are prefix-matched and could address the wrong agent); the trailing `:`
   selects the session's active window/pane for pane-level commands. Verified against
   tmux 3.4.
4. **`--continue` resume marker file.** `agents/<id>/.session-started` records that a
   session has existed; the spec factory passes `--continue` only when the marker exists
   and `fresh` was not requested — a first launch must never `--continue` (Claude Code
   errors on resume-with-no-session). `fresh: true` skips resume but keeps the marker.
5. **Fake-adapter echo mode.** With `runtime.adapter = "fake"`, agent input is echoed back
   as output so watch+type and the smoke tests exercise the full path without Claude/tmux.
6. **Seed roster ids are delete-protected.** Ids read from `seed/seed.config.json` (plus
   the hub) cannot be deleted via the API. The full-host profile exists **only as
   pre-seeded config** — no API path (create, spawn, or profile change) can assign a
   profile above privilege level 2 to any agent, seed included.
7. **Operator settings are file-backed** (`config.json` via `saveConfig`), not DB rows;
   the backend UI locale switches live, channel enablement applies at the next supervisor
   start (the API says so: `restartRequired: true`).
8. **Dedup table growth.** `channel_dedup` rows are never pruned in v1 (a janitor is
   deferred); growth is one row per inbound update and is acceptable for a single-operator
   install.
9. **Agent tokens at rest are 0600 files**, one per agent (`agents/<id>/agent-token`),
   created `O_EXCL` at scaffold time and re-read on config changes — not DB rows, so a DB
   leak alone does not leak agent credentials.
10. **Pane classification defaults to `busy`.** When no marker is recognized, the safe
    answer is "do not inject"; delivery just retries on a later tick. Two live-tuned
    markers: the bypass-permissions idle status ("⏵⏵ bypass permissions on", "← for
    agents") reads as ready, and the spinner busy-marker requires the live ellipsis "…" so
    a completed action line ("Brewed for 3s") is not mistaken for an active turn (§2.14).
11. **Scaffolding re-fills deleted docs.** `writeIfAbsent` cannot distinguish
    "operator deleted this file" from "never created"; operators customize by *editing*
    files (edits are never overwritten), not by deleting them.
12. **Subscription credentials are shared by symlink.** Each agent's working state
    (sessions, transcripts, settings, permissions) is isolated under its own
    `CLAUDE_CONFIG_DIR`, but the host's `~/.claude/.credentials.json` is **symlinked** into
    every agent's config dir so all agents run on the one subscription OAuth login, never
    metered API billing (`ensureSharedSubscriptionAuth`, §2.14/§3.3). A symlink, not a
    copy, so a token refresh lands in one place; a no-op under keychain auth / not-logged-in
    (the reauth escalation surfaces that).
13. **First-run onboarding is seeded, not answered live.** Before an agent's first launch
    the adapter writes Claude Code's onboarding flags into the isolated `.claude.json`
    (`hasCompletedOnboarding`, per-workdir project trust, and `bypassPermissionsModeAccepted`
    for permissive profiles) as an idempotent merge, so the session never blocks on the
    interactive theme/trust/bypass prompts (`ensureClaudeOnboarded`, §2.14).
14. **The fleet owns a dedicated tmux server; sessions outlive the supervisor.** Agents run
    on `tmux -L <socket>` (`runtime.claude.socket`, defaulting to `sessionPrefix`; the seed
    uses `citadel-mux`), never the operator's default server. The server is not a child of
    the supervisor, so agent sessions **persist across a supervisor restart** and `start()`
    **adopts** an existing session rather than recreating it. Recovery is **respawn-in-place**
    (one agent's session) — the system **never kills the tmux server** as a recovery path
    (`killServer()` is teardown/test only). To fully stop the fleet, kill the server
    explicitly: `tmux -L <socket> kill-server` (§2.14, §3.1; deploy note in `INSTALL.*`).
15. **Agents inherit no environment but a fixed allowlist (`env -i`).** The launch clears the
    inherited environment entirely and passes only `HOME`, `PATH`, `LANG`,
    `CLAUDE_CONFIG_DIR`, `AGENT_ID`, `AGENT_TOKEN_FILE`, `ORCHESTRATOR_URL` — so no inherited
    channel/bot token and no `ANTHROPIC_*` can leak into an agent. This is the channel
    isolation for non-chat agents (§19a): the bot token never reaches an agent's env (§2.14).

---

## 7. Deferred modules and their seams

Deferred per SPEC §21/§22 (see `docs/PROGRESS.md`); each has a clean seam already in the
shipped code, so none requires re-architecture:

| Deferred module | Existing seam |
|---|---|
| Studio / media generation (SPEC §13) | The async-job interface is specified; the **generator loop-breaker already ships** in routing (`decideRoute`'s 3-way pass/dispatch/consume over `RouteContext.mediaAgentIds`, currently an empty set wired in `src/app/context.ts`). |
| Background one-shot task runner (SPEC §14) | Detached runs are an adapter concern behind `AgentRuntimeAdapter`; the DB pattern (atomic count+insert cap, orphan reconciliation) is described in the spec. |
| Dashboard file browser (SPEC §17) | The containment helpers exist in `src/server/static.ts` (`containsPath`: lexical + realpath); the auth policy already reserves the `?token=` allowance for the raw-file GET path. |
| MCP connector catalog, homelab/service monitoring, region connectors | Pure route/view additions behind the bearer. |
| Self-update (SPEC §19) | Standalone; the supervisor lock pattern (pidfile + stale-age + PID-recycling guard) in `src/app/lock.ts` is the template. |
| OS-keychain master-key backend | The `MasterKeyBackend` interface in `src/vault/masterKey.ts`; the file backend ships. |
| Embeddings provider (hybrid memory search) | The `EmbeddingProvider` interface in `src/memory/embedding.ts`; saves already schedule fire-and-forget embedding; search degrades to FTS-only today. |
| Voice transcription, inline channel buttons | Provider-level additions behind `ChannelProvider`. |

---

## 8. Testing strategy

`npm test` runs **1161 tests** (all passing; `node:test` via `tsx`; unit at concurrency 4, integration serialized at concurrency 1):

1. **Pure-function exhaustive tests** (co-located `*.test.ts`): the sanitizer (confusables,
   reserved-id forgeries), the trust classifier, frame/tag neutralization, the privilege
   gate (full verdict matrix), permission precedence (incl. the `strict +
   bypassPermissions` sandbox), the routing decision (operator-terminal, loop-breaker,
   hidden targets), the lane router (HU inflections), the cron engine (vixie dom/dow, DST
   skip/repeat), pane-state classification (scrollback-quoting traps), message splitting
   (byte-exact reassembly), FTS query sanitization, path-safety predicates.
2. **Module tests with in-memory SQLite + fakes**: every store (messages, memory, ledger
   incl. the uniqueness/continuity constraints, kanban dispatch-once and hook tolerance,
   ideas link/auto-archive/reconcile, autonomy hard-locks against hostile seeds and
   tampered rows, vault crypto/tamper/API discipline, task store), migration idempotency,
   the scheduler runner (claim-before-deliver, retry-alert idempotency under concurrent
   passes), the delivery service (no-message-loss ordering), the supervisor
   (single-in-flight serialization proven with a slow scripted write, fan-out, reauth
   escalate-once), the reconciler (stagger), the Telegram client against a scripted fake
   transport (offset-after-handoff, dedup, claim release on failed handoff, 409 backoff,
   429 retry_after, token redaction), auth/origin/router/static.
3. **Integration** (`test/integration/`): the tmux driver against a **real tmux** running a
   scripted bash REPL — session lifecycle, buffer-paste input, pane capture, pipe-pane
   streaming (skipped where tmux is absent); UI catalog parity (HU/EN key sets must match,
   so the "raw key" fallback is unreachable).
4. **Boot/smoke** (`test/smoke/boot.test.ts`): boots the **real application** (fake
   adapter) in a temp state dir and exercises the dashboard API over real HTTP — bearer
   enforcement, agent-token stamping, watch+type echo, kanban dispatch, the dream-file
   machinery.

**The two end-to-end gates (now automated, §23 — not manual checks).** The interactive
runtime is proven by two real smokes that run in `npm test`:

- **Real multiplexer smoke** (`test/integration/realMultiplexer.test.ts`): NOT a mock — it
  creates a **detached tmux session on a dedicated socket** running an interactive stand-in
  REPL (the same multiplexer + input + capture path a live Claude session uses) and proves
  the §3a contract: the session **persists independently of the supervisor** and is
  **attachable from a fresh adapter** on the same socket (a supervisor-restart simulation —
  and adoption does **not** duplicate the session); input delivered through the **real path**
  lands and runs; the live screen stream emits rendered snapshots; and **recovery never kills
  the server** — a peer session survives the first agent's respawn. Skips cleanly where tmux
  is absent; tears down only its own socket.
- **Headless-browser UI smoke** (`test/ui/dashboard.ui.test.ts`, Playwright/Chromium): a real
  headless Chromium loads the SPA, switches **theme** (arcane→daylight, live) and **language**
  (HU↔EN, re-render from the new catalog), opens the live agent view, **types** into the
  input box and asserts the POST to the input endpoint, and the (fake) runtime's echo renders
  back. Screenshots are saved under `artifacts/ui/`. Skips cleanly if Playwright's Chromium
  isn't installed.

**Manually verified only** (not automatable in CI by design): a live Claude Code session
end-to-end — the subscription OAuth login flow, the pane-state heuristics against the real
TUI (spinner glyphs, permission prompts, the `/login` screen) — and a real Telegram
round-trip with a live bot token. This end-to-end path was **verified live** on a real deploy
(2026-06-12), including **agents surviving a supervisor restart** on the dedicated tmux
socket; the multiplexer path that underlies it is now itself an **automated real smoke**
(above). Everything around these points is covered by the fakes and the two gates.

---

## 9. Release governance (interim, #72)

Writes to `main` go **exclusively through pull requests** — no agent (and, after the final
flip, no admin) direct-pushes to `main`:

- A dedicated **`citadel-release`** account opens the release PR. Its credential is a vault
  secret (`CITADEL_RELEASE_TOKEN`) wired through an **isolated git credential helper**
  (`~/.orchestrator/git-credential-citadel-release`), separate from the agents' own push
  identity.
- A delegated **`nexus-review`** account supplies the one **required approval**
  (self-approval disabled, so the opener cannot approve its own PR).
- **`citadel-release`** then merges (recorded as `merged_by=citadel-release`).

`main` is **branch-protected**: `enable_push=false`, `merge_whitelist=[citadel-release]`,
`required_approvals=1`. `apply_to_admins` is currently **`false`** (soft-interim: the human
admin can still direct-push for emergencies; the hard flip to `true` is a later coordinated
operator window). The gate was verified end-to-end: a pre-approval merge attempt returns
**405** ("does not have enough approvals"), a post-approval merge **200**.

Release effects depend on the change: a **doc-only** release needs no rebuild or restart; a
**code** change triggers pull → build → graceful supervisor restart after merge. Agents'
**feature-branch** pushes are unchanged (they push under the normal identity); only the
`main` merge is governed.
