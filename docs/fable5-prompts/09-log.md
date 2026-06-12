# Fable 5 Build Prompt — Log / Napló View

> CLEAN-ROOM NOTICE: This is an original behavioral + visual specification. It describes what the screen looks like, what controls exist, and how they behave — facts and contracts only. It contains no source code, identifiers, file names, or database schema from any prior implementation. Build it fresh. For all visual styling (colors, spacing, typography, shadows, radii, motion), defer to `01-design.md`; this document defines structure and behavior only.

---

## Context for the implementer

There are **two distinct, related surfaces** in this product that both carry the Hungarian word "Napló" (Log/Journal). Build BOTH; they serve different jobs and live in different places.

- **A. The Daily Log tab** — a sub-tab inside the **Memory / Memória** page. It shows one agent's day-by-day journal entries, one day at a time, with prev/next day navigation. This is the "what did this agent do on this day" reader.
- **B. The Recall / Napló page** — a top-level navigation page. It is a cross-agent, cross-date **search-and-timeline** surface that merges daily-log entries AND memory records into one chronological feed, with free-text search, a date picker, a natural-language date expression box, and an agent filter. This is the "find that thing from last week" reader.

Both read the same underlying daily-log data store; B additionally reads the memory store. Neither surface, in this view, is the primary place entries are *written* — entries are written by agents (and an automated nightly digest job) through the API. This view is read-first. See sections 6 and 9.

---

## 1) PURPOSE & WHERE IT LIVES

### A. Daily Log tab (inside Memory page)
- **Purpose:** Read an individual agent's append-only daily journal — the running, timestamped notes an agent writes about its own work during a given calendar day. Lets the operator scroll back through history day by day to reconstruct what a specific agent did.
- **Where it lives:** It is the last tab in the horizontal tab strip on the **Memory / Memória** page (sibling tabs: the memory tiers and a graph view). It is not a separate nav item.
- **Tab label:** HU `Napló` / EN `Log`. **Icon idea:** a clipboard or notebook glyph (clipboard-with-checklist works well and matches the journal metaphor).

### B. Recall / Napló page (top-level nav)
- **Purpose:** Session recall — search and browse across all of the system's daily logs and memories by date, by natural-language time expression, by free text, and by agent. Produces a unified, date-grouped timeline so the operator can answer "what happened around then?" without knowing which agent or which exact day.
- **Where it lives:** A dedicated item in the left sidebar navigation. It appears between the **Memória** (Memory) and **Háttér** (Background tasks) items in the nav order.
- **Nav label:** HU `Napló` / EN `Log`. **Icon idea:** a clock-with-history motif (a circle with clock hands, evoking "look back in time") — distinct from the Memory item's brain icon.
- **Page title (H1):** HU `Napló` / EN `Log`.
- **Page subtitle:** HU `Session recall: napi naplók és emlékek visszakeresése` / EN `Session recall: retrieve daily logs and memories`.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — styling per `01-design.md`)

### A. Daily Log tab
Top to bottom, within the Memory page body (the page header, stats line, search toolbar, and tab strip above it belong to the Memory page and are shared across tabs):

1. **Tab strip** (shared): a row of pill/segmented tabs. The Daily Log tab is the rightmost; selecting it swaps the content region below.
2. **Date navigation bar:** a single horizontal row, centered, with three elements left-to-right:
   - a small icon button to go to the **previous day**,
   - a **current-date label** (long, human-readable, localized — see 3),
   - a small icon button to go to the **next day**.
3. **Entries region:** a vertical, scrollable stack of entry rows for the selected day (see 4A).
4. **Empty state block:** shown only when the selected day has no entries (see 7).

Note: the Memory page's search box, search-mode dropdown, and agent filter dropdown sit *above* the tab strip and remain visible while the Daily Log tab is active. The Daily Log tab consumes the **agent filter** value (which agent's log to show) but ignores the free-text search box and search-mode dropdown (those drive the memory-tier tabs, not this one).

### B. Recall / Napló page
Top to bottom:

1. **Page header:** H1 title + subtitle (strings in 1B).
2. **Toolbar row** (wraps on narrow widths): left-to-right — a free-text search input with a magnifier icon, a native date picker with a calendar icon, a natural-language date-expression text input, an agent filter dropdown, and a primary **Search** button.
3. **Summary bar:** a single compact line summarizing the current result set (date or date range, counts, agents present). Hidden/empty until a search runs.
4. **Timeline region:** a vertical, date-grouped, chronologically sorted feed merging log entries and memory records (see 4B). This is the main scroll area.

---

## 3) CONTROLS — every field, button, dropdown, toggle, filter, tab

### A. Daily Log tab controls

| Control | HU label | EN label | Type | Behavior |
|---|---|---|---|---|
| Daily Log tab | `Napló` | `Log` | Tab (in shared strip) | Activates the daily-log content region; hides the tier/graph regions; triggers a load of the current agent + current day. |
| Previous-day button | tooltip `Előző nap` | tooltip `Previous day` | Icon button (`<` chevron) | Moves the selected date back one calendar day and reloads entries. No lower bound. |
| Next-day button | tooltip `Következő nap` | tooltip `Next day` | Icon button (`>` chevron) | Moves the selected date forward one calendar day and reloads entries. No upper bound (you can navigate into the future; it will simply be empty). |
| Current-date label | — | — | Read-only text | Displays the selected day formatted long-form and localized, e.g. HU `2026. június 7., szombat`; EN equivalent `Saturday, June 7, 2026`. Includes year, full month name, day number, and weekday name. |
| Agent filter (shared from Memory page) | placeholder option `Minden ügynök` | `All agents` | Dropdown | Chooses which agent's log to display. Options are populated from the live agent roster (each option shows the agent's display label, value is the agent's identifier). The `All agents` (empty) option behaves as "fall back to the first/main agent" for this tab — the daily-log reader always needs exactly one agent, so empty resolves to the first real agent in the list rather than showing nothing. Changing the agent reloads the log for the currently selected day. |

### B. Recall / Napló page controls

| Control | HU label / placeholder | EN label / placeholder | Type | Behavior |
|---|---|---|---|---|
| Free-text search | placeholder `Keresés a napló szövegében...` | `Search the log text...` | Text input (with magnifier icon) | Free-text query matched against entry/memory content (and memory keywords). Pressing Enter runs the search. |
| Date picker | — | — | Native date input (with calendar icon) | Pick a single exact day. Used when the expression box is empty. Defaults on first open to "today" in the system's local timezone. |
| Date-expression box | placeholder `pl. tegnap, múlt héten...` | `e.g. yesterday, last week...` | Text input | Accepts a natural-language time expression (HU-first, also accepts ISO dates and ISO date ranges). When non-empty, it OVERRIDES the date picker. Pressing Enter runs the search. Supported expressions are listed in section 6B. |
| Agent filter | first option `Minden ágens` | `All agents` | Dropdown | Restricts results to one agent, or all. Options are the agent roster (value + display = agent identifier). Changing it re-fetches the per-agent "days that have logs" hint (see 7) but does not auto-run the search — the user still presses Search or Enter. |
| Search button | `Keresés` | `Search` | Primary button | Runs the recall query with the current toolbar state. |

Interaction precedence on the Recall page: if the **expression box** has text, it wins and defines the date/range. Else if the **date picker** has a value, that single day is used. The **free-text search** is an additional filter applied on top in both cases. With free text present but no date at all, the search becomes a pure text search across recent logs+memories (no date constraint). See 6B.

---

## 4) LISTS / CARDS / TABLES — items and exact fields

### A. Daily Log tab — entry rows
The entries region renders the selected agent's entries for the selected day, **oldest first (ascending by time)**. Each entry is a simple two-part row (no card chrome, no per-item menu):

- **Time** — the entry's creation time, hour:minute, 24-hour, localized (e.g. `14:32`). Displayed as a small leading/label element.
- **Content** — the entry's full text body, rendered as plain text (HTML-escaped; the source text is treated as untrusted and must never be injected as markup). Entry content is typically a short markdown-flavored note an agent wrote (often a `## HH:MM — Topic` heading followed by a line or two), but in this reader it is shown as escaped text, not rendered markdown.

There are **no per-entry actions** in this view (no edit, no delete, no menu). The daily log is append-only and read-only from here.

### B. Recall / Napló page — timeline items
The timeline merges two item kinds into one list, sorted **ascending by timestamp**, and inserts a **date-group header** whenever the date changes while iterating.

- **Date-group header:** the ISO date string (`YYYY-MM-DD`) for the group that follows.

**Log item** (a daily-log entry):
- a **timestamp label** — full localized date+time of when the entry was created;
- an **agent badge** — the agent identifier that owns the entry;
- the **content** — full entry text, escaped.

**Memory item** (a memory record):
- a **timestamp label** — full localized date+time of creation;
- a **category badge** — the memory's tier/category (e.g. hot/warm/cold/shared); the badge is visually keyed to the category;
- an **agent badge** — the owning agent identifier;
- the **content** — full memory text, escaped;
- a **keywords line** — shown only if the memory has keywords, prefixed HU `Kulcsszavak:` / EN `Keywords:`.

The two kinds are visually distinguishable (a log item vs. a memory item), but both are inline blocks in the same chronological column. There are **no per-item actions/menus** on the Recall timeline — it is a read-only feed.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

**There are no modals, detail panes, drawers, or pop-out cards in either Log surface.** Entries and timeline items are fully rendered inline; clicking an entry opens nothing. Do not build a detail modal for this view. (Adding/editing memories is handled by the Memory page's own add/edit modal, which is out of scope for this spec — the Log surfaces never open it.)

If you want to offer a "copy entry text" affordance, that is an acceptable original enhancement, but it is not part of the required spec.

---

## 6) FLOWS & BEHAVIOR (behavior/contract, not code)

### A. Daily Log tab flows

1. **Opening the tab.**
   - The agent roster is fetched (if not already loaded) to populate the agent filter.
   - The current selected day defaults to **today** (local date) on first load and persists as the user navigates.
   - The reader resolves the target agent: the agent filter value, or — if `All agents` (empty) is selected — the first real agent in the dropdown.
   - It fetches the **list of days that have entries** for that agent (used for hints/affordances; the reader does not hard-restrict navigation to these days).
   - It updates the current-date label.
   - It fetches **the entries for that agent on that day** and renders them oldest-first. If the request fails, it renders as empty (no entries) rather than erroring loudly.

2. **Previous / Next day.** Shifts the selected date by one day and re-runs the entries fetch + label update. Future dates are allowed (they just come back empty).

3. **Changing the agent.** Re-runs the full load for the new agent on the currently selected day.

4. **API contract (read):**
   - `GET` the entries for an agent on a date: query params `agent` (agent id) and `date` (`YYYY-MM-DD`). Returns an array of entries, each `{ id, content, created_at }`, ordered oldest-first. Defaults: missing `agent` → the main agent; missing `date` → today.
   - `GET` the list of dates with entries for an agent: query param `agent`. Returns an array of `YYYY-MM-DD` strings, most-recent first (capped — see 7).

5. **Adding an entry (write contract; not exposed as a button in this view).** An entry is created by `POST`ing `{ agent_id, content }`. Rules: `content` is required and trimmed; empty/whitespace-only content is rejected with a 400 and a `Content required` message. The server stamps it with the current local date and current time and stores it append-only. If `agent_id` is omitted, it defaults to the main agent. The convention agents follow is a short markdown note like `## HH:MM — Topic` + a line of what happened/result. This is how the automated digest and the agents populate the log.

### B. Recall / Napló page flows

1. **Opening the page.**
   - On first open: set the date picker to **today in the system's local timezone** (compute the local calendar date explicitly so a late-night UTC offset doesn't roll the picker back a day); populate the agent dropdown from the roster; wire Enter-to-search on the search box and the expression box, and re-fetch date hints when the agent changes; fetch the per-agent "days with logs" hint; then immediately run an initial search (defaulting to today).
   - On subsequent opens: just re-run the current search.

2. **Running a search (Search button or Enter in either text box).**
   - Build the query from the toolbar: expression box (if any) → else date picker (if any) provides the date/range; free-text search adds a content filter; agent filter narrows to one agent.
   - Show a loading line in the timeline; clear the summary.
   - On success: render the summary bar and the merged, date-grouped timeline.
   - On a 4xx (e.g. unparseable expression): render the server's error message inline in the timeline area.
   - On a network failure: render a generic "could not load" message inline.

3. **Search semantics (contract):**
   - **Text-only, no date:** pure search across recent logs + memories (memory side uses full-text matching with a LIKE fallback; logs use substring matching). Returns most-recent-first within the store, then the UI re-sorts ascending for display.
   - **Date or range (with optional text):** fetch all logs and memories whose timestamp falls within the resolved day/range (memories of the `shared` category are included even when filtering by a specific agent), then if text is present, additionally filter both lists to items whose content (or memory keywords) contains the text.
   - Result limit is bounded (default ~50, capped at a few hundred).

4. **Natural-language date expressions** (HU-first; accent-insensitive). The expression box understands at least:
   - exact ISO date `YYYY-MM-DD`; ISO range `YYYY-MM-DD - YYYY-MM-DD`;
   - HU `ma` / EN `today`; HU `tegnap` / EN `yesterday`; HU `tegnapelőtt` (day before yesterday);
   - HU weekday names (`hétfő`, `kedd`, ... `vasárnap`), optionally prefixed with `múlt`/`előző` ("last"), resolving to the most recent occurrence of that weekday;
   - "N days ago" (HU `N napja` / `N nappal ezelőtt`); "N weeks ago" (HU `N hete` / `N héttel ezelőtt`, resolving to that week);
   - HU `ezen a héten` / EN `this week`; HU `múlt héten` / EN `last week`;
   - HU `ebben a hónapban` / EN `this month`; HU `múlt hónapban` / EN `last month`;
   - HU `utolsó N nap` / `elmúlt N nap` ("last N days");
   - HU month names + day (e.g. `június 7`), month names alone (whole month), and "month + ordinal week" (e.g. `június első hét`).
   - All date math resolves in the system's configured local timezone (Central European, Budapest), not raw UTC, to avoid off-by-one-day errors near midnight.

5. **API contract (read):**
   - `GET` recall: query params `date` (an expression or ISO date/range), `q` (free text), `agent` (id), `limit`. Returns `{ dateRange: {from,to}, logs: [...], memories: [...], summary: { logCount, memoryCount, agents: [...] } }`. Log and memory items carry a pre-formatted localized `created_label`. Unparseable `date` → 400 with `Nem értelmezhető dátum: "..."` (EN: `Unrecognized date: "..."`).
   - `GET` recall date hints: query params `agent`, `limit` (capped ~365). Returns the list of `YYYY-MM-DD` days that have logs for that agent. Used to (a) pre-fill the date picker if it's empty, and (b) set a tooltip on the picker like HU `N nap naplóval` / EN `N days with logs`.

6. **Confirmations / destructive actions:** none in either Log surface. Nothing here deletes or mutates data, so no confirmation dialogs are required.

### C. The Daily Digest (automated, behind the scenes — affects what appears here)
There is a nightly automated job (around 23:00 local) that produces one **daily digest** entry. Behavior to replicate at the concept level:
- It gathers the day's recent episodic memories for the main conversation.
- If there are none, it does nothing (skips silently).
- Otherwise it asks the orchestrator agent to write a terse Hungarian summary (≈5–8 sentences) capturing: (1) what tasks were worked on, (2) what important decisions were made, (3) what's still open / the next step.
- The agent **saves that summary into its own daily log** via the same append API (as the main agent), and the digest is **silent** — it does not send a chat/Telegram message; it is a quiet background task.
- Net effect on this view: each day typically gains a digest entry in the main agent's daily log, visible in both the Daily Log tab and the Recall timeline. There is a configuration off-switch to disable the auto-digest entirely.

Build the digest as a scheduled server job that writes through the same append-entry path; do not build any digest-trigger UI in this view (it is not operator-facing here).

---

## 7) STATES — empty / loading / error / permission / live-update

### A. Daily Log tab
- **Empty (a day with no entries):** hide the entries list and show an empty block with HU `Nincs naplóbejegyzés ezen a napon` / EN `No log entries on this day`.
- **Loading:** loads are fast and the tab does not show an explicit spinner; the entries region is simply rebuilt on each load. (Optional original enhancement: a brief skeleton/placeholder.)
- **Error:** if either fetch fails, the view degrades to the empty state (no loud error). Keep this forgiving behavior.
- **No agent resolvable** (roster empty): render the empty state.
- **Live update:** none — the tab does not poll. It refreshes on tab open, on day navigation, and on agent change.

### B. Recall / Napló page
- **Loading:** while a search is in flight, the timeline shows a loading line HU `Betöltés...` / EN `Loading...` and the summary is cleared.
- **Empty (search ran, no matches):** timeline shows HU `Nincs találat erre az időszakra.` / EN `No results for this period.`
- **Error (4xx):** show the server's message inline (e.g. the unparseable-date message). 
- **Error (network):** show HU `Nem sikerült betölteni` / EN `Could not load` inline.
- **Summary bar (success):** one line combining: the date or `from – to` range (bold), `{n} naplóbejegyzés` / `{n} log entries`, `{n} emlék` / `{n} memories`, and if any agents present, `Ágensek: a, b, c` / `Agents: a, b, c`.
- **Live update:** none — no polling. Results refresh only when the user searches.
- **Date-hint tooltip:** the date picker carries a tooltip showing how many days have logs for the selected agent.

---

## 8) PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- **Both Log surfaces are operator-facing UI** served by the single-user dashboard. The entire dashboard (every `/api/*` call it makes) is gated behind a single bearer token; there is no multi-user role system inside the UI. So in practice: the operator who can open the dashboard sees everything (all agents' logs, all memories within date scope).
- **Agents do not browse these views.** Agents interact with the same data only through the API: they **write** their own daily-log entries (and read via API when reconstructing context). The convention is that each agent writes to its own `agent_id` log; nothing in the UI prevents the operator from viewing any agent's log.
- **No per-field permission masking** in this view. The memory side of Recall respects the data model's sharing rule (a `shared`-category memory is visible alongside a specific agent's own memories when filtering by that agent), but that is a data-scoping rule, not a UI permission.
- **Autonomy gating** does not restrict reading these views. Autonomy levels govern whether agents *proactively escalate/act*; they do not hide the Log UI. (The digest job's existence can be toggled off via config, which is the only autonomy-adjacent control touching this data — and it is not surfaced in this view.)

---

## 9) DATA CONCEPTS read/written (concept level)

- **Daily-log entry** (the core concept of this view): `{ id, agent_id, date (YYYY-MM-DD), content (text), created_at (unix seconds) }`. Append-only. Grouped by `(agent_id, date)`. Indexed for fast per-agent/per-day lookup. Written by agents and the digest job; read by both Log surfaces.
- **Day index:** the distinct set of dates that have any entry for a given agent (most-recent-first, capped). Drives day-navigation hints and the Recall date-picker default + tooltip.
- **Memory record** (read only by the Recall page, never written here): `{ id, agent_id, content, category/tier (hot|warm|cold|shared), keywords, created_at, ... }`. The Recall timeline merges these with log entries; the Daily Log tab does not touch memories.
- **Recall result envelope:** `{ dateRange:{from,to}, logs:[...], memories:[...], summary:{logCount, memoryCount, agents:[]} }` with localized `created_label` precomputed per item.
- **Agent roster:** `{ name/id, label }` list used to populate the agent filters in both surfaces.

Write path summary (the only writes anywhere near this view): append a daily-log entry (`agent_id` optional → defaults to main agent; `content` required, trimmed, non-empty; server stamps date+time). No update or delete path exists for entries — treat the log as immutable history.

---

## 10) i18n — all strings ship HU (default) + EN

Default language is Hungarian. Provide an English string for each. Required strings:

| Key | HU (default) | EN |
|---|---|---|
| Daily Log tab label | `Napló` | `Log` |
| Prev day tooltip | `Előző nap` | `Previous day` |
| Next day tooltip | `Következő nap` | `Next day` |
| Daily Log empty | `Nincs naplóbejegyzés ezen a napon` | `No log entries on this day` |
| Nav item / Recall page title | `Napló` | `Log` |
| Recall subtitle | `Session recall: napi naplók és emlékek visszakeresése` | `Session recall: retrieve daily logs and memories` |
| Recall search placeholder | `Keresés a napló szövegében...` | `Search the log text...` |
| Recall expression placeholder | `pl. tegnap, múlt héten...` | `e.g. yesterday, last week...` |
| Recall agent filter "all" | `Minden ágens` | `All agents` |
| Memory agent filter "all" (shared) | `Minden ügynök` | `All agents` |
| Search button | `Keresés` | `Search` |
| Recall loading | `Betöltés...` | `Loading...` |
| Recall empty | `Nincs találat erre az időszakra.` | `No results for this period.` |
| Recall network error | `Nem sikerült betölteni` | `Could not load` |
| Recall generic error | `Hiba történt` | `An error occurred` |
| Unparseable date error | `Nem értelmezhető dátum: "{x}"` | `Unrecognized date: "{x}"` |
| Summary: log count | `{n} naplóbejegyzés` | `{n} log entries` |
| Summary: memory count | `{n} emlék` | `{n} memories` |
| Summary: agents prefix | `Ágensek: {list}` | `Agents: {list}` |
| Memory keywords prefix | `Kulcsszavak:` | `Keywords:` |
| Date-picker tooltip | `{n} nap naplóval` | `{n} days with logs` |
| Append API: content required | `Tartalom kötelező` | `Content required` |

Date formatting: the current-day label uses a long localized format with weekday, full month, day, and year. Entry times use 24-hour `HH:MM`. The Recall timeline date headers use ISO `YYYY-MM-DD`. All date math (expressions, "today" defaults) resolves in Central European (Budapest) local time, not UTC.

---

### Build order suggestion
1. Daily Log tab (read-only, single-agent, day navigator) — smallest, self-contained.
2. The append-entry API + the nightly digest job (so the log actually fills).
3. The Recall / Napló page (search, expression parser, merged timeline).
4. Wire both agent filters to the live roster; defer all visuals to `01-design.md`.
