# CITADEL — Overview (Áttekintés) View — Fable 5 Build Prompt

> **Clean-room notice (read first).** You are building this view from a behavioral + visual specification only. You have never seen the original product's source. Implement it originally: invent your own component names, file layout, data-access code, CSS class names and HTTP handler code. Do NOT ask for or reproduce any original source code, identifiers, file names, SQL, or schema. This document describes *what the screen looks like and does* — appearance, regions, controls, fields, flows, states — not how it was coded. For all visual styling (colors, type scale, spacing tokens, card chrome, glow, themes, density) defer to the design system in **01-design.md**; this document only fixes *structure and behavior*.

---

## 1) PURPOSE & WHERE IT LIVES

**What it is.** The Overview is the application's **landing page** — the first screen shown when the dashboard opens (it is the default/home route). It is a single-screen "command bridge" summary of the whole agent fleet: a few headline metrics at the top, a live picture of the team and its hierarchy, and a feed of the most recent things that happened. It is read-only at a glance; the operator navigates *out* of it (into deeper pages or detail modals) rather than doing heavy work *in* it.

**Where it lives.** It is the **first item** in the left navigation sidebar.

- **Nav label:** `Áttekintés` (HU, default) / `Overview` (EN).
- **Nav icon idea:** a 2×2 grid of four equal rounded squares (a "dashboard / tiles" glyph). Line-style icon consistent with the rest of the nav.
- It is the active nav item on first load.

**One-line subtitle / intent text** (use as a page sub-header or tooltip; ship both languages):
- HU: `A teljes ügynökcsapat élő pillanatképe — metrikák, felállás és friss események.`
- EN: `A live snapshot of the whole agent fleet — metrics, line-up, and recent activity.`

(The original renders no large page title bar of its own; the nav label *is* the page's identity. If 01-design.md prescribes a per-page header, use the label + subtitle above. Otherwise the page may open straight into the stat row.)

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — styling per 01-design.md)

Top to bottom, two stacked regions inside the main content area:

**Region A — STAT ROW (headline metrics).**
- A single horizontal row of **four equal stat cards**, evenly distributed across the full content width.
- Order, left → right: (1) Active agents, (2) Tasks run today, (3) Memory, (4) Generated skills.
- Each stat card is a compact panel containing three stacked text lines: a small **label** (top), a large **value** number (middle, the visual focal point), and a small muted **sub-line** (bottom) for context/delta.
- On narrow/mobile widths the four cards reflow (wrap to 2×2, then stacked). Defer exact breakpoints/grid to 01-design.md; the *intent* is "four tiles that gracefully wrap."

**Region B — CONTENT GRID (three panels).**
- Below the stat row, a grid of **three cards**. On wide screens they sit side by side (the team card is the wide/featured one; the two others are narrower). On narrow screens they stack vertically. Defer the column proportions to 01-design.md.
- Each card has a small **card header** with a left-aligned **title** and an optional right-aligned **muted meta caption**.
- The three cards, in order:
  1. **Team constellation card** — header title `Csapat` / `Team`, meta caption `élő állapot` / `live status`. Body: the team graph (hub + specialist avatars, see §4).
  2. **Activity feed card** — header title `Aktivitás` / `Activity`. Body: a vertical list of recent-event rows (see §4).
  3. **Agent-activity widget card** — header title `Ügynök aktivitás` / `Agent activity`, meta caption `mai üzenetek` / `today's messages`. Body: a placeholder region reserved for a small per-agent message-count widget (see §4 — in the reference build this body is an empty reserved container; treat it as a stub you may leave empty or fill, see §7).

No filters, search, tabs, or toolbars exist on this page. It is a passive dashboard.

---

## 3) CONTROLS

This page is deliberately control-light. There are **no** text fields, dropdowns, toggles, filters, search boxes, or tabs on the Overview itself. The only interactive elements are:

| Control | HU label | EN label | What it does |
|---|---|---|---|
| Team node (avatar tile) — non-hub | (the agent's display name) | (same) | Clicking a specialist/sub-agent node opens that agent's **detail modal** (see §5.1). The hub node is **not** clickable. |
| Activity row | (the event text) | (same) | Non-interactive in the reference build (rows display info only; no click target). |
| Stat card | (the metric) | (same) | Non-interactive (display only). |

All other "controls" the user reaches from here are global chrome owned by other specs: the left nav links, the theme toggle, and the appearance/"Tweaks" panel button in the sidebar footer. Those belong to the shell, not to this view — do not re-implement them here.

---

## 4) LISTS / CARDS / TABLES — exact fields per item

### 4.1 Stat cards (four)

Each card = label / value / sub-line. The value is fetched from the overview metrics endpoint; the sub-line is computed text.

1. **Active agents** — `Aktív ügynökök` / `Active agents`
   - **Value:** number of agents currently *running* (the hub is always counted as running, plus every sub-agent whose process/session is live).
   - **Sub-line:** `{total} összesen` / `{total} total` — total = all agents in the roster including the hub.

2. **Tasks run today** — `Ma futott feladat` / `Tasks run today`
   - **Value:** count of "tasks" executed since local midnight. A "task" = scheduled-task runs that fired today **plus** real operator/user conversation turns today (genuine human prompts only — tool results and system/synthetic events are excluded so a tool-heavy hour does not inflate the number).
   - **Sub-line (delta vs yesterday):** compute `today − yesterday`.
     - If equal: `ugyanaz mint tegnap` / `same as yesterday`.
     - If higher: `+{n} a tegnapihoz` / `+{n} vs yesterday`.
     - If lower: `{n} a tegnapihoz` / `{n} vs yesterday` (n already negative).

3. **Memory** — `Memória` / `Memory`
   - **Value:** total count of stored memory entries, formatted with a thin-space thousands separator (Hungarian grouping, e.g. `12 480`).
   - **Sub-line:** `bejegyzés · {categories} kategória` / `entries · {categories} categories` — categories = number of distinct memory categories.

4. **Generated skills** — `Generált skillek` / `Generated skills`
   - **Value:** total count of installed skills (each skill = a skill folder containing a skill definition file).
   - **Sub-line:** if any skill was created/modified today, show `ebből {n} ma` / `{n} of them today`; otherwise the sub-line is empty.

Before data arrives every value shows a placeholder dash (`—`) and the sub-lines are blank.

### 4.2 Team constellation (the `Csapat` card body)

A compact rendering of the **same hierarchy graph** the dedicated Team page shows — reused here so the Overview and Team page never disagree.

Structure: a **top-down tree** laid out in horizontal *levels* connected by vertical connectors:
- **Level 0:** the single **hub** node, visually featured (it is the orchestrator; give it the "main/hub" emphasis treatment from 01-design.md — e.g. a distinct ring/accent).
- **Level 1+:** one row per tier of the reports-to tree. Each agent appears once. Agents that report to the hub sit on level 1; an agent that reports to a team-leader sits one level below that leader. Any unreachable/orphan node falls into a trailing level.
- Between consecutive levels, a thin **connector** element (a vertical line/spine) is drawn.

Each **team node** (avatar tile) shows, stacked:
- **Avatar.** Image precedence: operator-uploaded avatar → the agent's built-in base portrait/glyph → a single-letter monogram disc (first letter of the name, uppercased) as last resort. The hub always resolves an avatar (operator upload or the hub's portrait fallback). If an avatar image fails to load, it hides and the monogram/fallback shows.
- **Name** — the agent's display name.
- **Role line** — one of: `főügynök` / `hub` (the orchestrator), `csapatvezető` / `team leader`, or `beosztott` / `member`.
- **Running line** — `● Fut` / `● Running` when its process is live, or `○ Leállva` / `○ Stopped` when not. Use a filled vs hollow dot to distinguish.

Per-node action: clicking any node **except the hub** opens that agent's detail modal (§5.1). The hub node has no click action.

If there is only the hub and no sub-agents, the card body shows an inline empty note: `Nincs sub-agent létrehozva.` / `No sub-agents created.`
While loading it shows `Betöltés...` / `Loading...`; on fetch failure it shows `Hiba: {message}` / `Error: {message}`.

### 4.3 Activity feed (the `Aktivitás` card body)

A vertical list of up to **8 recent events**, newest first, merged from two sources and sorted by timestamp descending:

- **Memory events** (the most recent stored memories): row text = `{agent}: {memory content}`, with the memory content truncated to ~80 characters and an ellipsis (`…`) appended if longer.
- **Delegation/message events** (the most recent inter-agent messages): row text = `{from-agent} → {to-agent}: {message content}`, content truncated to ~60 characters with `…` if longer.

Each activity row shows:
- **Leading icon** — two icon variants by event type: a **right-arrow** glyph for delegation/message events, and a **memory/brain** glyph for memory events.
- **Title line** — the event text described above.
- **Time line** — a compact **relative timestamp**: `most` / `now` (< 1 min), `{n}p` / `{n}m` (minutes), `{n}ó` / `{n}h` (hours), `{n}n` / `{n}d` (days).

Empty state (no events): `Nincs friss esemény.` / `No recent activity.`
Error state: `Hiba: {message}` / `Error: {message}` in muted text.

### 4.4 Agent-activity widget (the `Ügynök aktivitás` card body)

A reserved panel captioned `mai üzenetek` / `today's messages`, intended to surface a small per-agent count of today's messages. In the reference build this body is an **empty placeholder container** (no content is rendered into it on the Overview). Treat it as an optional stub: you may either leave it empty (matching the reference) or, if you want parity with the caption, populate it with a minimal per-agent "messages today" tally. Do not invent heavy functionality here — the headline data already lives in the stat row and the activity feed.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

The Overview itself opens **no modal of its own**. The only modal reachable from this page is the **agent detail modal**, opened by clicking a team node. It is a shared, full-featured modal owned by the Agents view; from the Overview's perspective only its *entry point* matters, but for completeness here is what it contains.

### 5.1 Agent detail modal (opened from a team node)

A large centered modal with a header (the agent's display name + a close control) and a tabbed body. Tabs (HU/EN):

- **Áttekintés / Overview** — the default tab. Shows: the agent's large avatar (same precedence as §4.2, framed if it has an image/portrait, else a gradient monogram disc tinted by the agent's accent color); the display name; the description text; the active model name (or `inherit` / inherited); and a **channel connection status** chip reading `Csatlakozva` / `Connected` (with a connected dot) or `Nincs bekötve` / `Not linked` (disconnected dot).
- **Beállítások / Settings** — editable config: a **model** dropdown (Claude models plus any local/alternate models discovered), a **security profile** dropdown with a description line, a **team editor** (role + reports-to + delegates-to relationships), an **auth-mode** selector (shared subscription auth vs. per-agent key state), and large multi-line editors for the agent's instruction doc, its persona doc, and its connector/MCP config. (For the alternate "add an API key" affordance, the spec links to a separate Vault page.)
- **Csatorna / Channel** (messaging) — channel/bot binding state and controls. Note: the bot only receives while the agent is running; if stopped, the modal advises starting it from the agent's process controls.
- **Skillek / Skills** — the skills available to that agent (skills are shared fleet-wide via a common home, so they appear automatically; the per-skill detail is read-only: source, path, and the skill document body).

Modal footer / actions:
- **Process control** (start / stop the agent) appropriate to its current running state.
- **Törlés / Delete** button (hidden for the hub). Clicking asks for confirmation: `Biztosan törlöd: {name}?` / `Delete {name} — are you sure?`. On confirm it deletes the agent, closes the modal, shows a toast `Ügynök törölve` / `Agent deleted`, and refreshes the agent list.
- A **close** control (header ✕, click-outside the modal, and Esc all dismiss it).
- For the hub specifically, the Settings tab is shown read-only and a hub-only "restart channels" control is exposed instead of generic process controls; Delete is hidden.

The agent detail modal is fully specified in the Agents view spec — implement the entry point here and the rest there.

### 5.2 Terminal modal (note for parity)

On the dedicated **Activity** page, clicking a *running* agent's live-status card opens a **terminal modal** (a live, read/write stream of that agent's session pane, titled `{name} — Terminal`). This is **not** wired on the Overview page in the reference build — the Overview's activity feed rows are not clickable. Mentioned only so you don't accidentally cross-wire the two. Do not add terminal-open behavior to the Overview.

---

## 6) FLOWS & BEHAVIOR (behavior/contract level — not code)

**On page open / navigation to Overview:**
1. The view requests the **overview metrics bundle** (one call) which returns: agent counts (running, total), today's and yesterday's task counts, memory count + category count, skill count + skills-created-today count, the team roster (id, label, role, running flag, has-avatar flag, avatar URL), and the merged recent-activity list (already capped at ~8). The view fills the four stat cards and renders the activity feed from this.
2. Independently, the view requests the **team hierarchy graph** (nodes + edges + which id is the hub) and renders the team constellation from it. (The constellation deliberately uses the richer graph endpoint rather than the flat roster in the metrics bundle, so it matches the Team page exactly.)
3. The agent-activity widget container is present but, in the reference, left empty.

**Clicking a team node (non-hub):** fetches that single agent's full record and opens the agent detail modal (§5.1) on its Overview tab. The hub node ignores clicks.

**Delete agent (inside the detail modal):** confirm → delete → close modal → toast → refresh. This is the only destructive action reachable (indirectly) from this page; it is gated behind an explicit confirmation dialog. There are no other destructive/irreversible actions on the Overview.

**No polling on the Overview.** The reference Overview loads its data **once** each time the page is shown (it re-runs the full load whenever the user navigates to the Overview tab) and does **not** auto-refresh on a timer while sitting on the page. (The dedicated **Activity** page is the one with the 3-second live poll; the Overview borrows that page's renderers conceptually but not its polling.) If you want the headline to feel live you may add a gentle periodic refresh, but the baseline behavior is "refresh on (re)entry."

**Relative times** are computed client-side from event timestamps and the current clock; they are not re-ticked live (they refresh whenever the page reloads its data).

---

## 7) STATES

- **Loading.** Stat values show `—`; sub-lines blank. The team card shows `Betöltés...` / `Loading...`. The activity card may briefly show nothing until the bundle resolves.
- **Empty.**
  - No sub-agents: team card body shows `Nincs sub-agent létrehozva.` / `No sub-agents created.` (the hub still renders).
  - No recent events: activity card shows `Nincs friss esemény.` / `No recent activity.`
  - Agent-activity widget: empty container (no content) by default.
- **Error.**
  - Metrics/activity fetch fails: the activity card shows `Hiba: {message}` / `Error: {message}` in muted text; stat cards remain at their last/placeholder values.
  - Team graph fetch fails: team card shows `Hiba: {message}` / `Error: {message}`.
- **Permission denied / unauthenticated.** The whole dashboard sits behind a bearer-token gate (and an external access layer). An unauthenticated client never reaches the rendered page; there is no per-widget "access denied" state on the Overview itself.
- **Live-update / poll.** None on the Overview baseline (data refreshes on page (re)entry). Contrast with the Activity page's 3s poll, which is out of scope here.

---

## 8) PERMISSIONS / VISIBILITY

- The Overview is **operator-facing**. The dashboard is single-user; everything on the Overview is visible to the authenticated operator. There is no agent-vs-operator field hiding on this page.
- **Hub is privileged and special-cased visually:** it is always counted as running, always resolves an avatar, is the featured node, is labeled `főügynök` / `hub`, and is **not** clickable into a deletable detail (its detail is read-only and it cannot be deleted).
- **Autonomy gating** does not change anything *displayed* on the Overview directly. (It governs how proactive the fleet is elsewhere — e.g. whether teammates escalate ideas to the operator. The Overview merely reflects the resulting activity/metrics.) Do not add autonomy controls to this page.
- The **Delete agent** action (reached via a node → detail modal) is operator-only and confirmation-gated; agents cannot delete agents from here.

---

## 9) DATA CONCEPTS (concept level — invent your own storage)

The Overview **reads** the following concepts (it writes nothing of its own; the one indirect write is "delete agent" via the modal):

- **Agent roster & running state** — each agent has an id, a display name, a role (hub / leader / member), a reports-to relationship and delegates-to relationships, a security profile, a running flag, and whether it has an operator-uploaded avatar. The hub is a fixed singleton.
- **Task activity** — scheduled-task run records (with timestamps, to count "today" vs "yesterday") and genuine operator/user conversation turns (filtered to exclude tool results and system/synthetic events).
- **Memories** — stored memory entries, each with content, an owning agent, a category, and a created-at timestamp; the view needs a total count, a distinct-category count, and the most recent few.
- **Inter-agent messages** — message records with from-agent, to-agent, content, and timestamp; the view needs the most recent few for the delegation events in the feed.
- **Skills** — installed skill units (folder + definition file); the view needs a total count and how many were created/modified today.

**Endpoint contracts the view depends on (describe by behavior; implement your own):**
- A **metrics-bundle** endpoint returning the aggregated numbers + roster + capped activity list described in §6 step 1.
- A **team-graph** endpoint returning hierarchy nodes (id, label, role, running, has-avatar) + reports-to edges + the hub id.
- A **single-agent** endpoint (id → full record) used by the detail-modal entry point.
- **Avatar** endpoints for the hub and for each agent (image bytes), used by the node avatars with the fallback precedence in §4.2.

---

## 10) i18n

Every user-visible string ships in **Hungarian (default)** and **English**. The strings to translate on this view: the nav label and subtitle; the four stat-card labels and their dynamic sub-lines (including the three delta phrasings, the memory "entries · N categories" line, and the "N of them today" line); the three content-card titles and their meta captions; the role labels (`főügynök`/`csapatvezető`/`beosztott`); the running indicators (`Fut`/`Leállva`); the relative-time suffixes (`most`/`p`/`ó`/`n`); and all empty/loading/error notices. Number formatting follows the active locale (HU uses a space-grouped thousands separator). Keep the translation keys structured so a single language switch flips the whole view.
