---
CLEAN-ROOM BUILD PROMPT — written from a behavioral/visual study of a reference product. You (the engineer, "Fable 5") have never seen the original source. Do NOT seek, request, or reproduce any original source code, identifiers, file names, routes, or DB schema. Implement everything ORIGINALLY from this behavioral + visual description. Where it says "an endpoint like" or "a concept like," treat it as a contract to design freshly, not a string to copy. Look-and-feel (color, type, spacing, motion, components) is governed by `01-design.md`; this document specifies WHAT exists and HOW it behaves.
---

# 21 — Activity (Aktivitás)

> IMPORTANT NAMING / SCOPE NOTE FOR FABLE 5: In this product the page literally titled **"Activity / Aktivitás"** is NOT a scrolling log of historical events. It is a **live, self-refreshing status board of the whole agent fleet** — one card per agent, each showing what that agent is doing *right now* and a short tail of its live terminal output. A *separate, smaller* "recent events" feed (delegations + memories, newest-first) lives only as a widget on the **Overview** page; it is described here in section 11 ("THE OTHER ACTIVITY") so you do not confuse the two. Build the live status board as the Activity page. Build the chronological feed only as an Overview widget (covered in the Overview spec; summarized here for disambiguation).

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** Give the operator a single glanceable answer to "what is every agent doing this very second?" without opening N terminals. Each agent in the fleet gets a card showing a live state badge (working / idle / unknown / error / stopped) and the last several lines of its terminal pane. The board re-polls every few seconds, so it behaves like a wall-monitor / mission-control view. Any agent whose session is actually running can be clicked to open a full interactive terminal.

**Where it lives.** A top-level item in the left sidebar navigation, sitting in the cluster near "Agents / Ügynökök" and "Team / Csapat."
- Nav label: **HU "Aktivitás"** / **EN "Activity"**.
- Nav icon idea: a "live signal / broadcast" mark — concentric radiating arcs around a small center dot (think a Wi-Fi/RSS-style emanation or a pulse/radar ring). It should read as "live / streaming," distinct from a clipboard or list icon (which would wrongly imply a static log). Single-stroke line icon, ~18px, matching the other sidebar glyphs per `01-design.md`.
- Routing: selecting the nav item navigates to the Activity page via a hash/route token like `#activity`. The route is the single source of truth; deep-linking to `#activity` must land directly on this page and start the live poll.

**Subtitle (page header, shown under the H1).**
- HU (default): **"Mit csinál épp minden ügynök — élő nézet, 3 mp-enként frissül"**
- EN: **"What every agent is doing right now — live view, refreshes every 3 seconds"**

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — defer all styling to `01-design.md`)

Top to bottom:

1. **Page header row** (flex, title on the left, meta on the right):
   - **H1 title** — HU "Aktivitás" / EN "Activity".
   - **Subtitle line** directly beneath the title (the HU/EN string in §1).
   - **Right-aligned meta slot**: a small, muted "last updated" timestamp label (see §3, "Frissítve").
2. **The live card list** — a responsive grid/flow of equal-width **agent status cards** filling the page body. One card per agent. On wide screens this is a multi-column grid; on narrow/mobile it collapses to a single column. (Exact columns, gaps, breakpoints → `01-design.md`.)
3. No footer, no pagination, no separate toolbar. The page is intentionally minimal: header + cards.

There is **no** search box, **no** filter chips, **no** sort control, **no** tabs on this page (see §3 — the page deliberately has almost no controls; its value is the always-on live grid). Keep it that way unless `01-design.md` introduces optional enhancements.

The card list region must always render *something*: a loading placeholder, an empty message, an error message, or the cards (see §7 States).

---

## 3) CONTROLS — every interactive element

This page is deliberately control-light. The complete inventory:

1. **Sidebar nav item "Aktivitás / Activity"** — navigates to the page; activates the live poll on entry, deactivates it on leave (see §7 poll lifecycle).
2. **"Last updated" timestamp (read-only label)** — top-right of the header. Not clickable. Text format:
   - HU: **"Frissítve: HH:MM:SS"** (localized 24h time, Hungarian locale).
   - EN: **"Updated: HH:MM:SS"**.
   - It is rewritten after every successful poll to the current local time. Empty before the first successful poll.
3. **Agent status card (the whole card is the control, conditionally)** — clicking a card opens that agent's interactive Terminal modal, BUT only for cards whose agent session is actually running. Non-running cards are not clickable (no hover affordance, no cursor change). See §5 + §6.
4. **Terminal indicator icon (on running cards only)** — a small terminal/chevron glyph (an angle-bracket prompt "›" plus a baseline, i.e. a stylized command-prompt mark) shown in the card's top-right next to the state badge. It is a visual affordance only — clicking anywhere on the running card (including this icon) opens the terminal. Tooltip HU "Terminal megnyitása" / EN "Open terminal."
5. **State badge (on every card)** — a small colored pill showing the agent's live state word. Read-only, but carries a hover tooltip explaining the state (see §4 for the five states, labels, and tooltips).
6. **"Main / fő" badge (on the orchestrator's card only)** — a tiny pill marking the single hub/orchestrator agent. Read-only. HU "fő" / EN "main."

There are NO destructive controls on this page. There is no create/delete/start/stop button here (those live on the Agents page). The only action is "open this agent's terminal."

Inside the opened **Terminal modal**, controls are: a **Close button** (the "×" in the modal header) and the **terminal surface itself** (a real keyboard-interactive terminal — every keystroke is sent to the agent). See §5.

---

## 4) THE LIVE STATE MODEL (drives badge text, color class, tooltip)

Each card shows exactly one of five live states. The backend derives the state from a snapshot of the agent's terminal pane each poll. You must reproduce these five states, their HU/EN labels, and their tooltips. (Color mapping → `01-design.md`; suggested intent in brackets.)

| State key | HU badge | EN badge | Intent / color cue | Tooltip HU | Tooltip EN |
|---|---|---|---|---|---|
| working | **dolgozik** | **working** | active/positive (e.g. green/cyan) | "Élő állapot (a terminál tartalmából, 3 másodpercenként): éppen dolgozik / gondolkodik." | "Live state (from the terminal contents, every 3 seconds): currently working / thinking." |
| idle | **várakozik** | **idle** | neutral/calm (e.g. muted blue/grey) | "Élő állapot (3 másodpercenként): fut, de épp nem csinál semmit." | "Live state (every 3 seconds): running but not doing anything right now." |
| unknown | **ismeretlen** | **unknown** | undetermined (e.g. dim grey) | "Élő állapot: nem sikerült megállapítani a session tartalmából." | "Live state: could not be determined from the session contents." |
| error | **hiba** | **error** | warning/danger (e.g. red/amber) | "Élő állapot: hiba látszik az ágens session paneljén." | "Live state: an error is visible in the agent's session pane." |
| stopped | **leállt** | **stopped** | inactive (e.g. dark/grey) | "Élő állapot: az ágens session nem fut." | "Live state: the agent's session is not running." |

State derivation (behavioral contract — design your own detector; do NOT copy original logic):
- If the agent's terminal session is **not running** → state is **stopped**.
- If it is running but the pane snapshot is unavailable/empty → **unknown**.
- Otherwise classify the live pane snapshot heuristically: signs of active work or input being typed → **working**; a quiet ready prompt → **idle**; visible error output → **error**; anything ambiguous → **unknown**.
- The whole card should also carry a state-derived style class so the card chrome (border/tint) can reflect the state per `01-design.md`.

---

## 5) LISTS / CARDS — the agent status card (and its opened modal)

### 5a) The agent status card (one per agent)

Each card contains, top to bottom:

- **Header row** (flex, space-between):
  - **Left: agent name** — the agent's identifier/name, shown verbatim (escape it). Immediately after the name, **only for the orchestrator/hub agent**, a tiny **"fő / main"** badge.
  - **Right: a group of** the **terminal indicator icon** (only if the agent is running) followed by the **state badge** pill (always). 
- **Body: live output tail.**
  - If there is recent pane output: a **monospace, pre-formatted block** showing roughly the **last ~8 non-empty lines** of the agent's terminal output (trailing whitespace trimmed, blank lines dropped). This is a read-only preview, not interactive. It updates on every poll.
  - If there is no output to show, render a muted placeholder instead of the pre block:
    - When the session is running but produced no fresh output → HU **"nincs friss kimenet"** / EN **"no recent output."**
    - When the session is not running → HU **"a session nem fut"** / EN **"the session is not running."**

Per-card interactions:
- **Whole card click → open Terminal modal** for that agent — *only if the agent is running*. Running cards get a clickable affordance (pointer cursor, hover highlight per `01-design.md`); non-running cards are inert.
- No per-card kebab/overflow menu, no inline buttons. The card has exactly one action (open terminal) and it is the whole card.

The fleet shown on the cards includes **every agent**, plus the **hub/orchestrator** agent itself (which runs in a slightly different session than the sub-agents but is surfaced as a normal card marked "fő/main"). Order: hub/orchestrator card first, then the remaining agents.

### 5b) There is no table and no nested list on this page.

The grid of cards is the only collection. Each "item" is a card as specified in 5a.

---

## 6) OPENED CARDS / MODALS / DETAIL PANES

### The Terminal modal (opened by clicking a running agent card)

This is the only modal reachable from the Activity page. It is a **full interactive terminal** attached live to the chosen agent's session.

**Trigger.** Click anywhere on a *running* agent's card.

**Modal structure:**
- **Modal header**:
  - **Title** — the agent's name followed by a "— Terminal" suffix. Format: HU **"<AgentName> — Terminál"** / EN **"<AgentName> — Terminal"** (the original shows "<name> — Terminal"; localize the word).
  - **Close button "×"** at the top-right of the header.
- **Modal body**: a single large **terminal surface** (a real terminal emulator widget) on a dark background, monospace font, fixed-height-with-flex-grow so it fills the modal (min height around 360px; the modal is wide enough to show ~140 columns). It supports scrollback (a few hundred lines). It is focusable and receives keystrokes immediately on open.

**Live output into the terminal:**
- On open, the modal subscribes to a **server-sent live stream** of that agent's pane (a streaming endpoint like `GET /api/agents/<name>/pane/stream`, authenticated — see §6 auth note). Each streamed frame is a full snapshot of the current pane; the modal **clears and repaints** the terminal with each frame (so it mirrors the live tmux-style pane rather than appending). Strip any embedded hyperlink escape sequences before writing.
- If the stream errors or the session stops, write a short inline notice into the terminal: HU **"[stream hiba vagy leállva]"** / EN **"[stream error or stopped]."**

**Keyboard input (interactive):**
- Every keystroke typed into the terminal is **sent to the live agent session** via a POST endpoint like `POST /api/agents/<name>/keys`. 
- The client must translate special keys into named tokens and send plain characters as raw text. Support at minimum: Enter, Escape, Up, Down, Left, Right, Backspace, Tab, Shift-Tab, Ctrl-C, Ctrl-D, Ctrl-U, Ctrl-L, PageUp, PageDown. Plain typed characters go through as their literal text. (Behavioral contract: this lets the operator drive the agent's CLI directly from the browser — answer prompts, send Ctrl-C, scroll, etc.)
- Use a single input handler to avoid double-firing keys.

**Resize behavior:** the terminal re-fits to the modal size when the modal is resized (debounced; observe the modal wrapper, not the terminal element, to avoid a resize loop).

**Auth note for streaming/keys:** because the live `<img>`-style stream and the keypress posts may not pass through the app's normal auth header path, the client passes the dashboard token as a query param on the stream URL and includes auth on the keys POST. Design your own auth carriage; the contract is "the stream and keystroke channels are authenticated with the operator's session token."

**Closing the modal:**
- Clicking **×** closes the modal AND tears down the live stream subscription and disposes the terminal instance (no leaked streams). Reopening recreates a fresh stream.
- Opening a *different* agent's terminal must first cleanly close any previously open stream/terminal before attaching the new one.

There are NO other modals, drawers, or detail panes on this page. No "agent detail" card, no settings, no confirmation dialogs (there are no destructive actions here).

---

## 7) FLOWS & BEHAVIOR (step by step + contracts)

### 7a) Entering the page / live poll lifecycle
1. Operator navigates to `#activity`.
2. The page immediately performs one fetch of the fleet status (an endpoint like `GET /api/agents/activity`) and renders cards.
3. It then **polls the same endpoint every ~3 seconds**, re-rendering the grid each time and updating the "Frissítve / Updated" timestamp on each successful poll.
4. **Leaving the page stops the poll.** Navigating to any other page must clear the interval so no background polling continues. Returning restarts a fresh poll cycle (immediate fetch + interval).
5. The poll is the only refresh mechanism — there is no manual refresh button (the timestamp tells the operator how fresh the data is).

**Fleet status contract** (`GET /api/agents/activity`): returns an array, one entry per agent (hub/orchestrator first), each with: the agent **name**; a boolean **isMain** (true only for the hub); a boolean **running** (session alive?); a **state** (one of the five keys in §4); and a **tail** = array of the last ~8 non-empty output lines (already trimmed). The client maps these straight onto the card in §5a.

### 7b) Opening a terminal
1. Operator clicks a *running* card → §6 modal opens.
2. Client subscribes to the per-agent pane stream and focuses the terminal.
3. Streamed frames repaint the terminal; keystrokes POST to the per-agent keys endpoint and thus reach the live session.
4. Operator can interact fully (answer prompts, Ctrl-C, scroll). Closing tears everything down.

There are **no destructive actions** on this page, so **no confirmation dialogs** are required. (Note: typing into a live agent terminal *is* powerful — it drives the real agent — but it is interactive control, not a one-click destroy; do not gate it behind a confirm, mirror the original's direct interactivity. Access control is the gate, see §8.)

### 7c) Error handling per poll
- If a poll fails (network/HTTP error), replace the card list with a single error line (see §7 States) but keep the interval running so it self-heals on the next successful poll.

---

## 8) STATES (empty / loading / error / permission) + live behavior

- **Loading (first paint, before first poll resolves):** the card-list region shows a single muted placeholder line: HU **"Betöltés…"** / EN **"Loading…"**.
- **Empty (no agents at all):** a single muted line: HU **"Nincs ügynök."** / EN **"No agents."**
- **Poll error (fetch failed):** the card-list region is replaced by a single muted line incorporating the error message, prefixed: HU **"Nem sikerült lekérni az aktivitást: <error>"** / EN **"Could not fetch activity: <error>."** The poll keeps running and will recover the grid on the next success.
- **Per-card "no output":** see §5a placeholders ("nincs friss kimenet" / "a session nem fut").
- **Terminal stream error/stopped:** inline notice in the terminal (§6).
- **Live-update behavior:** the whole grid re-renders every ~3s; the "Frissítve/Updated" timestamp updates each successful poll; the poll is bound to page presence (starts on enter, stops on leave). No websockets for the grid (it is a simple repeating fetch); the *terminal modal* uses a server-sent stream.

There is no dedicated "permission denied" UI on this page beyond the standard app-level auth — see §8 permissions. If the operator is not authenticated at the app level, they never reach the dashboard at all; this page assumes an authenticated operator.

---

## 9) PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- **Operator-only surface.** The Activity page (and the terminal modal) is part of the operator's dashboard. Agents themselves do not "view" this page; they are the *subjects* shown on it. Treat the entire page as gated behind the operator's authenticated dashboard session/token.
- **No per-role hiding within the page.** All agents in the fleet are shown to the operator, including the hub/orchestrator (marked "fő/main"). There is no agent-facing variant.
- **Autonomy gating is NOT applied to viewing** — the live status board is read-only observation and is always available to the operator regardless of the system's autonomy level. The *terminal modal's keystroke channel* is direct human control and is therefore inherently operator-only (it requires the operator's token to stream and to send keys); design it so an agent cannot reach those channels.
- **Token carriage:** the poll uses the normal authenticated fetch path; the terminal stream and keystroke channels carry the operator's dashboard token explicitly (query param for the stream, auth on the keys POST) because they bypass the standard fetch wrapper. Implement so an unauthenticated request to the stream/keys endpoints is rejected.

---

## 10) DATA CONCEPTS read/written (concept level — design your own schema)

**Read (per poll, per agent):**
- Agent identity/name and whether it is the hub/orchestrator.
- Whether the agent's terminal session is currently running.
- A snapshot of the agent's live terminal pane (used both to derive the state and to extract the last ~8 output lines).

**Read (terminal modal):**
- A continuous live stream of the agent's terminal pane snapshots.

**Written (terminal modal only):**
- Operator keystrokes forwarded into the live agent session (Enter/Escape/arrows/Ctrl-combos/plain text). This mutates the running session, not any database.

**Not written by this page:** no records are created, edited, or deleted in any store by the Activity page itself. The poll is pure read; the only write is interactive keystroke forwarding to a live session.

Concepts: an *agent* (name, isMain, running, state, output tail), a *live pane snapshot*, and a *keystroke event*. State enum: working | idle | unknown | error | stopped.

---

## 11) THE OTHER "ACTIVITY" — the Overview recent-events widget (disambiguation; build it on the Overview page, not here)

So Fable 5 does not conflate the two: the Overview/dashboard page hosts a small **"Aktivitás / Activity"** card titled with that word, and *that* one IS a short chronological feed. Build it as part of the Overview spec, not the Activity page. Its behavior:

- **Heading:** HU "Aktivitás" / EN "Activity" (a section card on Overview).
- **Content:** a short list (about the **8 most recent** items), newest-first, merged from two event sources:
  1. **Recent memories** — newest few memory entries written by agents. Each row text reads like **"<agent>: <first ~80 chars of the memory>…"** (truncate with an ellipsis if longer). Icon idea: a "brain/memory" glyph.
  2. **Recent inter-agent messages / delegations** — newest few agent→agent messages. Each row text reads like **"<from> → <to>: <first ~60 chars of the message>…"** (ellipsis if longer). Icon idea: an "arrow/forward" glyph (a right-pointing arrow), signifying delegation.
- **Per-row fields:** a leading **icon** (memory vs delegate), a single-line **title text** (the strings above), and a **relative timestamp** (e.g. "5 perce" / "5m ago") — formatted by a shared relative-time helper.
- **Merge & sort:** combine both sources, sort by timestamp descending, cap at ~8.
- **Empty state:** HU **"Nincs friss esemény."** / EN **"No recent events."**
- **Error state:** HU **"Hiba: <message>"** / EN **"Error: <message>."**
- **Refresh:** it refreshes when the Overview page loads/refreshes (it rides the Overview's data fetch, an endpoint like `GET /api/overview` returning an `activity` array of `{icon, text, at}`); it does **not** self-poll like the Activity page does.
- **No interactivity:** rows are not clickable; there is no filter, search, or "load more." It is a glanceable recent-events strip.

KEEP THESE SEPARATE: the **Activity page** = live per-agent status board + interactive terminals (self-polling every 3s). The **Overview widget** = static-ish recent memories+delegations feed (refreshes with the Overview). Do not merge their data sources or behaviors.

---

## 12) i18n — every string ships HU (default) + EN

Provide both locales; HU is the default. Master list (key → HU / EN):

- nav.activity → "Aktivitás" / "Activity"
- activity.title → "Aktivitás" / "Activity"
- activity.subtitle → "Mit csinál épp minden ügynök — élő nézet, 3 mp-enként frissül" / "What every agent is doing right now — live view, refreshes every 3 seconds"
- activity.updated → "Frissítve: {time}" / "Updated: {time}"
- activity.loading → "Betöltés…" / "Loading…"
- activity.empty → "Nincs ügynök." / "No agents."
- activity.fetchError → "Nem sikerült lekérni az aktivitást: {error}" / "Could not fetch activity: {error}"
- activity.noRecentOutput → "nincs friss kimenet" / "no recent output"
- activity.sessionNotRunning → "a session nem fut" / "the session is not running"
- activity.badge.main → "fő" / "main"
- activity.termIcon.tip → "Terminal megnyitása" / "Open terminal"
- state.working.label / .tip → "dolgozik" / "working"; tip per §4
- state.idle.label / .tip → "várakozik" / "idle"; tip per §4
- state.unknown.label / .tip → "ismeretlen" / "unknown"; tip per §4
- state.error.label / .tip → "hiba" / "error"; tip per §4
- state.stopped.label / .tip → "leállt" / "stopped"; tip per §4
- terminal.titleSuffix → "{name} — Terminál" / "{name} — Terminal"
- terminal.close → "Bezárás" / "Close" (the "×" button's accessible label)
- terminal.streamError → "[stream hiba vagy leállva]" / "[stream error or stopped]"
- (Overview widget, see §11) overview.activity.title → "Aktivitás" / "Activity"; overview.activity.empty → "Nincs friss esemény." / "No recent events."; overview.activity.error → "Hiba: {message}" / "Error: {message}"

---

## 13) ACCEPTANCE CHECKLIST (Fable 5 self-verify)

- [ ] Sidebar shows "Aktivitás/Activity" with a live-signal icon; `#activity` deep-links here.
- [ ] On entry, the page fetches fleet status once and then every ~3s; the "Frissítve/Updated" timestamp updates each success; leaving the page stops the interval; returning restarts it.
- [ ] One card per agent (hub/orchestrator first, marked "fő/main"), each with name, state badge (correct HU/EN label + tooltip for all five states), and a monospace tail of ~8 last output lines (or the correct placeholder).
- [ ] Running cards are clickable (affordance + terminal icon); non-running cards are inert.
- [ ] Clicking a running card opens a Terminal modal titled "<name> — Terminál/Terminal" with a live repainting pane stream and full keyboard input forwarded to the agent (special keys mapped, plain text raw).
- [ ] Closing the modal tears down the stream + terminal; switching agents cleanly replaces the stream.
- [ ] Loading / empty / poll-error states render the exact HU/EN strings; poll self-heals after an error.
- [ ] No destructive actions and no confirmations on this page; stream + keys channels are operator-token authenticated and unreachable unauthenticated.
- [ ] The Overview "Aktivitás/Activity" widget is built separately as a newest-first feed of recent memories + delegations (≤8, relative timestamps, refreshes with Overview, not self-polling) — NOT merged with this page.
- [ ] All strings present in HU (default) + EN; visual look follows `01-design.md`.
