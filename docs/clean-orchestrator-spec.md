# Clean Orchestrator — Functional Specification (concept-level, for the architect)

> **Purpose.** This is a clean-room, concept-level functional spec for a fresh, fully-owned
> multi-agent orchestration system in **TypeScript/Node**. It describes WHAT the system must do
> (behaviors, contracts, data concepts, invariants) — NOT how an existing system implemented it.
> A separate engineer ("the architect") designs the whole architecture, file layout and code from
> this spec. The result must be a clean, original codebase that works as reliably as a mature
> reference system, and is fit to **sell or open-source** (no third-party attribution required
> because it is original code; only your chosen libraries carry their own notices).
>
> **Clean-room note.** Treat this document as a behavioral requirements spec. Design your own
> architecture, module boundaries, names, schema and code. Do not assume any particular source
> structure. Where this spec says "MUST", it is a load-bearing contract (often security or
> data-integrity). Where it says "OPTIONAL", it can be omitted or deferred for a lean v1.
>
> **Goals:** (a) replace a personal multi-agent fleet on fully-owned code; (b) be a clean,
> general, sellable/OSS product. Optimize for **correct + fast-to-working**, not for raw perf
> (the system is I/O-bound: subprocess/IPC/disk/network).

---

## 0. The single most important architecture decision (read first)

A large fraction of a mature orchestrator's accidental complexity comes from TWO substrate
choices, not from the domain:

1. **Agents as interactive terminal (TUI) processes driven by sending keystrokes and screen-scraping** — this forces: pane-state parsing, "is it busy/ready" heuristics, modal-dismissal, send-keys chunking, idle-guards, and a family of "stuck" watchers/healers.
2. **Channel (chat) connectivity as a flaky third-party plugin sharing a single bot-token poll slot** — this forces: an entire watchdog/recovery layer, orphan-poller reaping, 409-conflict avoidance, a separate "backfill coordinator", and keystroke-driven plugin reconnection.

**A clean build SHOULD eliminate both substrates and keep only the concepts:**

- **Agent runtime = a first-class abstraction** (`AgentRuntime` interface) with operations like
  `start/stop/restart/send(prompt)/status/streamOutput`. Provide a **reference adapter** that runs
  each agent as a real **Claude Code instance** (this is the fastest path to a working,
  feature-equivalent system), but behind the interface so other runtimes/LLMs can be added later.
  Crucially: the IPC/transport choice is **constrained by billing, not just engineering taste** (see
  §5). For the subscription-billed reference adapter (Claude Code) the ONLY subscription-billed
  surface is the **interactive TUI**, so that adapter MUST drive a terminal session — a "proper
  API/IPC" (the Agent SDK / `query()`) is pay-as-you-go and is NOT an option for the default path.
  The proper-IPC ideal therefore applies ONLY to non-Claude / fully-owned runtimes that expose a
  subscription-free programmatic channel; for those, prefer real IPC over keystrokes. Whichever
  transport an adapter uses, **encapsulate ALL of it inside the adapter** so the rest of the system
  only sees `send()`/`status()`/`injectInput()`; the terminal-driving fragility is contained by the
  single-owner/single-serializer rule (§3), NOT by reaching for the SDK.
- **Channels = first-class long-poll/websocket clients you own** (a reconnecting `ChannelClient`
  per provider). This makes the entire watchdog/recovery/backfill layer **unnecessary** — a normal
  reconnecting client with offset persistence + dedup replaces it.

**Billing reality constrains the runtime (see §5 — verified June 2026):** the in-process Agent SDK
(`query()`) is pay-as-you-go API with no subscription path, and headless `claude -p` now draws from
a small capped metered credit — so the subscription-billed reference adapter drives an **interactive
Claude Code instance** (a TUI). Some terminal-driving is therefore unavoidable; its fragility is
contained by making the supervisor the single owner of output + single serializer of input (§3),
NOT by reaching for the SDK. Keep any SDK/headless adapter as an explicit, API-billed opt-in only.

Keep these timeless concepts regardless of substrate: durable message queue with no-message-loss +
dedup + offset persistence; busy/ready/forceSend delivery semantics; the trust model; per-agent
isolation. **Everything in §"Self-healing" is mostly substrate-specific and should shrink to near
nothing in a clean runtime.**

This decision is what makes the clean system both **simpler** and **faster to get working**.

---

## 1. System overview

A single-operator (initially) system that runs a **roster of AI agents** coordinated by one
**hub/orchestrator agent**. The operator chats with the hub over a messaging channel; the hub
**delegates** work to specialist agents; agents collaborate via an inter-agent message queue; a
**web dashboard** gives full visibility/control. The system has long-term **memory**, a **kanban**
board, an **idea box**, **scheduled tasks** + a nightly **learning loop**, a per-agent **skill**
system, optional **media generation**, and a **security/permissions + governance** model.

Process model: **exactly one supervising process** owns the scheduler, reconcilers, watchers and
the bot connections (enforced by a port/pidfile singleton lock). Two instances must never run
(they would fight over channels and deliver to wrong agents).

---

## 2. Cross-cutting design decisions (architect's starting constraints)

- **Language/stack:** TypeScript/Node (ESM). Embedded SQLite for state (WAL mode). A plain HTTP
  server + a small SPA for the dashboard (one language, backend+frontend). No heavy framework
  required; choose pragmatically.
- **Agent-runtime abstraction** (see §0): reference = Claude Code; pluggable.
- **LLM/model layer is model-agnostic** (see §5): subscription-OAuth-first; pluggable backends via
  an Anthropic-compatible base-URL seam (local models, alternate providers) WITHOUT hardcoding a
  vendor. NEVER require an `ANTHROPIC_API_KEY` for the default path.
- **Channel providers are pluggable** behind a `ChannelProvider` interface (reference: one chat
  provider; design for ≥2).
- **Locale/branding are configuration**, not code: roster names, accent colors, timezone, install
  paths, ports — all config-driven; do NOT hardcode a roster. **Language is a first-class, two-locale
  concern, NOT 'English-default' (see §7a):** code is English; operator-facing prose + UI are
  localized; ship **both Hungarian and English** complete and first-class; the operator-facing
  default is **Hungarian, switchable at runtime**; the install-wide default locale is **chosen at
  install**. The dashboard ships an original default **theme** + a persisted runtime theme switcher
  and a persisted runtime **language switcher** (see §17).
- **Core vs optional:** build the CORE (§§3–17 minus the explicitly-optional). Treat media gen,
  homelab/service monitoring, region-specific connectors, specific scheduled-task content, and the
  substrate recovery layer as **optional modules**.
- **Everything is concept-level here.** You own schema design, module layout, and naming.

---

## 3. Agent runtime & lifecycle

**Purpose:** bring agents to life, keep them at their desired run-state, address them reliably.

Requirements:
- An **`AgentRuntime` abstraction**: `start(agent)`, `stop`, `restart(opts: {fresh?})`, `status() ->
  {running, since, liveModel?, contextSize?, needsReauth?}`, `deliver(prompt)`, and an output/state
  stream. The reference adapter runs a Claude Code session per agent; alternative adapters
  (SDK/managed-process/container) must be possible without touching callers.
- **Per-agent isolation (MUST):** each agent has its own working directory / config root so its
  conversation/session/transcript/memory/tools/permissions never collide with another agent's. The
  hub/main agent is a first-class peer but structurally distinct (its own session; addressed
  specially) — every agent-targeting operation MUST branch for it rather than assume a uniform
  per-agent dir.
- **Desired-run-state (MUST):** persist the set of agents the operator wants running (intent),
  separate from actual runtime reality. A reconciler brings reality toward intent (start the
  missing, leave the intentionally-stopped down). On a mass outage (e.g. host/supervisor restart),
  the reconciler restarts them, **staggered** to avoid thundering-herd races.
- **Restart policy:** support `--continue`-style session resume (resume prior conversation) AND a
  `fresh` mode (drop accumulated context to keep the agent lean). Scheduled auto-restart to trim
  context is OPTIONAL; if present: **idle-guard** (never restart mid-turn) and **seed
  last-restart=now on first sight** so a past-due slot doesn't fire spuriously at boot.
- **Reauth:** detect when an agent's auth has expired (the process may be alive but non-functional)
  and **escalate to the operator** — there is no silent auto-heal for an expired login. Sub-agents
  MAY attempt a scripted re-login autonomously; the hub MUST NOT auto-inject re-login into its
  always-on conversation (escalate-only).
- **Delivery semantics (MUST, runtime-agnostic):** the system needs a notion of agent
  **busy vs ready**, must not deliver into a busy agent (queue/retry instead), and needs a
  **forceSend** escape hatch for must-run deliveries during long-busy periods. (In the reference
  Claude-Code adapter these map to session readiness; in a managed-process adapter they map to
  the process's own queue. Keep the semantics; hide the mechanism.)
- **Live observe + direct human input (MUST, runtime-agnostic):** every `AgentRuntime` MUST expose
  (a) a **live output stream** — a read-only, structured projection of the agent's activity
  (streaming text, tool calls + results, and a busy/ready/blocked/needs-input state) suitable for
  fan-out to many subscribers, and (b) an **`injectInput(msg, {source, force?})`** operation — the
  ONE path by which anything reaches the agent's input. `source` distinguishes `machine` (scheduler/
  router/watcher/healer) from `operator` (a human typing live).
- **Single owner / single serializer (MUST):** the supervisor is the **sole owner** of each agent's
  output stream (it multicasts; subscribers cannot affect the agent) and the **sole serializer** of
  its input. ALL producers — scheduler, message-router, watchers, and the operator — go through
  `injectInput` into one ordered per-agent queue; **no component ever drives an agent's input
  directly**. This makes machine delivery and direct human typing safe by construction: they are
  ordered, never interleaved (no shared-stdin race), and both obey the busy/ready + `forceSend`
  semantics above. Operator injections MUST be written to the conversation ledger as a distinct,
  attributed entry (e.g. `operator injected: …`) so direct typing is auditable, not an invisible
  side-channel.
- **Terminal attach (OPTIONAL, never the control plane):** an adapter MAY also offer a literal
  terminal attach (e.g. a native interactive session) for operators who want the raw terminal feel,
  but it MUST be **read-mostly / out-of-band** — the canonical view is the live output stream and the
  canonical input path is `injectInput`. Attach-write bypasses the serializer and is an expert
  escape hatch only, never a path the system itself uses.

OPTIONAL / substrate-specific (only if you reuse the CLI-in-terminal substrate): modal dismissal
after spawn, keystroke chunking, pane double-sampling for readiness, single-quoting model strings,
encoded-projects-dir probing before resume. These are unavoidable for the subscription-billed Claude
Code reference adapter (which MUST drive a TUI — see §5), so contain them inside that adapter behind
the single-serializer rule. Only a non-Claude / fully-owned runtime that exposes a subscription-free
programmatic channel can talk via real API and skip all of these — prefer real IPC THERE, never as a
substitute for the subscription-billed interactive path.

### 3a. Interactive terminal-multiplexer reference adapter (MUST for the subscription path)

Since the subscription-billed runtime is an interactive Claude Code TUI (§5), the reference adapter
drives it inside a **terminal multiplexer**. The following behaviors are what make it ACTUALLY work
— for this adapter they are MUST, not optional. (A naive build that only unit-tests the adapter
against a fake driver will pass while the real substrate is broken — see §23.)

- **Session ownership & persistence (MUST):** each agent runs as a long-lived **interactive REPL in
  its own detached multiplexer session owned by the multiplexer SERVER — never as a child process of
  the supervisor.** So a supervisor restart/crash never kills agents, and the operator can ATTACH to
  the session to watch live and (out-of-band) type. Sessions have deterministic names addressed by
  **EXACT name match** (a substring/prefix match hits the wrong agent).
- **Launch rules (MUST):** start the agent INTERACTIVE only — never a headless one-shot (it exits
  after one turn, leaving nowhere to inject the next prompt). Put the subscription auth token into
  the multiplexer SERVER-global environment BEFORE the first session is created; actively UNSET any
  inherited channel/bot tokens and `ANTHROPIC_API_KEY` from the agent's environment; single-quote
  the model id; OMIT session-resume when creating a brand-new agent (resume only an agent that has
  prior state); use prompt-bypass only in a permissive profile and never as root.
- **Readiness classifier (MUST):** model agent state as a small discrete set — **idle / busy /
  typing / error / unknown** — derived ONLY from the LIVE input+footer region of the pane, never
  from scrollback (a busy/error phrase quoted in history is the classic "permanently stuck" bug).
  Treat "busy" as **turn-scoped via a runtime counter**, not by matching spinner words alone (a
  spinner verb is "busy" only when paired with an active-turn signal on the same line). Confirm
  "idle" with a short **double-sample** (~250 ms apart) so a momentary blank isn't read as ready.
- **Input delivery (MUST):** deliver prompt text as **literal chunks kept under the terminal's
  bracketed-paste threshold** (nudge a chunk boundary so a chunk never begins with a character the
  TUI treats as a flag, e.g. a leading dash), then send a **SEPARATE submit keystroke** — never rely
  on a trailing newline in the text. Before delivering, **dismiss any modal** (survey / resume /
  trust prompt) and clear a stale framing preamble; after sending, do a **bounded retry** scoped to
  the live input box if the text didn't land. All of this sits behind the single-serializer (§3) so
  machine and operator input never interleave.
- **Recovery = respawn-in-place (MUST):** if an agent session is wedged or vanished, **recreate /
  replace just that agent's process or session — NEVER kill the multiplexer server or restart the
  supervising service** (that drops the operator's attach and every other agent on the shared
  multiplexer). Apply a **post-respawn / startup grace window** so multiple recovery paths don't
  stack restarts on the same agent.

---

## 4. Roster, agent config & bootstrap

- **Agent config (data concept):** per agent — displayName, model, securityProfile, accent color,
  authMode (shared-subscription | own-credentials | api-key), channel binding (provider or none),
  optional alternate config root, strict-tools flag, hidden/internal flag, **team graph**
  (role, reportsTo, delegatesTo, trustFrom), and optional lifecycle (ephemeral, doneWhen, deadline,
  closed). All reads tolerant of missing/malformed config (safe defaults).
- **Persona model (MUST keep the concept):** each agent has an **operating doc** (instructions,
  carrying the shared "Operating Contract" — see §15) and a **personality doc**. These are
  per-agent files. The specific roster/personas are CONFIG, not architecture.
- **Seed roster + scaffolding (MUST):** a committed seed defines the default roster; on boot the
  system scaffolds any missing agent. **Scaffolding/seeding is idempotent and MUST NEVER overwrite
  an existing agent's files** (operator edits/deletions are respected; only fill what's absent).
  Note: a `CREATE TABLE IF NOT EXISTS`-style "create only if absent" does NOT add new columns to an
  existing store — schema additions need explicit additive migrations.
- **Roster cap + reserved names:** base-roster agents are never auto-reaped/deleted and their names
  are reserved. New agents are created via the dashboard or (gated) programmatic spawn (§15).
- **Hidden/internal agents:** a flag/sentinel marks technical workers excluded from the roster
  view, scheduler and inter-agent routing, but still real (so a reaper can find them).

---

## 5. LLM / model layer (model-agnostic)

- **Default auth is the host's subscription OAuth login** (no API key injected). **The default
  path MUST NEVER require or set an `ANTHROPIC_API_KEY`.**
- **Subscription-billing constraint (MUST — load-bearing for cost; verified June 2026):** the system
  MUST run on the interactive subscription, NEVER pay-as-you-go API. The verified Anthropic billing
  reality dictates the runtime choice:
  - **Interactive Claude Code (TUI)** draws from the subscription's shared usage pool and is the only
    effectively-unlimited subscription-billed surface → the default reference adapter.
  - **In-process Agent SDK (`query()`)** requires an API key and bills pay-as-you-go; there is NO
    supported subscription-auth path → do NOT use it for any subscription-billed agent.
  - **Headless `claude -p`** is subscription-authenticated, but since 2026-06-15 its usage no longer
    counts against the chat pool — it draws from a separate **capped, non-rolling monthly "Agent SDK
    credit"** metered at API rates that then STOPS (or spills to API rates only if "usage credits"
    are explicitly enabled). Treat it as a budgeted, finite one-shot path: keep "usage credits"
    DISABLED if the goal is to never incur an API charge, and prefer interactive agents for ongoing
    work.
  - **`ANTHROPIC_API_KEY` MUST NEVER be present** in ANY process env (agent, scheduler, cron, hook,
    one-shot). A stray key silently flips even the interactive TUI to metered API billing (a
    documented cause of large surprise bills). Assert subscription auth at startup; refuse to launch
    if an API key is detected in the target environment.
- **Backend routing by model id (data concept):** a model string both names the model and selects a
  backend. Provide a clean **adapter seam**: default vendor (subscription OAuth); alternate
  providers and **local models** via an Anthropic-compatible base-URL + auth-token override; an
  explicit per-agent **api-key opt-in** (key resolved from the Vault, never from argv/git). Short
  model aliases resolve from a **config map** (don't hardcode a model lineup).
- **One-shot text generation** (for generating persona docs / skill docs) MUST use a separate
  non-interactive code path — never the live interactive agent path. That path MUST itself be
  subscription-authenticated (`claude -p` via the subscription login, NOT the API-billed SDK), and
  it consumes the capped Agent SDK credit (above) post-2026-06-15 — so keep one-shots small and few.

OPTIONAL: specific local-model/alternate-provider integrations; the "1M-context" style suffixes.

---

## 6. Inter-agent messaging & trust model  ⚠️ security-critical

**Purpose:** durable, lossless message passing between agents, the operator, and inbound channel
users — with a trust model that cannot be forged.

Data concept — **message queue:** directed messages {from, to, content, status
(pending→delivered→done|failed), optional result/error, timestamps}. Indexed for the pending scan.
Read models on top: per-peer thread list, per-agent paginated conversation (cursor by id so
rarely-active threads aren't starved), recent list.

**Invariants (MUST):**
- **`from` is UNTRUSTED.** Trust tier is NEVER derived from the self-asserted sender. Privileged
  tiers (operator, channel-inbound, hub) match **only against code constants**; the trusted-peer
  tier matches a **known-agent graph**. A forged `from` must not reach a privileged tier.
- **One sanitizer, used identically** at the public write endpoint (to REJECT reserved ids) and in
  the router (to MATCH them). Any divergence (e.g. `trim()` vs strip-non-alnum) is a forgery bypass.
  The public write endpoint MUST reject (403) any `from` that sanitizes to a reserved id (operator,
  channel-coordinator). Operator messages go through a **separate** endpoint that stamps
  `from=operator` server-side.
- **Trust-tier framing on every delivery:** wrap the body in a typed security frame
  (`<untrusted>` / `<trusted-peer>` / `<operator>` / preserved `<channel>` envelope) with an inline
  preamble explaining the trust semantics — injected on EVERY delivery (a freshly-restarted agent
  has no memory of prior framing). **Every wrapper MUST strip ALL recognized security-tag names from
  the body** (not just its own), replacing with an **unpredictable per-process sentinel**, to defeat
  nested/forged tags. The `<channel>` delivery envelope is deliberately preserved (it carries safe
  routing attributes); its body is untrusted. Run the known-agent check BEFORE any hub
  implicit-peer shortcut.
- **No message loss:** a message to a target that EXISTS (even busy) is never abandoned — only a
  target absent for the whole retry window fails. Messages to the operator are terminal/delivered
  immediately. Order matters: check target existence BEFORE age.

The trust relationships (reportsTo/delegatesTo/trustFrom; hub as implicit peer of all) are core.

---

## 7. Channels (operator + external chat)  — mostly OPTIONAL recovery layer

- **Provider abstraction:** `ChannelProvider` = `send(chatId, text)`, `sendMedia`,
  `validateToken`, `formatMessage`, `splitMessage`, plus identity (provider id, chatId format).
  Tokens resolved from the Vault / 0600 env, **never logged**.
- **Inbound (MUST, as concepts):** a reconnecting client per provider with **offset persistence**
  (persist only after a batch is durably handed off → at-least-once), **dedup** by provider update
  id (a unique key), and **no message loss** (a down hub may delay but must never lose an inbound
  message — re-queue idempotently). Inbound user messages are relayed to the hub as a `<channel>`-
  framed queue message carrying safe routing attributes (source, chatId, message id, user, ts) and
  the untrusted user text as body.
- **Operator chat:** the operator is a reserved identity; their messages stamp `from=operator`
  server-side and get the operator trust frame.
- **Per-channel access control (OPTIONAL):** pairing codes / allowlists / invites for who may DM an
  agent; default-deny on unknown senders.

**OPTIONAL / drop in a clean build:** the entire flaky-plugin recovery layer (liveness probing,
multi-stage down-cascade, keepalive staleness, inbound-deafness probing, orphan-poller reaping,
plugin reconnect keystroke driving, the separate backfill coordinator). A first-class owned
reconnecting client replaces ALL of it. Voice-note transcription, inline-button relay = optional.

---

### 7a. Localization & language policy (MUST)

- **Code is English, prose/UI is localized.** ALL source — identifiers, types, function/variable
  names, log keys, DB column names, config keys, code comments, commit messages — MUST be **English**.
  Only **operator-facing prose** (UI strings, channel/operator messages, generated reports,
  persona/doc prose) is localized. No localized identifiers, no mixed-language code.
- **Ship BOTH Hungarian and English as first-class locales.** The system MUST ship **complete,
  parity** HU and EN message catalogs for every operator-facing surface (dashboard UI,
  channel/operator messages, brief/digest templates) at v1 — neither is a stub or a reference-only
  artifact. Adding a third locale MUST be a drop-in catalog, no code change.
- **Operator-facing default is Hungarian, but switchable.** The shipped operator-facing default
  locale is **Hungarian**; the operator can switch to English (or any shipped locale) at runtime via
  the GUI switcher (§17) and via config. The UI language and the agents' prose-generation language
  are **independent, separately switchable** axes.
- **Default locale is chosen AT INSTALL.** The installer / first-run setup (§23) MUST **prompt for
  (or accept a flag/config value for) the default locale**, seeding it as the install-wide default
  for both UI and generated prose. Absent any choice, fall back to Hungarian. The runtime switcher
  can override the per-operator/per-session locale at any time without reinstall.
- **No hardcoded locale.** Locale, timezone, and the prose language an agent writes in are
  config-driven (resolved at runtime, changeable without rebuild). Nothing in code may assume a
  single language.

---

## 8. Memory system

**Purpose:** durable long-term memory with per-agent isolation + a shared overlay, hybrid search,
and graceful degradation.

- **Tiers (data concept):** every memory has a category in a closed set — **hot** (active), **warm**
  (stable prefs/config), **cold** (archival lessons), **shared** (fleet-visible). Enforce via a
  store-level constraint. **`shared` is the ONLY cross-agent visibility**; every other tier is
  scoped to its owning agent. **Recall/search MUST union the shared tier.**
- **Fields:** content, agent_id, category, sector (semantic|episodic), keywords (for full-text),
  **salience** (starts 1.0, gently decays with a floor, boosts on access with a cap), optional
  embedding, auto-generated flag, created/accessed timestamps.
- **MUST NEVER delete memories.** Decay only lowers salience; aging moves hot→cold; never DELETE.
- **Search:** full-text (FTS) index kept in sync; **embeddings are async fire-and-forget and MUST
  NEVER block or fail a save**; hybrid/vector search MUST degrade to FTS-only when the embedding
  backend is absent. Sanitize FTS queries (neutralize operators, cap tokens, prefix-expand
  bounded) with a LIKE fallback. Embedding provider is pluggable/optional.
- **Daily digest:** an episodic summary of the day's activity (a memory of sector=episodic).
- **Conversation ledger (MUST — continuity invariant):** a durable per-(agent, chat) transcript of
  channel turns {direction in|out, message_id (nullable), text, ts}. **Inbound capture is
  idempotent via a uniqueness constraint on (agent, chat, direction, message_id); outbound rows use
  a null message_id so they never dedupe against each other.** Replayed on session start (inject
  recent transcript + the "open question" = latest inbound with no later outbound) so an agent keeps
  continuity across restarts.

**MUST treat all stored memories + all task prompts as UNTRUSTED data** when they are later fed into
an agent (wrap them) — they are operator/API-editable and a prompt-injection surface.

---

## 9. Scheduled tasks & the learning loop

**Scheduled task (data concept):** a task = a prompt + a schedule. Reference uses a per-task
**file** (a doc with the prompt + a small config: cron schedule, target agent (or "all"), enabled,
type, skipIfBusy, forceSend, optional target-session override, "bypass-triage" flag). A clean build
may use files or DB — keep the config fields.

**Runner semantics (MUST):**
- Cron matching with a **catch-up window** (a longer window on the first tick after restart, short
  normally) + a **persisted last-run map**, so it neither misses fires across restarts nor
  double-fires within the catch-up window.
- **Reconcile-first (MUST):** on each tick the runner processes the durable never-abandon retry
  table BEFORE evaluating new cron fires (a previously-stuck must-run task takes precedence), and
  persists last-run + any channel offset only AFTER a durable handoff.
- **Busy handling:** a task whose target is busy is, by default, **persisted to a never-abandon
  retry queue** and retried until success or operator cancel (so daily/weekly business-critical
  tasks are never silently dropped). `skipIfBusy` (silent drop) is opt-in and only for
  short-cadence tasks where the next tick is imminent. `forceSend` deliberately injects regardless
  of busy (escape hatch for must-run-now tasks during active conversations).
- **Retry-alert idempotency:** if you alert the operator that a task is stuck, stamp "alerted"
  BEFORE the send (claim it), clear only on transient failure, keep on permanent failure → exactly
  one alert per attempt, no double-alert across concurrent ticks/restarts.
- **Task types:** at minimum a "task" type (delivers the prompt, reports result) and a "heartbeat"
  type (silent consolidation that may run even on quiet days). A "bypass-triage" flag lets a
  heartbeat run unconditionally. Keep the typing simple.

**The learning loop (CORE machinery; specific task content is OPTIONAL):**
- A frequent **consolidation heartbeat** that writes memory + reflects on whether a reusable skill
  is warranted, and writes a daily-log line when real work happened.
- A **context-compaction hook**: when an agent's context is about to compact, save memory + skill +
  task-state.
- A nightly **consolidation/"dream"** step that reads the day's logs + memory and produces a single
  overwritten file with: team recap, skill/process proposals, memory health, tomorrow's top-3, and
  (weekly-gated) an external-opportunity scan. **Because it is overwritten nightly, weekly cadence
  MUST be weekday-gated, not file-history-gated.**
- A **consumer** step that turns proposals into action (create skills within governance limits;
  push operator-facing items to the idea box).
- A **cross-agent sync** that writes shared-tier observations (who did what / who's good at what).
- A **morning brief** delivered to the operator's channel.
- **Task-state save/replay (MUST keep concept):** on compaction save {summary, doneSteps,
  alreadyDelegated, nextAction, pendingDecision}; replay on session start so an agent resumes its
  in-flight work after a restart.

**Background/consolidation tasks running while the operator sleeps MUST NOT message a live channel**
— their output is files/DB/idea-box only.

OPTIONAL: the specific tasks (grant-watcher, supply-chain scan, vault-curation, etc.) are content,
not core. Any sub-agent spawned for a background job MUST run isolated (own cwd + own config root,
channels disabled) so it never steals the live channel connection.

---

## 10. Skills system (two-tier)

- **Two scopes (data concept; filesystem, NOT the DB):** **global/fleet skills** (visible to all
  agents) and **agent-local skills** (visible only to that agent, loaded from its own dir). A local
  skill of the same name **shadows** the global one.
- **A skill = a directory** with a doc (frontmatter name+description + body) + optional helper
  scripts/references. **3-level progressive loading:** an index lists name+description (Level 0); the
  full doc loads on demand (Level 1); helpers on deeper demand (Level 2).
- **Per-scope index (MUST):** generate a Level-0 index for the global scope AND a per-agent index =
  global + that agent's own local skills. **An agent's index MUST NEVER expose another agent's local
  skills.** The hub's skill root IS the global root (special-case it).
- **Governance (MUST):** creating/patching a **global** skill requires hub/orchestrator approval;
  **agent-local** skills are free (affect only that agent). Dedup before creating. Never modify or
  propose deleting **pinned**/factory/plugin skills. Skill import MUST reject path-traversal +
  symlinks and refuse to overwrite an existing name.
- Skill generation (writing a new skill doc via a one-shot LLM call) is a convenience; the core is
  the two-tier storage + indexing + governance.

---

## 11. Kanban / task board

- **Card (data concept):** id, title, optional description, **status ∈ {planned, in_progress,
  waiting, done}** (planned is the entry column — there is no separate "todo"/"backlog"), assignee
  (free-text: an agent id, the hub, the human owner, or empty), **priority ∈ {low, normal, high,
  urgent}**, optional project (grouping), optional parent_id (1-level epic→subtask), sort_order,
  timestamps, archived_at (soft-archive), dispatched_at (once-only wake guard), requires_approval
  flag. Enforce the enums via store-level checks.
- **Dispatch-on-in_progress (MUST):** when a card moves to `in_progress`, **wake the assigned agent
  exactly once** (guarded by dispatched_at — re-entering in_progress must not re-dispatch). Dispatch
  fires from the **move** operation keyed on destination status, never on a generic update. It MUST
  be a no-op (no message, no error) for a human owner, empty/unknown assignee, or a non-running
  agent (the card just stays in in_progress; the operator/hub must start the agent).
- **Side-effect hooks on move MUST be error-tolerant** — a hook failure (dispatch, idea-archive)
  can never fail or roll back the card move itself.
- **Soft archive (MUST):** archiving sets a flag/timestamp, never deletes (history preserved). A
  hard delete exists only as an explicit operator action (cascades comments).
- Comments (append-only, human + system). Breakdown/promote: split a card/idea into a parent +
  child cards atomically. A small, **pure, unit-tested** "guess the assignee/lane" router maps a
  free-text subtask to a specialty lane (configurable lanes; first-match; leading-word-boundary so
  inflected words still match) — the lanes/roster are CONFIG.

---

## 12. Idea box & proactivity

- **Idea (data concept):** id, title, description, category, **status ∈ {new, reviewed, kanban,
  rejected, archived}**, source, optional **kanban_id** (link to the promoted card), archived_at,
  timestamps.
- **Promote** an idea → creates a linked card and sets status=kanban (the idea↔card link is
  **bidirectional and load-bearing**).
- **Auto-archive on done (MUST keep concept):** when a promoted idea's linked card reaches `done`,
  the idea auto-archives (via the error-tolerant move hook). Provide a manual archive (for ideas
  resolved without a card) and a reconcile/sweep that archives all done-linked ideas. **Archive is
  always soft (never delete).** Note: adding a new status value to a checked enum requires a
  table-rebuild migration, not a simple alter — design the status set up front if you can.
- **Autonomy ladder (data concept):** per-category trust level 1/2/3 (current setting + hard
  maxLevel + locked flag). **Hard-locked, code-enforced categories** (publish, payment, data-delete,
  permission-change, external-message) can NEVER exceed level 1 (server-side, not just UI). On
  config upgrade, only newly-introduced categories are added; existing operator-set levels are never
  reset. **MUST ship the seed config** (a missing config must not default to fully-autonomous).
  Operator escalation is gated on these levels.

---

## 13. Studio / media generation  — OPTIONAL module

If included: an **async job** API (POST returns a jobId immediately; poll for status/result —
because generation is long). **Exactly one GPU/generation job at a time** — take the lock
**synchronously at entry before any await** (so two callers can't both pass preflight), reject a
second request (409), and release the lock only when the job's own promise settles (never at a
watchdog timeout). Clamp all generation parameters to safe ranges (drop out-of-range values).
Generation deliberately uses a local/media model, not the chat LLM. Studio job records may be
in-memory (rendered files persist on disk). If a media-generating agent identity exists, the message
router needs a 3-way (pass/dispatch/consume) rule so a generator→generator message is **consumed**
(never re-triggers a render) — a loop-breaker. Pluggable behind one async-job interface, or omit.

---

## 14. Background tasks  — OPTIONAL

Detached one-shot agent runs: {id, agent, prompt, status (running/done/failed/timeout), session,
times, captured output}. **Per-agent concurrency cap enforced atomically** (count+insert in one
transaction). Orphaned "running" rows reconciled to failed on restart. Distinguish clean
completion from external-kill/timeout via an explicit exit-code marker (a missing/non-zero code is
NOT success). Substrate detail (how the detached run is hosted) is the adapter's concern.

---

## 15. Security, permissions & governance  ⚠️ core

- **Security profile (data concept):** a named capability bundle = id, label, a **mode**
  (strict | permissive), an optional **defaultMode**, and allow/deny rule lists (filesystem/tool
  rules with placeholders resolved per agent). Each profile maps to an integer **privilege level**:
  0 sandbox, 1 draft/read-only, 2 trusted-build (the spawn ceiling), 3 full-host (pre-seeded roster
  only, never spawnable).
- **Enforcement coupling (MUST):** in the reference (Claude-Code) runtime, "strict" launches the
  agent so the runtime enforces the allow/deny list, while "permissive" launches with prompts
  bypassed (the list becomes advisory). **`strict` + `defaultMode=bypassPermissions` = a real
  sandbox: no prompts, but deny rules still enforced** (precedence **deny > ask > allow >
  defaultMode**). Whatever runtime you use, preserve this: a profile's restriction must be actually
  enforced, not merely declared. (Caution: a blanket `allow-everything` rule silently defeats the
  point of scoped profiles.)
- **Privilege gate (MUST — pure, exhaustively unit-tested):**
  - No agent can ever escalate its own privilege. A spawned child may never exceed the requester's
    privilege; the gate runs AFTER trust classification so `from` cannot be forged into the hub.
  - Only the hub may initiate a programmatic spawn; any other programmatic requester is denied.
  - Nothing above the hard ceiling (level 2) can EVER be spawned — not even by the operator via the
    dashboard. The full-host profile + the hub exist only as pre-seeded roster.
  - Above the sandbox cap but ≤ ceiling, a programmatic request is **parked as a pending request
    requiring human approval**; the dashboard/operator path counts as the approval (can create up
    to the ceiling). Provenance: absence of a requester id ⇒ operator/dashboard.
- **Operating Contract (governance, MUST keep as a concept):** a shared block in every non-hub
  agent's operating doc encoding: **delegation = hub privilege** (a non-hub agent does NOT hand work
  to a peer; it returns it to the hub, who delegates via a kanban card; peer messaging is for
  questions/coordination/status, not work hand-off); a **scope-gate** (default-deny work outside the
  agent's own lane → return to hub); a **two-tier dialogue rule** (reversible cross-lane work: do it
  but make it visible on the board; irreversible/external + cross-lane: get a second opinion first);
  **escalation default-deny toward the operator** (only genuine human-decision categories); and the
  two-tier skill rule. The block is parameterized per agent (own scope / peer scopes /
  irreversibility examples) but structurally identical, generated from one template so a fix updates
  all docs.
- **Multi-agent collaboration pattern (keep):** the hub decomposes a job needing a specialist's
  separately-deliverable piece into a card for the specialist + a dependent card for the
  implementer; small in-line advice is a peer consultation (allowed), not a work hand-off.

---

## 16. Vault / secrets  ⚠️ core

- **Secrets never live in plaintext in committed/on-disk config.** Config holds only a
  `vault:<id>` indirection; the real value is resolved into process env at launch and never
  persisted. Tokens come from the Vault, **never from argv or git**.
- **Encryption:** authenticated AES-256-GCM, fresh random salt+IV per secret, a per-secret key
  derived (scrypt) from a master key. The master key lives outside the encrypted store (OS keychain
  where available, else a 0600 file) — pluggable backend. Tampered ciphertext fails (auth tag).
- **API discipline (MUST):** list returns metadata only (id/label/timestamps), NEVER values; only
  an explicit single-id get returns plaintext (behind the dashboard token). Never log the master
  key or any value. **Bindings** map a secret id → an env var across target config files and keep
  them synced. A launch-time wrapper resolves `vault:` env values to plaintext just-in-time, then
  execs the real command.

---

## 17. Web dashboard & API  ⚠️ core

- **Auth (MUST):** a single opaque bearer token (root-equivalent; generated 32 random bytes on
  first run; stored 0600; **never logged** — print the bootstrap URL to stderr only). **Every
  `/api/*` route requires the bearer**, with exactly these exceptions: a public auth-status probe;
  public avatar images (header-less `<img>`); and a **`?token=` query accepted ONLY for the two GET
  paths that can't set headers** (the live agent-output SSE stream + raw file serving). No other
  path may accept `?token=`. Compare tokens **constant-time**.
- **Binding + CSRF (MUST):** bind to loopback by default; non-loopback is a deliberate config choice
  that becomes an allowed origin. **Reject (403) state-changing requests carrying a foreign Origin;
  ALLOW requests with no Origin** (some browsers omit it same-origin).
- **API surface (contract-level; design your own routes):** fleet overview; agent CRUD + lifecycle
  (start/stop/restart) + status + security/team/auto-restart config + spawn-approval queue + avatar;
  a live agent-output stream (SSE; ?token= ok) + an input/keys endpoint; channels config (bind,
  test, access/pairing); the hub agent (read-only identity + restart); messages (list/threads/post +
  the separate operator-post + status update); memories (save/list/search/stats/update/delete +
  daily-log + recall); schedules (CRUD/toggle + pending-retry list/cancel); kanban (board/cards/move/
  comments/approve/archive/breakdown/children + projects/assignees/approvals badge); ideas (CRUD/
  promote/archive/reconcile/breakdown); autonomy (get/set with lock+maxLevel enforcement);
  agent-task-state save; skills (global + per-agent list/create/assign/import/delete); vault
  (list-metadata/get-one/set/delete + bindings/sync/scan/import); connectors/MCP catalog; status;
  updates. **All behind the bearer.**
- **SSE (MUST):** streaming an agent's live output MUST be **async/non-blocking** — never a
  synchronous capture on an interval (it would freeze the single-threaded event loop for all
  clients); skip overlapping ticks. Prefer pushing a **full current-state snapshot per repaint
  tick** (async) over incremental diffs that can desync a reconnecting client.
- **Watch + type is a first-class dashboard requirement (MUST):** the live agent-output stream is
  the **primary human view** of any running agent — the operator MUST be able to watch ANY running
  agent live regardless of which runtime adapter backs it or who/what is currently driving it. An
  **input endpoint** MUST let the operator type directly to a running agent; the dashboard is one
  `streamOutput` subscriber and one `injectInput` producer — it is NEVER wired to an agent directly.
  Operator input submitted here goes through the supervisor's single serializer (§3) and is logged
  to the conversation ledger as an attributed `operator`-source entry. The operator MUST always be
  able to **interrupt** a busy/stuck agent via this path (the `force` injection). A reconnecting
  client for the output SSE is RECOMMENDED (a dropped stream must not require tearing down the view).
- **File browser (MUST if included):** expose only allow-listed roots; **NEVER expose the
  secret/state dir**. Containment-check every (root, path) **both lexically (reject `..`) and via
  realpath (reject symlink escape)**. Uploads: stream (never fully buffer), `O_EXCL|O_NOFOLLOW` (no
  clobber, no symlink follow), size/concurrency/free-space caps, and **drain the body on early
  reject** (or the keep-alive socket wedges).
- **Routing order matters:** specific routes before catch-all `:param` routes; static handler last.
- **SPA + PWA:** a small single-page app; an installable PWA (manifest + service worker). **The
  service worker MUST be network-only for `/api/*`** (never cache API responses / intercept auth).
  The bearer is stored client-side (localStorage) after a one-time `?token=` bootstrap that the SPA
  reads then strips from the URL. (Serving over HTTPS — e.g. a private mesh VPN or a reverse proxy —
  is required for the PWA service worker; the token is root-equivalent, so do not expose it on the
  public internet without a second factor.)
- **Theming subsystem (MUST):** the dashboard MUST ship an **original, owned default theme** (a
  distinct dark, techno/arcane CITADEL-style visual identity — its own color tokens, typography
  scale, spacing, surface/elevation treatment), authored **clean-room from scratch** (MUST NOT copy
  or adapt any existing stylesheet), implemented as **CSS custom properties / design tokens** so the
  whole UI re-themes from one token set. A **theme switcher** in the UI MUST let the operator change
  theme at **runtime with no reload** (swap the token set live). Ship **≥2 themes** (the original
  default + at least one alternate). The selected theme MUST be **persisted per user** (client-side,
  e.g. localStorage, applied before first paint to avoid a flash-of-unstyled; the supervisor MAY also
  persist it as an operator setting so it follows the operator across devices). Per-agent **accent
  colors** (§4) compose with the active theme as an independent axis (accents are agent identity;
  theme is the surrounding chrome). The default theme is the product's face: it MUST look finished
  out of the box, not a framework default.
- **GUI language switch / runtime i18n (MUST):** ALL operator-facing UI strings MUST go through an
  **i18n layer** (keyed message catalogs — NEVER hardcoded literals in components) so the dashboard
  can render in any shipped locale. A **language switcher** in the UI MUST let the operator change
  the UI language **at runtime with no app/server restart and no page reload** (re-render from the
  newly-active catalog). The selected language MUST be **persisted per user** (client-side, applied
  before first paint; the supervisor MAY persist it as an operator setting so it follows the
  operator). At minimum the system MUST ship **complete, first-class Hungarian and English** catalogs
  (see §7a). The active UI language is **independent** of the language agents generate prose in
  (operator may read an HU UI while an agent answers in EN, or vice-versa) — do not couple them. A
  missing key in the active locale MUST fall back to the install-default locale (then to English) and
  MUST NEVER render a raw key to the operator.

---

### 17a. Visual design system (the product's visual identity)

The dashboard's look is a deliberate, owned design — reproduce it as ORIGINAL CSS from design tokens
(full exhaustive detail in the design build-prompt; this is the spec-level contract).

- **Layout shell (MUST):** a CSS-grid app shell = a fixed **220px left sidebar** + a `1fr` main
  column (base 15px / line-height 1.5). Sidebar (sticky, full height, `--bg-card`, right hairline):
  a brand block (logo glyph + product name + a small "online" line) on top, a scrollable icon+label
  **nav** (active item = accent text + accent-soft pill + glow), and a footer (theme quick-toggle +
  a settings/"Tweaks" gear). Main: a **page-header** (display-font h1 title + muted subtitle) then
  the view content. Collapses to a drawer on narrow screens.
- **Token contract (MUST):** a ~30-variable token set (bg/bg-card/bg-card-hover/bg-input/bg-modal/
  bg-code; text/secondary/muted; border/border-focus; accent/hover/soft; danger/success/info +
  softs; shadow-sm/md/lg; radius/sm/lg; transition) + extended tokens **--font-display/-body/-mono,
  --glow (0..1), --ac (per-agent accent), --accent-violet, --accent-gold**. Every component re-skins
  from this set alone.
- **Themes (MUST — ship ≥5, default = "obsidian"):** OBSIDIAN COMMAND (default; dark, cyan #34D6F0 +
  violet #9B79FF + gold, deep #0A0A12, Space Grotesk/IBM Plex; dual radial ambient wash), STARK HUD
  (cyan #46E6FF arc-reactor; technical-grid backdrop, corner-bracket reticles, mono-uppercase
  instrument labels, Rajdhani/Chakra Petch), ARCANE FORGE (gold #E6B249 + ember on warm obsidian,
  Cinzel serif display), LIGHT (warm parchment #FAF9F5 / coral #D97757), DARK (neutral). Switch at
  runtime, no reload, persisted (see §17 theming).
- **Signature treatments (MUST keep the concept):** **per-agent accent** (--ac drives that agent's
  chrome); the **framed avatar** = clean portrait on a tinted dark radial disc, circular-cropped,
  with an accent rim + outer glow scaled by --glow (obsidian adds a slow conic rune-sweep; stark a
  corner-bracket reticle; honor prefers-reduced-motion); **glow** as a first-class adjustable
  variable (avatar rings, active-nav, focus rings).
- **Component inventory:** stat cards (big accent value + uppercase muted label), agent cards
  (framed avatar + name + role + status dot; auto-fill grid), the team **constellation** (hub
  featured, specialists in a grid) + an activity feed, pill badges, slide-up modals, dashed "add"
  cards.
- **Tweaks panel (SHOULD):** a floating live-customization panel — theme, **density**
  (comfortable/compact), **glow** slider, **accent** swatches — all persisted and applied
  **before first paint** (no flash-of-unstyled).

---

## 18. Persistence & data model

- **One embedded SQLite database in WAL mode**, file + sidecars **0600** (pre-create with
  `O_EXCL` 0600 to close the fresh-install TOCTOU window). If two processes ever share it, both open
  WAL + set a busy timeout + create shared tables idempotently.
- **Migrations are additive + idempotent** (re-running init on an existing DB is a no-op). Changing
  a checked-enum requires a **full table rebuild** (create new, copy all rows, drop, rename) — never
  lose a row, and rebuild any dependent full-text index + its triggers at the same time.
- **State files written atomically** (temp + rename on the SAME filesystem — keep the temp file a
  sibling of the target).
- **Core entities (concept-level; derive your own schema):** agent message queue; memories (+ a
  full-text shadow index); conversation ledger; daily logs; scheduled-task run log; pending-retry
  queue; kanban cards + comments; idea box; background tasks; token/usage accounting (+ an
  ingestion cursor per transcript so parsing is incremental/resumable/idempotent); a tool-call log
  (feeds a "what skill is worth creating" analyzer); session map (chat→session). **Operator
  settings are NOT DB rows** — they are vault/.env-backed and read at runtime (so saving takes
  effect without restart). Skills are filesystem, not DB. Be aware some auxiliary state
  (channel polling offsets, dedup logs) may live in their own tables.

---

## 19. Self-healing & supervision  — mostly OPTIONAL (shrinks in a clean runtime)

- **CORE:** the single-supervisor lock (port + pidfile, stale-age guard, refuse to kill unrelated
  processes); the desired-state reconciler with staggered restarts; idle-guarded scheduled restart.
- **Self-update (if included):** preflight MUST refuse on detached HEAD / wrong branch / dirty tree;
  serialize concurrent updates with a pidfile + stale-age guard (PID-recycling aware; ignore pid≤1);
  survive the updater restarting the app mid-update.
- **OPTIONAL / substrate-specific (avoid by not using the terminal+plugin substrate):** the family
  of "stuck" watchers (stuck-input, stuck-permission-prompt [alert-only; only clears a flag it
  itself set], stuck-tool-call [wall-clock stagnation, not displayed value; CPU-active + recent-
  respawn guards; replace only the process, never kill the session]); pane-state classification
  (scoped to the live input/footer region only — never match a busy/error phrase quoted in
  scrollback, a real source of "permanently stuck" incidents); orphan-poller reaping. **In a runtime
  with a proper agent API + first-class channel clients, almost none of this is needed.**

### 19a. Required for the terminal-multiplexer + chat-plugin substrate (the subscription path)

The "self-healing" family above is OPTIONAL only for a hypothetical subscription-free API runtime.
The subscription path uses the interactive TUI (§3a) and, if the chat provider is a CLI plugin, a
shared poll slot — so for THAT substrate these are MUST:
- **Record-first watchers:** a stuck-input watcher (re-submit input that never landed); a frozen
  tool-call watcher (detect by **wall-clock stagnation + low CPU**, then **replace the process in
  place** — never kill the session); a stuck-permission watcher and an API-error watcher that are
  **alert-only** (record + notify the operator, never auto-act). Every watcher records evidence
  before acting and only clears a flag it itself set.
- **Orphan reaping before every spawn:** identify a stale/orphaned poller or agent process by
  **pane attribution** (orphan iff neither it nor any ancestor is a live multiplexer-pane pid) —
  NOT by argv matching — corroborated by a pid-file and an environment scan. **FAIL SAFE: if the set
  of live panes cannot be determined, REFUSE to reap** (a wrongly-reaped live poller, or a surviving
  stale one, hammers the bot token, causes provider conflicts, and is misread as "down").
- **Channel isolation for non-chat agents:** any channel-less or background/headless agent MUST
  disable the chat plugin at project scope and read any token from its OWN state dir — otherwise it
  steals/kills the hub's live main poller.

---

## 20. Consolidated invariants (the non-negotiables)

1. **Agent isolation:** per-agent context/session/memory isolation; the hub is the sole structural
   exception and must be special-cased everywhere.
2. **Trust model:** `from` is untrusted; one sanitizer used identically at the write-guard and
   router; reserved ids rejected at the public endpoint; wrappers strip ALL security tags with a
   per-process random sentinel; trust tiers from code constants / known-agent graph only.
3. **Privilege gate:** no self-escalation; only the hub spawns programmatically; hard ceiling
   absolute (even for the operator); above-sandbox needs human approval; pure + unit-tested.
4. **Memory continuity:** never delete memories (decay only); conversation-ledger inbound
   idempotent via uniqueness, outbound message_id null; embeddings async + degrade to FTS.
5. **No message loss:** existing-but-busy targets are retried, never abandoned; inbound dedup +
   offset-after-handoff.
6. **Secrets:** never in config/argv/git/logs; vault indirection + at-launch resolution; list =
   metadata only.
7. **Dashboard auth:** bearer on all `/api/*` (tiny explicit exceptions); constant-time; loopback
   default; foreign-Origin writes rejected, missing-Origin allowed; token never logged.
8. **Soft-delete:** cards/ideas/memories archive, never hard-delete (history preserved).
9. **Single supervisor:** exactly one process owns scheduler/reconcilers/channels (lock-enforced).
10. **Scaffolding never overwrites** existing operator-edited files; schema additions are explicit
    additive migrations.
11. **Subscription billing only:** auth is the interactive subscription (OAuth); `ANTHROPIC_API_KEY`
    is NEVER present in any process env (a stray key silently bills pay-as-you-go, even the TUI). The
    in-process Agent SDK is pay-as-you-go and is NOT used for subscription-billed agents; `claude -p`
    is a capped, metered Agent-SDK-credit path post-2026-06-15, not the free pool (see §5).
12. **Dispatch-once:** card→in_progress wakes the agent exactly once (guarded); move hooks are
    error-tolerant.
13. **Live watch + serialized input:** the operator can always watch any running agent live and
    inject input into it; the supervisor is the sole owner of each agent's output stream and the
    sole serializer of its input, ordering machine + human messages into one stream so direct human
    typing never races machine delivery and is recorded, attributed, in the ledger. A literal
    terminal attach, if offered, is read-mostly and never the control plane.
14. **Language policy:** code/identifiers are English; operator-facing prose + UI are localized
    through an i18n catalog (no hardcoded UI literals); ship **both HU+EN** complete and first-class;
    operator-facing default is **Hungarian, switchable at runtime**; the install-wide default locale
    is chosen **at install**; UI language and agent-prose language are independent axes.

---

## 21. What is CORE vs OPTIONAL (for a lean, general v1)

**CORE:** agent runtime abstraction + lifecycle + reconciler; roster/config/seed; model-agnostic
LLM layer; inter-agent messaging + trust model; memory (tiers + FTS + ledger; embeddings optional);
scheduled tasks + runner semantics + the learning-loop machinery; two-tier skills; kanban; idea box
+ autonomy ladder; security profiles + privilege gate + Operating Contract; vault; dashboard + API +
auth + SSE; persistence/data model; single-supervisor + reconciler.
**...also CORE:** the dashboard **theme system + theme switcher** and **i18n layer + language
switcher** with **both first-class HU+EN catalogs** (§§7a, 17); the **one-command installer** +
**prerequisites doc** (§23); and the **four required docs** — README, architecture, usage/operator
guide, install guide (§23).

**OPTIONAL / pluggable / omit for v1:** the channel-plugin recovery layer (replace with a
first-class client); Studio/media gen; background tasks; the file browser; MCP connector catalog +
homelab/service monitoring + region-specific connectors; specific scheduled-task content
(grant-watcher, supply-chain scan, vault-curation, morning-brief content); specific local-model /
alternate-provider integrations; the "stuck" watcher family; OS-keychain master-key backend; the
self-update mechanism; voice transcription / inline buttons. **All branding, roster names, accent
colors, timezone, ports and paths are CONFIG, not code (do NOT hardcode a roster). Language is NOT
omit-by-default config:** the dashboard theme system + theme switcher, the i18n layer + language
switcher, and **both first-class HU+EN catalogs** are **CORE** (§§7a, 17); the operator-facing
default is **Hungarian, switchable**, with the install-wide default locale chosen at install (§23).

---

## 22. Open decisions for the architect (my recommendations)

1. **Agent runtime:** reference = **interactive Claude Code** behind the `AgentRuntime` interface —
   it is the only effectively-unlimited subscription-billed surface (see §5), so it is the default,
   not merely the fastest. Contain its terminal-driving inside the adapter; the single-serializer
   rule (§3) keeps it robust. The in-process **Agent SDK adapter is API-billed (pay-as-you-go) and
   must be opt-in only**, never the default. `claude -p` is a budgeted, capped-credit one-shot path
   (§5), not a free substitute for interactive agents. (This was an open decision; the billing
   verification closed it.)
2. **Channels:** **recommend first-class reconnecting clients** (drop the plugin substrate + its
   whole recovery layer). Pick one provider for v1 behind the `ChannelProvider` interface.
3. **Embeddings:** **recommend pluggable, default off** (FTS-only) for a clean v1; add a provider
   adapter when wanted.
4. **Media gen / background tasks / file browser / connectors:** **recommend deferring** to post-v1
   modules behind clean interfaces.
5. **Schema for enums:** decide the full status sets up front (card/idea/message/task) to avoid
   table-rebuild migrations later.
6. **Threat model:** the reference assumes a single trusted operator on a private host (one shared
   root-equivalent token). If you target a hosted/multi-user product, that needs real per-user auth
   + scoped tokens — a deliberate, larger decision; flag it before building on the single-token
   assumption.

---

## 23. Build & quality requirements

- TypeScript/Node, ESM, strict typecheck clean.
- A real test suite; the **pure security/privilege/trust functions MUST be exhaustively unit-tested**
  (the gate, the sanitizer, the routing decision, the permission precedence). Schema migrations and
  the ledger-continuity constraint tested.
- **Real end-to-end runtime smoke (MUST — not just mocked seams):** unit-testing the runtime adapter
  against an injected/fake driver is necessary but INSUFFICIENT — it passes while the real substrate
  is broken. There MUST be a smoke test that ACTUALLY creates a detached multiplexer session running
  an interactive process, asserts the session **persists and is attachable**, delivers input through
  the real path, and observes output via the live stream. (Where launching a real model session is
  impractical in CI, drive a trivial stand-in interactive program — but exercise the REAL
  multiplexer + input + capture path, never a mock.)
- **Headless-browser UI verification (MUST):** verify the dashboard with a **headless browser**
  (e.g. Playwright/Chromium) — load the SPA, exercise the **theme switcher** and the **language
  switcher (HU↔EN)**, confirm the live agent-output view renders and the input box posts, and
  **capture screenshots** as artifacts. A web UI IS verifiable without a human at a GUI; do this —
  do not declare the UI done on HTTP-status checks alone.
- Original code authored from THIS spec (clean-room) — own architecture, names, structure. The spec
  describes behavior; you choose the design.
- Ship a single config surface; no hardcoded roster/locale/paths; ship **both HU+EN** locales with
  the default chosen at install (§7a).
- **Easy install (MUST):** ship a **single-command install path** (one script / documented
  one-liner) that takes a clean supported host to a running system: install/verify runtime deps,
  create the state dir (0600), generate the dashboard bearer + master key, scaffold the seed roster,
  run migrations, **prompt for or accept the default locale (§7a)**, and print the bootstrap URL to
  stderr. The install MUST be **idempotent** (re-running is safe; never overwrites operator-edited
  files or rotates existing secrets) and MUST **fail fast with an actionable message** on any
  missing/incompatible prerequisite. It MUST NOT require or set `ANTHROPIC_API_KEY` (§5).
- **Prerequisites doc (MUST):** a deliverable that **lists every prerequisite** with
  **minimum/tested versions** (OS/arch support, Node/runtime version, package manager, the
  **subscription-authenticated interactive Claude Code CLI** + how its OAuth login is established, the
  chosen runtime substrate e.g. tmux, SQLite if external, optional embedding/media backends) **AND
  tells the operator how to install each one** (concrete per-OS commands or links), plus how to
  verify the subscription auth is active and that **no API key is present** in the target env. The
  install script SHOULD check these same prerequisites.
- **Required documentation deliverables (MUST — all four):**
  1. **README** — what the system is, quick start, the one-command install pointer, links to the
     other docs.
  2. **Architecture doc** — module boundaries, data model, the agent-runtime / channel / LLM seams,
     the trust & privilege model, the supervisor/single-owner design.
  3. **Usage / operator guide** — day-to-day operation: chatting with the hub, the dashboard (incl.
     the **theme switcher and language switcher**), kanban/idea box, scheduled tasks, watching/typing
     to a live agent, managing the vault, autonomy ladder.
  4. **Install guide** — full install walkthrough referencing the **prerequisites doc** (above) and
     the one-command installer, the default-locale choice, first-run bootstrap URL, and the
     HTTPS/exposure caveat (§17).
  Docs MUST be authored so the project can be open-sourced or handed off, and (per §7a) the
  **operator-facing docs ship in both Hungarian and English**.

---

_End of spec. The architect designs the architecture, file layout, schema and code from the above._
