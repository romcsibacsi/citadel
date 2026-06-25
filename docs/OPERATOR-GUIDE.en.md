# Operator Guide

This guide covers the day-to-day operation of the orchestrator: the dashboard, talking to the fleet, the board, schedules, secrets, skills and the security model — all from the operator's chair. Installation and prerequisites are covered separately (`scripts/install.sh`); this document assumes the system is installed and starts with `npm start`.

Names like CITADEL (the product) and NEXUS, FORGE, SPARK, SIGMA, RELAY, ORACLE, CREATIVE (the roster) come from the seed configuration (`seed/seed.config.json`). They are configuration, not code — your install may use different branding and a different roster. This guide uses the seed names for concreteness.

## 1. First contact: opening the dashboard

Start the supervisor:

```bash
npm start
```

On the **first** start (when the access token is freshly created) the bootstrap URL is printed **to stderr** — it is never written to a log file:

```
CITADEL dashboard: http://127.0.0.1:7080/?token=<long-random-token>
```

Every later start prints only the dashboard URL plus a pointer to the 0600 `dashboard-token` file in the state directory, so the token never recurs in any output. Open the bootstrap URL once per device (per browser). The single-page app reads the `?token=` parameter, stores it in the browser's localStorage, and immediately strips it from the address bar. From then on that browser is authenticated; you do not need the URL with the token again on that device. The token is root-equivalent — treat the bootstrap URL like a password. To bootstrap a new device later, read the token from the file and open `http://127.0.0.1:7080/?token=<value>` once.

The dashboard is an installable PWA (manifest + service worker). The service worker never caches `/api/*` responses, so what you see is always live. By default the server binds to loopback (`127.0.0.1:7080`); exposing it beyond the local machine is a deliberate configuration choice.

The left navigation contains these views:

- **Fleet** (home): one card per agent with its role, live state, desired state, and Start/Stop/Restart/Watch buttons; a collapsible "create agent" form at the bottom. A link to Approvals appears in the header when something is pending.
- **Agent** (hidden from the nav; opened via Fleet → Watch, route `#agent/<id>`): the live watch + type view — see section 3.
- **Board**: the kanban board — see section 4.
- **Ideas**: the idea box plus the autonomy ladder panel — see sections 4 and 5.
- **Memories**: per-agent memory browser with tier tabs (hot/warm/cold/shared), search, save and inline edit. "Delete" here is always a soft archive — memories are never hard-deleted.
- **Schedules**: scheduled tasks, the retry queue and recent runs — see section 6.
- **Skills**: the two-tier skill browser — see section 8.
- **Vault**: secrets and bindings — see section 7.
- **Channels**: Telegram channel status and configuration — see sections 2 and 7.
- **Approvals**: the pending spawn-request queue and the kanban cards still gated on approval. The nav entry shows a numeric badge when anything is waiting.
- **Settings**: UI language and theme (per device) plus the server settings — see section 9.

The nav footer holds the language and theme switchers; both apply instantly, without a reload, and are remembered per device.

## 2. Talking to the hub

The hub (NEXUS in the seed roster) is your single point of contact with the fleet. You reach it two ways:

**Via Telegram** — once the channel is configured (section 7) and the supervisor restarted, messages from the operator chat are stamped server-side as operator messages and routed to the hub. Any other chat is denied by default: messages from unknown chats are dropped without reply. The hub answers in the same chat.

**Via the dashboard** — open the hub's agent view (Fleet → NEXUS → Watch) and type directly into its live session. This works for the hub exactly as it does for any agent (section 3).

**How delegation works.** The hub does not do specialist work itself. When real work arrives, it decomposes the job and creates kanban cards for the right specialists. The dispatch rule is mechanical and worth knowing:

- Moving a card to **in_progress** dispatches it to the assignee **exactly once**. The dispatch fires only from the move operation and is guarded by a `dispatched_at` stamp — moving the card out of in_progress and back never re-dispatches it.
- The dispatched agent receives a machine-injected note with the card number, priority, title and description, and is expected to move the card onward with `agentctl` when done.
- The dispatch is deliberately a no-op when the assignee is you (operator), empty, unknown, or **not running**. In that last case the card simply sits in in_progress; start the agent (Fleet) and re-deliver by asking the hub, or comment on the card.

You can drive the same mechanism by hand: create a card on the Board, assign an agent, and move it to in_progress — the assigned agent wakes with the card.

## 3. Watching and typing to any live agent

The agent view (`#agent/<id>`) is the primary human window onto any running agent, regardless of who or what is currently driving it.

- **Live output stream**: a server-sent event stream of the agent's terminal. Each update is a full *rendered snapshot* of the agent's screen that replaces the view — a true "watch this terminal" projection, not a raw byte feed (the underlying terminal stream is full of cursor-positioning escapes and would be unreadable appended line by line). If the connection drops, the browser reconnects automatically and the view notes the reconnection — you never need to reload. The view keeps a scrollback of the last 500 lines per agent and autoscrolls unless you scroll up.
- **Send**: type into the input row and press Send. Your text goes through the supervisor's single per-agent serializer — machine deliveries and your typing can never interleave mid-message. If the agent is busy, your input waits until it is ready.
- **Interrupt**: the Interrupt button is a *forced* injection: it interrupts the agent's in-flight turn first, then delivers a standard "operator interrupt, stop and wait" prompt. Use it to stop a runaway or stuck agent.
- **Attribution**: everything you type here is recorded in the conversation ledger as an attributed operator entry *before* it is written to the agent. There is no unaudited operator input.

The state shown in the header (and on the Fleet cards) means:

| State | Meaning |
|---|---|
| **Stopped** | No running session. |
| **Ready** | Idle, will accept input immediately. |
| **Working** (busy) | Mid-turn; non-forced input waits, forced input interrupts. |
| **Needs input** | The session is sitting at a prompt (e.g. a permission question). Typing into the view answers it. |
| **Re-login needed** | The session's authentication expired. The agent receives **no** input in this state — see section 10. |

The panel below the stream lists the agent's conversation threads (per-peer last message), so you can see who it has been talking to.

## 4. The board and the idea box

### The board

Cards have four statuses — **planned → in_progress → waiting → done** — shown as four lanes. Planned is the entry column; there is no separate backlog. Priorities are **low / normal / high / urgent** (high and urgent are visually flagged). Cards can carry a free-text **project** label; the filter at the top narrows the board to one project.

Click a card to open its detail panel:

- **Move** buttons switch status. Moving to in_progress is the dispatch trigger (section 2).
- **Comments** are append-only and attributed (you appear as `operator`, agents under their own id).
- **Approve** appears on cards flagged `requires approval` and clears the gate (it also logs an "approved" comment). These cards are also collected on the Approvals view.
- **Archive** is a soft archive — the card disappears from the board but history is preserved.
- **Delete** is a hard delete with confirmation, available only to you; it cascades the comments.
- **Breakdown** splits a card into subtasks: one title per line. Each subtask is routed to a specialist lane by a keyword router (the lanes and keywords are configuration — `lanes` in the config file), so "fix the build script" lands on FORGE and "research the market" on ORACLE. Breakdown is one level deep: a subtask never offers the form.

The form at the bottom creates a new card (title, description, assignee, priority, project).

### The idea box

Ideas are lighter than cards: things noticed by you or the fleet that are not yet work. Statuses: **new, reviewed, kanban, rejected, archived** — the tabs at the top filter by status, the Archived toggle shows archived ones.

Per idea:

- **Promote** creates a linked kanban card and sets the idea's status to `kanban`. The link is bidirectional — the idea row shows the card number.
- **Breakdown** promotes *and* immediately splits the new card into lane-routed subtasks (one per line).
- **Reject** and **Archive** are soft status changes; nothing is ever deleted.
- **Auto-archive**: when a promoted idea's linked card reaches `done`, the idea archives itself automatically.
- **Reconcile** (button in the tab bar) is the manual sweep for the same rule: it archives every idea whose linked card is already done, and reports how many it caught. Use it if an auto-archive was missed (the hooks are deliberately error-tolerant — a hook failure never blocks a card move).

The add form (title, description, category) is below the list; agents add ideas the same way via `agentctl idea add`.

## 5. The autonomy ladder

At the bottom of the Ideas view sits the autonomy ladder: per-category trust levels that gate how far agents may act without you.

- Each category has a **level (1–3)**, a **max level**, and possibly a **locked** badge. Level 1 means the category is a genuine human decision — agents must escalate to you before acting. Higher levels grant progressively more freedom to act and report rather than ask.
- Five categories are **hard-locked in code** and can never exceed level 1, no matter what the UI, the configuration or an agent attempts: **publish, payment, data-delete, permission-change, external-message**. The server refuses any change to them (you will see a 403 in a toast), and even a tampered database row is repaired back to 1/1/locked at startup.
- The seed ships seven adjustable categories — `kanban_archive_done`, `kanban_stuck_nudge`, `memory_maintenance`, `routine_trivial_fix`, `deploy_retry`, `kanban_restructure`, `skill_patch` — at level 1 with a maximum of 3, plus `email_send` (level 1, capped at a maximum of 2). Your changes survive restarts and upgrades; re-seeding never resets an operator-set level.

## 6. Scheduled tasks and the learning loop

The Schedules view manages prompt-on-a-timer tasks.

**Schedule format**: standard 5-field cron — `minute hour day-of-month month weekday`, e.g. `30 7 * * 1-5` for 07:30 on weekdays. The aliases `@hourly`, `@daily`, `@weekly`, `@monthly` are accepted. Schedules are evaluated in the server's configured **timezone** (Settings; the seed default is Europe/Budapest). The scheduler has a catch-up window, so a fire missed during a short outage or restart is delivered late rather than dropped (a longer window applies on the first tick after boot).

**Fields**: every task has an id, title, prompt (the text delivered to the agent), cron expression, target (one agent or `all`) and a type — **task** (normal delivery) or **heartbeat** (silent consolidation cadence).

**Flags**:

- **skipIfBusy** — if the target is busy, drop this fire silently. Opt-in, and only sensible for short-cadence tasks where the next tick is imminent (the seeded 30-minute heartbeat uses it).
- **forceSend** — deliver even into a busy agent: interrupt the in-flight turn, then inject. The escape hatch for must-run-now tasks (the morning brief uses it).
- **bypassTriage** — the task runs unconditionally, past any triage: the runner treats it exactly like forceSend (deliver even into a busy agent, interrupting the in-flight turn). Meant for heartbeat-style tasks that must fire even on quiet or busy days.

**The never-abandon retry queue.** A task without skipIfBusy whose target is busy or down is *not* dropped: it is persisted to the retry queue and retried (every 10 minutes by seed config) until it is delivered or you cancel it. The queue is visible on this view with a Cancel button per row. If a queued task stays stuck, you get exactly one alert on the operator channel (the alert flag is claimed before sending, so concurrent ticks and restarts cannot double-alert). The "Recent runs" panel shows each fire's outcome: delivered, queued, skipped or failed.

**The seeded learning loop.** Five tasks ship with the system:

| Id | Schedule | Target | What it does |
|---|---|---|---|
| `heartbeat-consolidate` | `*/30 * * * *` | all | Silent consolidation: save memory, write a daily-log line, consider a reusable skill. Never messages you. skipIfBusy. |
| `nightly-dream` | `30 2 * * *` | hub | Overwrites the nightly dream file: team recap, proposals, memory health, tomorrow's top-3; Mondays add an opportunity scan. File/memory output only. |
| `dream-consumer` | `0 7 * * *` | hub | Turns dream proposals into action: local skills, kanban cards, idea-box entries. Never messages you. |
| `cross-agent-sync` | `15 3 * * *` | hub | Writes shared-tier memory about who did what and who is good at what. |
| `morning-brief` | `0 8 * * *` | hub | The one scheduled task allowed to reach your channel: yesterday's recap, board status, fresh ideas, today's top-3. forceSend. |

Background tasks running while you sleep must never message a live channel — only the morning brief deliberately does, and only via the hub.

**Adjusting the loop**: edit any seeded task in place (prompt, cron, flags) or toggle it off — your edits are never overwritten by re-seeding. Do **not** delete a seeded task to silence it: seeding is insert-if-absent, so a deleted seed task reappears (with seed defaults) at the next start. Disable it instead.

## 7. The vault

The Vault view is the only place secret values exist in plaintext, and only briefly.

- **Listing shows metadata only** — id, label, timestamps. Values are never included in a list, anywhere in the API.
- **Reveal** fetches one value explicitly; it is shown for 30 seconds and then auto-hidden. Copy puts it on the clipboard. Reveal discipline: reveal only what you are about to use, and never paste a secret value into a chat, a card, a memory or anything an agent will read.
- **Set / update**: the form (id, label, value) creates or overwrites a secret. The value field is cleared as soon as it is saved; an updated secret also invalidates any still-revealed stale value on screen.
- **Delete** removes a secret after confirmation.
- Secrets are stored encrypted (AES-256-GCM, per-secret derived keys) in the SQLite database; the master key lives in a separate 0600 file in the state directory. Configuration files only ever hold a `vault:<id>` reference, never a plaintext value.
- **Bindings** map a secret id to an environment variable name (optionally per target). The panel records and manages these mappings. **Deferred:** in the current build the binding list is bookkeeping only — the launch path does not yet inject bound secrets into agent environments. The one live automatic consumer of the vault is the Telegram token below.

**The Telegram token flow.** On the Channels view, paste the bot token into the form. The token is write-only: it is stored straight into the vault under the id `telegram-bot-token`, the config file keeps only the `vault:telegram-bot-token` reference, and the form field never echoes it back. Set the **operator chat id** (your own Telegram chat with the bot) and tick **enabled**. The change takes effect at the next supervisor restart — the view says so explicitly. After the restart the status card shows enabled / connected / token configured, and the Test button validates the token against the Telegram API. Only the operator chat carries your authority; every other chat is denied by default.

## 8. Skills

Skills are reusable instructions agents load on demand. There are two scopes:

- **Global** skills are visible to the whole fleet.
- **Agent-local** skills are visible only to their owner. An agent's index never exposes another agent's local skills.
- A local skill with the same name as a global one **shadows** it for that agent — the browser marks these with a "shadows" badge when you view an agent's effective set.

The view's selector switches between the global list and one agent's effective set (global + its own local skills). Clicking a name opens the reader: the full skill body plus the list of helper files.

**Governance** (enforced server-side; violations come back as a 403 toast):

- Creating a **global** skill requires hub approval. Your dashboard actions outrank the hub, so creating one from the UI carries implicit approval. Agents can freely create their own **local** skills; a non-hub agent trying to write a global skill is rejected.
- **Pinned** (factory) skills are immutable: the UI offers no delete for them and the server refuses anyway.
- Deleting a skill is an operator-only action.

**Import** brings in a skill from a directory on the host (path in the form, scope and target agent selectable). The importer rejects path traversal and symlinks and refuses to overwrite an existing skill name — a malicious or sloppy skill directory cannot escape or clobber anything.

## 9. Theme, language and server settings

Two independent layers of preference:

**Per device (this browser)** — on the Settings view (and in the nav footer):

- **UI language**: Hungarian and English ship complete. Switching is instant — no reload, no server restart — and the choice is persisted in the browser and applied before first paint (no flash in the wrong language).
- **Theme**: the default dark "arcane" theme and a light "daylight" theme. Same behavior: instant, persisted per device, applied pre-paint.

**Server settings** (apply to the whole installation):

- **Default UI language**: the install-time choice (`./scripts/install.sh --locale hu|en`); what a fresh device sees before picking its own. Changing it also switches the backend's operator-facing prose live.
- **Agent prose language**: an independent axis — the language agents write *to you* in. You can run an English UI with Hungarian agent prose or any other combination; the two are deliberately not coupled.
- **Timezone**: an IANA name (e.g. `Europe/Budapest`); this is what cron schedules are evaluated in.
- **Product name**: rebrands the dashboard and notifications live.

## 10. Agent lifecycle

**Start / Stop / Restart** are on the Fleet cards and in the agent view header. Restart offers a **fresh** checkbox:

- a normal restart **continues** the previous session — the agent keeps its accumulated context;
- a **fresh** restart drops the context and starts clean. Use fresh when an agent is confused or its context has degraded.

Either way, every (re)started session receives a machine-injected **continuity replay** right after start: the recent conversation transcript (with the open question marked) and the agent's last saved task state, so the agent resumes where it left off instead of waking up blank.

**Desired state and the reconciler.** Start/stop buttons do two things: they act now, and they persist your *intent* ("this agent should be running"). A background reconciler compares intent with reality once a minute and repairs the difference — agents that should run but are down get restarted (staggered, to avoid a thundering herd after an outage), agents that should be stopped but run are stopped. So a crashed agent comes back on its own; an agent you stopped stays stopped. Each fleet card shows the desired state next to the live state.

**Agents persist across a supervisor restart.** The agents run on the fleet's own dedicated tmux server (a separate socket, `citadel-mux`), and the sessions are owned by that server, not by the supervisor. So restarting or redeploying the supervisor (e.g. `systemctl restart citadel`) does **not** stop your agents — the new supervisor simply *adopts* the still-running sessions and reconnects to them. Recovery of a single stuck agent is a respawn of just that agent's session; the server (and every other agent) is never touched. To deliberately stop the whole fleet, kill that server explicitly: `tmux -L citadel-mux kill-server`.

**Creating and deleting agents.** The Fleet form creates a new agent (id, name, role, security profile, accent color). Available profiles are sandbox, draft and trusted-build; the full-host profile exists only as pre-seeded configuration and can never be assigned — not to new agents, and not to existing ones (seed roster included) via a profile change. Seed-roster agents cannot be deleted — their names are reserved; agents you created can be (with confirmation).

**Reauth escalation.** Agents run as interactive Claude Code sessions in tmux, billed against your subscription login. When a session's authentication expires the agent enters the **Re-login needed** state. Three things are guaranteed:

1. The agent receives no input of any kind in this state — injection attempts are rejected with an error instead of being typed into the dead session.
2. You are notified exactly once per episode on the operator channel.
3. **Credentials are never auto-injected.** The system will not type a password or token into a session, ever. You log in manually:

```bash
tmux -L citadel-mux attach -t citadel-<agent-id>     # e.g. tmux -L citadel-mux attach -t citadel-nexus
# complete the login in the session, then detach: Ctrl+B, then D
```

(`citadel-mux` is the seed's dedicated tmux socket, `runtime.claude.socket`; the `citadel-` session prefix is `runtime.claude.sessionPrefix` — check your config if you changed either.) Once the session authenticates, the state clears on its own.

## 11. The security model in operator terms

You do not need to read the code to trust the system, but you should know what holds it together:

**Trust frames.** Every message delivered to an agent is wrapped in a security frame stating who it is really from: operator, hub, trusted peer, untrusted, or external channel. Only the operator frame carries your authority. Any frame-like tags inside a message body are neutralized with a random per-process marker before delivery — a sender cannot fabricate a closing tag and open a fake "operator" frame, because the marker is unguessable.

**Why from-spoofing does not work.** When an agent posts a message, the server overrides any self-asserted sender with the identity bound to its API token. Reserved identities (operator, the hub id, channel) are rejected outright for unauthenticated senders, and your own messages go through a separate operator-only endpoint that stamps the sender server-side. An agent or external party simply has no path to make a message *arrive* as you.

**The spawn approval queue.** Agents (in practice: only the hub) can request new agents programmatically. The privilege gate is pure, exhaustively tested code:

- Only the hub may spawn programmatically; any other agent is denied.
- A child may never exceed its requester's privilege (no self-escalation).
- Sandbox-level requests proceed automatically; anything above sandbox is **parked** in the Approvals queue for your explicit approve/deny. You are notified on the operator channel when something parks.
- Your dashboard actions count as human approval — but only up to the ceiling.

**The profile ceiling.** Privilege levels run 0 (sandbox), 1 (draft), 2 (trusted-build), 3 (full-host). Level 2 is the absolute spawn ceiling: nothing above it can ever be created — not by an agent, and not by you through the dashboard. Full-host exists only for the pre-seeded roster (the hub). The same ceiling applies to profile changes on existing agents.

Three further standing guarantees: the system refuses to start (and to install) if any billing-flipping variable — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` — is present in the environment (and strips all four from every agent launch), because a stray credential would silently flip subscription-billed sessions to metered or external billing; the dashboard token and the vault master key live as 0600 files in the state directory (`~/.orchestrator` by default, or `$ORCHESTRATOR_STATE_DIR`); and everything you type into a live agent is in the conversation ledger, attributed to you.
