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
  Crucially: deliver prompts via a **proper API/IPC to the agent process**, not tmux keystrokes,
  if the chosen agent process supports it; if you must drive a CLI, encapsulate ALL of that inside
  the adapter so the rest of the system only sees `send()`/`status()`.
- **Channels = first-class long-poll/websocket clients you own** (a reconnecting `ChannelClient`
  per provider). This makes the entire watchdog/recovery/backfill layer **unnecessary** — a normal
  reconnecting client with offset persistence + dedup replaces it.

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
- **Locale/branding are configuration**, not code: roster names, accent colors, language of
  generated prose and operator messages, timezone, install paths, ports — all config-driven. Ship
  English defaults. (The reference system was Hungarian + a fixed roster; do NOT hardcode either.)
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

OPTIONAL / substrate-specific (only if you reuse the CLI-in-terminal substrate): modal dismissal
after spawn, keystroke chunking, pane double-sampling for readiness, single-quoting model strings,
encoded-projects-dir probing before resume. A clean adapter that talks to the agent via API avoids
all of these — prefer that.

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
- **Backend routing by model id (data concept):** a model string both names the model and selects a
  backend. Provide a clean **adapter seam**: default vendor (subscription OAuth); alternate
  providers and **local models** via an Anthropic-compatible base-URL + auth-token override; an
  explicit per-agent **api-key opt-in** (key resolved from the Vault, never from argv/git). Short
  model aliases resolve from a **config map** (don't hardcode a model lineup).
- **One-shot text generation** (for generating persona docs / skill docs) MUST use a separate
  non-interactive code path — never the live interactive agent path.

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
  clients); skip overlapping ticks.
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
11. **Auth default = subscription OAuth; never require ANTHROPIC_API_KEY** on the default path.
12. **Dispatch-once:** card→in_progress wakes the agent exactly once (guarded); move hooks are
    error-tolerant.

---

## 21. What is CORE vs OPTIONAL (for a lean, general v1)

**CORE:** agent runtime abstraction + lifecycle + reconciler; roster/config/seed; model-agnostic
LLM layer; inter-agent messaging + trust model; memory (tiers + FTS + ledger; embeddings optional);
scheduled tasks + runner semantics + the learning-loop machinery; two-tier skills; kanban; idea box
+ autonomy ladder; security profiles + privilege gate + Operating Contract; vault; dashboard + API +
auth + SSE; persistence/data model; single-supervisor + reconciler.

**OPTIONAL / pluggable / omit for v1:** the channel-plugin recovery layer (replace with a
first-class client); Studio/media gen; background tasks; the file browser; MCP connector catalog +
homelab/service monitoring + region-specific connectors; specific scheduled-task content
(grant-watcher, supply-chain scan, vault-curation, morning-brief content); specific local-model /
alternate-provider integrations; the "stuck" watcher family; OS-keychain master-key backend; the
self-update mechanism; voice transcription / inline buttons. **All branding, roster names, accent
colors, prose language, timezone, ports and paths are CONFIG, not code — ship English defaults.**

---

## 22. Open decisions for the architect (my recommendations)

1. **Agent runtime:** reference = Claude Code behind the `AgentRuntime` interface (fastest to a
   working feature-equivalent system). **Recommend:** deliver via the cleanest IPC the agent process
   supports; keep all substrate quirks inside the adapter. Decide later whether to add a managed-
   process/SDK adapter.
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
- Original code authored from THIS spec (clean-room) — own architecture, names, structure. The spec
  describes behavior; you choose the design.
- Ship sensible English defaults + a single config surface; no hardcoded roster/locale/paths.
- A short README + an architecture doc so it can be open-sourced or handed off.

---

_End of spec. The architect designs the architecture, file layout, schema and code from the above._
