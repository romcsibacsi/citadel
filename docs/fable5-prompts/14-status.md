# Fable 5 Build Prompt — Status (Státusz) View

> CLEAN-ROOM NOTICE: This is an original behavioral + visual specification written for an engineer ("Fable 5") who has never seen the reference product. It describes WHAT the screen looks like and HOW it behaves — appearance, controls, fields, flows, states — NOT how any existing code is written. Do not ask for or reproduce source code, identifiers, filenames, or database schemas from any prior implementation. Implement everything originally. For all visual styling (color tokens, spacing, typography, card/elevation treatment, dark/light theming), defer to `01-design.md`; this document specifies structure and behavior only.

---

## 0) Scope of this document

This "Status" area is actually **two sibling pages plus one background facility**, all concerned with operational health and accounting:

1. **Status (Státusz)** — the live health board for the upstream AI provider (the LLM service the agents run on). External service-state readout.
2. **Token Monitor (Token Monitor)** — usage accounting: how many tokens each agent/model burned over time, with budget-window tracking. THIS IS NOT MONEY. See the billing-context note below.
3. **Tool-Call Log (Eszközhívás-napló)** — a backend ingestion + query facility for per-agent tool invocations, used for workflow analysis. It has no first-class screen in the reference; it is specified here as an API contract and an optional panel you MAY surface.

> **BILLING CONTEXT — read this first.** The whole product runs on a flat-rate **subscription** to the AI provider (a fixed monthly seat, with rolling rate-limit windows), **not** metered pay-per-token API billing. Therefore the Token Monitor must **never** show dollars, cost, "spend", invoices, or a price multiplier. It is **usage accounting against rate-limit budgets**, expressed purely in **token counts** and **call counts**, plus how close the current rolling window is to its reset. Frame every label as "usage/consumption/budget window", never "cost". Reset boundaries (rolling 5-hour session window, daily, weekly) are first-class concepts because they are what actually limits the operator, not money.

---

## 1) PURPOSE & WHERE IT LIVES

### 1a. Status (Státusz)
- **Purpose:** A one-glance answer to "is the upstream AI provider healthy right now, and have there been recent incidents?" The operator opens this when agents act slow/flaky to rule out a provider outage before debugging locally.
- **Nav item:** Left sidebar entry labeled **"Státusz" / "Status"**.
- **Icon idea:** A heartbeat / pulse-line (an EKG zig-zag polyline). Conveys "service health/pulse".
- **Subtitle (under the H1):**
  - HU (default): "Claude szolgáltatások állapota"
  - EN: "Claude service status"

### 1b. Token Monitor (Token Monitor)
- **Purpose:** Track raw token consumption per agent and per session over time, see when the peak windows are, which tasks were heaviest, and how close the rolling rate-limit windows are to their caps. Pure usage accounting against the subscription's rate-limit windows.
- **Nav item:** Either its own sidebar entry **"Token Monitor"** (same label HU/EN) or a tab/segment reachable from the Status area. In the reference it is a standalone page; treat it as a sibling page in the same "operations/health" nav group.
- **Icon idea:** A small bar-chart / gauge glyph, or a fuel-gauge.
- **Subtitle (under the H1 "Token Monitor"):**
  - HU: "Ügynök token-fogyasztás nyomon követése"
  - EN: "Track agent token consumption"

### 1c. Tool-Call Log (Eszközhívás-napló)
- **Purpose:** Capture every tool invocation an agent makes (tool name, a short input summary, success/failure, timestamp, session) so the system can later analyze repeated sequences and suggest automatable workflows.
- **Nav item:** None required (background facility). If you choose to surface it, place a small **"Eszközhívás-napló / Tool-call log"** panel at the bottom of the Token Monitor page or behind a tab.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only; styling → 01-design.md)

### 2a. Status (Státusz) page — top to bottom
1. **Page header row:** H1 "Státusz" on the left with the subtitle beneath it; on the right a single compact secondary button **"Frissítés / Refresh"** with a circular-refresh icon.
2. **Overall banner:** A full-width status banner (one line of large text) that states the global verdict. Its visual treatment changes by state (a calm/positive treatment for all-good, a warning treatment for degraded, a muted/neutral treatment for unknown). Defer the actual colors to `01-design.md`; the banner just carries one of three sentences (section 4).
3. **Services section:** A sub-heading **"Szolgáltatások / Services"** followed by a responsive grid of small service tiles (one per upstream component).
4. **Incidents section:** A sub-heading **"Incidensek / Incidents"** followed by a vertical list of incident cards (most recent first), capped at the most recent ~15.

The page is a single scrolling column; no left/right split, no modals.

### 2b. Token Monitor page — top to bottom
1. **Page header row:** H1 "Token Monitor" + subtitle on the left. On the right, a horizontal **control cluster** that wraps on narrow screens: a **period dropdown**, an **agent dropdown**, and a **"Gyűjtés / Collect" button** with a refresh icon. (Section 3.)
2. **Summary cards row:** A flex-wrap row of compact stat cards, one per agent, each showing that agent's totals. (Section 4b.)
3. **Budget cards row:** A flex-wrap row of exactly two stat cards — the rolling 5-hour window and the rolling weekly window — each showing the current cumulative usage in that window. (Section 4c.)
4. **Timeline card:** A bordered card titled **"Idővonal / Timeline"** containing a canvas-rendered chart (~360–370px tall) of stacked per-agent bars plus cumulative budget-window overlay lines. A floating tooltip appears on hover. (Section 4d.)
5. **Details card:** A bordered card titled **"Legnagyobb hívások / Largest calls"** with a min-token filter on the right of its header, a search box + result counter above the table, and a sortable table of the heaviest individual API calls. (Section 4e.)
6. **(Optional) Tool-call log / workflow panel:** see 1c / 5c.

This page is also a single scrolling column. On screens ≤768px wide the header control cluster stacks vertically, the summary cards go full-width, and the chart shrinks to ~220px tall.

---

## 3) CONTROLS — every interactive element

### 3a. Status (Státusz)
| Control | HU label | EN label | Behavior |
|---|---|---|---|
| Refresh button (compact, secondary, refresh icon) | "Frissítés" | "Refresh" | Re-fetches the upstream status feed and re-renders the banner, services grid, and incidents list. Also runs automatically when the page is opened. |

There are no other controls on the Status page (no filters, no search, no per-incident menus). Incident cards are read-only.

### 3b. Token Monitor
| Control | HU label / options | EN label / options | Behavior |
|---|---|---|---|
| Period dropdown | "1 óra" / "24 óra" / "7 nap" (default) / "30 nap" | "1 hour" / "24 hours" / "7 days" (default) / "30 days" | Sets the time range for ALL widgets on the page. Changing it clears the agent selection (back to "all") and reloads summary + timeline + budget cards + details. The chosen period also drives chart bucket granularity (1h → 5-minute buckets; everything else → 1-hour buckets) and the x-axis label format. |
| Agent dropdown | first option "Mind"; then one option per discovered agent (agent display names) | first option "All"; then one per agent | Filters every widget to a single agent (or all). Its options are populated dynamically from the summary data the first time the page loads. Kept in sync with clicking an agent summary card (3c). |
| Collect button (compact, secondary, refresh icon) | "Gyűjtés" | "Collect" | Triggers a server-side ingestion pass that scans the local agent transcripts for new usage records and inserts them. While running, the button is disabled and shows "Gyűjtés… / Collecting…"; on success it briefly shows "Kész (N új) / Done (N new)" where N is the count of newly inserted records, then reverts after ~2s and reloads the page data; on failure it briefly shows "Hiba! / Error!" then reverts. |
| Min-token input (number, in the Details card header) | label "Min token:", default 50000, ~80px wide | label "Min tokens:" | Sets the minimum total-input-token threshold for which individual calls appear in the details table. Changing it re-fetches the details list only (not the whole page). Ignored while a search query is active (search overrides the threshold). |
| Details search box | placeholder "Keresés (ágens, tool, tartalom)…" | placeholder "Search (agent, tool, content)…" | Free-text search across agent name, tool name, content preview, and task title. Debounced (~400ms after typing stops) then re-fetches the details list. When non-empty, it supersedes the min-token filter so matches are not hidden by the threshold. |
| Details count label | "{N} sor" | "{N} rows" | Read-only; shows how many rows are currently displayed. |

#### Clickable cards as controls (Token Monitor)
- **Agent summary card (each):** Click toggles that agent as the active filter. Clicking an already-active card clears the filter (back to all). Selecting a card also updates the agent dropdown to match, and reloads the timeline/details scoped to that agent. The active card gets a selected outline; non-selected cards dim while one is selected.
- **Budget card (each of the two):** Click toggles a "budget overlay" focus mode for that window (5h or weekly). When one budget view is active, the timeline's bars dim and the chosen cumulative window line is emphasized; the other budget card dims. Clicking the active budget card again clears the focus.
- **Timeline chart legend hit-targets:** The two cumulative-line legend entries ("5h ablak / 5h window" and "heti ablak / weekly window") are clickable inside the canvas; clicking one toggles the same budget-overlay focus mode as the budget cards.

### 3c. Sort controls (Details table)
- Each of the first four column headers is clickable to sort: **Idő/Time**, **Ágens/Agent**, **Input**, **Output**. Clicking a header sorts by that column; clicking the same header again flips ascending/descending. A small ▲/▼ arrow marks the active column and direction. Default sort: Time, descending (newest first). Agent column defaults to ascending (A→Z) on first click; numeric columns default to descending on first click. The "Tartalom/Content" column is not sortable.

---

## 4) LISTS / CARDS / TABLES — fields & per-item content

### 4a. Status — Overall banner
A single line of large text, one of:
- All good → "Minden szolgáltatás működik" / "All services operational"
- Active incident → "Aktív incidens" / "Active incident"
- Cannot determine → "Státusz nem elérhető" / "Status unavailable"
- Load failure (fetch threw) → "Nem sikerült betölteni a státuszt" / "Failed to load status"
The banner's visual state class is derived from the verdict (operational / degraded / unknown); colors come from `01-design.md`.

### 4b. Status — Services grid (one tile per upstream component)
Each tile shows:
- A small status dot (positive treatment if the component is operational, warning treatment otherwise).
- The component name (escaped text).
- For non-operational components only, a small right-aligned state label translated to HU short form: operational→"működik", degraded performance→"lassú", partial outage→"részleges kimaradás", major outage→"kimaradás", under maintenance→"karbantartás". (EN equivalents: working / slow / partial outage / outage / maintenance.) An unknown raw state falls back to showing the raw string.
- No per-tile menu or action (read-only).
- **Empty case:** if the upstream component feed is unavailable, show a single honest note instead of a fake all-green grid: "Nincs per-szolgáltatás adat (a komponens-státusz nem elérhető)." / "No per-service data (component status unavailable)."

### 4c. Status — Incidents list (most recent ~15)
Each incident card shows:
- **Header row:** incident title (escaped) on the left; a small status badge on the right. Badge labels by state: resolved→"Megoldva", monitoring→"Figyelés", identified→"Azonosítva", investigating→"Vizsgálat" (EN: Resolved / Monitoring / Identified / Investigating). Unknown state shows raw.
- **Description:** the incident text, stripped of markup and truncated to ~300 characters.
- **Date:** the publish time, formatted in the local (Hungarian/Budapest) locale.
- No per-card action or menu (read-only).
- **Empty case:** "Nincs korábbi incidens" / "No past incidents".

The displayed status of each incident is inferred from its description text (looks for the words resolved / monitoring / identified, defaulting to "investigating"). The global verdict is "degraded" if any listed incident is not resolved, otherwise "operational".

### 4d. Token Monitor — Summary cards (one per agent)
Each card shows:
- **Label:** the agent's display name.
- **Big value:** that agent's **total input-side tokens** = plain input + cache-read + cache-creation tokens, summed over the period, formatted compactly (e.g. 12.3K, 4.1M, 1.2B; values under 1000 shown as-is).
- **Sub-line:** "{calls} hívás, out: {output}" / "{calls} calls, out: {output}" — the call count (locale-grouped) and total output tokens (compact-formatted).
- **Accent:** a left color stripe in the agent's assigned accent color (a stable per-agent color map; unknown agents fall back to a neutral gray).
- Cards are sorted descending by total input-side tokens (heaviest agent first).
- **Per-card action:** click to filter the page to that agent (see 3b).
- **Empty case:** a single placeholder card: label "Nincs adat / No data", value "0", sub "Kattints a „Gyűjtés" gombra / Click the "Collect" button".

### 4e. Token Monitor — Budget cards (exactly two)
| Card | HU label | EN label | Value | Sub-line |
|---|---|---|---|---|
| 5-hour window | "5 órás ablak" | "5-hour window" | current cumulative input-side tokens in the active rolling 5h window (compact) | "kumulatív az aktuális ablakban" / "cumulative in current window" |
| Weekly window | "Heti ablak" | "Weekly window" | current cumulative input-side tokens in the active rolling 7-day window (compact) | same sub-line |
Each card has a colored left stripe (5h and weekly use two distinct accent colors, mirrored by the chart's overlay lines). Click behavior in 3b.

### 4f. Token Monitor — Timeline chart (canvas)
A custom-drawn chart, not an off-the-shelf widget. It contains:
- **Stacked vertical bars:** one column per time bucket; within a column, a stacked segment per agent in that agent's accent color (or, when filtered to one agent, just that agent's bar). Bar height encodes input-side tokens for the bucket.
- **Left Y axis:** per-bucket token scale (5 ticks), compact-formatted.
- **Right Y axis:** cumulative token scale (5 ticks), tinted to match the cumulative lines.
- **X axis:** time labels (~8 evenly spaced), formatted by period (HH:MM for 1h/24h; "MM-DD HH:00" for longer ranges), in local time.
- **Two cumulative overlay lines:** a 5-hour rolling-window cumulative line and a weekly rolling-window cumulative line. Each line resets to zero at its window boundary (the line drops and restarts). When a budget view is focused (3b), that line is emphasized and bars + the other line dim.
- **Reset boundary guides (vertical dashed lines):** thin dashed verticals marking window resets — a 5-hour grid, daily midnight, and weekly Monday-midnight. Each uses a distinct dash/color (defer exact colors to `01-design.md`); a daily line that coincides with a 5h line is merged, and a Monday is promoted to a weekly line.
- **Peak-hours shading:** faint vertical bands shading the upstream provider's known peak-load hours (a weekday morning block in the provider's home timezone), to explain why some buckets are heavier or more rate-limited.
- **In-canvas legend:** wrapping single row with: one swatch+name per agent, then the two cumulative-line entries (clickable, see 3b), then dashed-line entries for "5h", "nap/day", "hét/week", and a swatch for "csúcsidő/peak".
- **Hover tooltip (floating div):** appears over the hovered bucket and lists: the bucket time (with a "CSÚCSIDŐ/PEAK" tag if it falls in a peak band); each agent segment with its color swatch and token value; a total line if more than one agent; and a separator block showing the 5h-window and weekly-window cumulative values at that bucket.
- **Empty case:** centered text in the canvas: "Nincs adat a kiválasztott időszakra" / "No data for the selected period".

### 4g. Token Monitor — Details table ("Legnagyobb hívások / Largest calls")
Columns:
1. **Idő / Time** — call timestamp, local format (MM-DD HH:MM), no-wrap. Sortable.
2. **Ágens / Agent** — agent name in its accent color (bold); if the call could be correlated to a kanban task, a small dim "[task title]" suffix is appended. Sortable (by agent name).
3. **Input** — total input-side tokens (input + cache-read + cache-creation), right-aligned, tabular figures, compact-formatted. Sortable.
4. **Output** — output tokens, right-aligned, tabular, compact. Sortable.
5. **Tartalom / Content** — optional `tool name` shown as inline code, then a content preview truncated to ~80 chars (escaped), single-line with ellipsis; full preview in the cell tooltip. Not sortable.
- Rows are capped (server returns up to ~200) and ordered by the active sort.
- **Empty case:** a single full-width row: "Nincs ilyen hívás a szűrt időszakban" / "No such call in the filtered range".
- No per-row menu or destructive action (read-only analytics table).

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

Neither the Status page nor the Token Monitor page opens any modal, drawer, or detail pane. There is no "click a row to open details" interaction. The only "opening"-like behaviors are:

### 5a. Hover tooltip on the timeline (described in 4f)
This is a transient floating panel, not a modal. Contents: bucket time + peak tag; per-agent token breakdown with swatches; total; 5h and weekly cumulative values. It is pointer-passthrough (does not capture clicks), dismissed on mouse-leave, and re-positioned to stay inside the chart container.

### 5b. Incident card (Status)
Incident cards are inline and fully expanded already (header + truncated description + date). They do not open into a larger view in the reference. (If you want an enhancement, you MAY make the title link to the upstream incident permalink in a new tab — the feed provides a link — but keep it optional and unobtrusive.)

### 5c. (Optional) Workflow-candidate panel (Tool-Call Log)
If you surface the tool-call log, the only "opened" artifact is a workflow-candidate list. Each candidate represents a dense burst of tool calls within one session and shows: session identifier, total tool-call count, duration in minutes, start/end timestamps, the distinct set of tools used, and a short preview of the first ~10 steps (each step = tool name + a one-line input summary). This is a read-only suggestion list ("these repeated steps could become a saved workflow"). No editing inside it.

---

## 6) FLOWS & BEHAVIOR (behavior/contract, not code)

### 6a. Status page open / refresh
1. On page open and on "Frissítés/Refresh" click, the page sets the banner to a loading state ("Betöltés…/Loading…") and clears the grid + list.
2. It calls **GET the status endpoint** (`/api/status`). The server fetches the upstream provider's incident feed and per-component health, derives an overall verdict, and returns: `overall` (operational | degraded | unknown), `components` (array of {name, status}), `incidents` (array of {title, description, pubDate, link, status}, newest first, ≤15), and a fetch timestamp.
3. The page renders the banner (4a), the services grid (4b), and the incidents list (4c).
4. If the fetch throws, the banner shows the load-failure sentence and the grid/list stay empty. If the server reached out but the component feed specifically failed, `components` comes back empty and the grid shows the honest "no per-service data" note rather than faking green tiles.
5. No polling — the page is refreshed manually (open or button). (You MAY add an optional light auto-refresh, e.g. every 60s, but keep it off by default to respect the upstream feed.)

### 6b. Token Monitor page open
1. On open (or any period/agent change, or after a successful collect), the page loads in this order: summary → (populate agent dropdown first time) → timeline → budget cards → reset search box → details.
2. **Summary:** GET `/api/token-usage/summary?from&to` → array of per-agent aggregates {agent, totalInput, totalOutput, totalCacheRead, totalCacheCreation, totalCalls}. The page sorts descending by total input-side and renders summary cards (4d).
3. **Timeline:** GET `/api/token-usage/timeline?from&to&bucket[&agent]` → array of {bucket (epoch seconds), agent, calls, inputTokens, outputTokens}. Bucket size is sent in minutes (5 for the 1h period, 60 otherwise). The page fills gaps so every bucket has a row per agent, computes the two cumulative rolling windows, and draws the chart (4f) + budget cards (4e).
4. **Details:** GET `/api/token-usage?from&to[&agent]&limit=200` with either `min_tokens=<threshold>` (when no search) or `q=<query>` (when searching) → array of call rows {timestamp, agent, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, content_preview, tool_name, task_title}. Rendered into the sortable table (4g).

### 6c. Collect (manual ingestion)
1. "Gyűjtés/Collect" → POST `/api/token-usage/collect`. Server scans local agent transcript files for new assistant-message usage records and inserts de-duplicated rows, tracking a per-file cursor so unchanged files are skipped.
2. Response includes a count of inserted rows (`inserted`). The button reflects progress/result (3b) then the page reloads all widgets.
3. Non-destructive (insert-only with de-dup); no confirmation needed.

### 6d. Filtering & sorting (Token Monitor)
- Changing the period: clears agent selection, reloads everything; bucket granularity and x labels adapt.
- Selecting an agent (dropdown or card click): scopes summary highlight, timeline (single agent's bars), budget overlays, and details. Clicking the active card/"Mind" clears it.
- Budget focus (card or legend click): pure client-side re-render of the chart emphasis + card dim; no network call.
- Min-token change: re-fetches details only.
- Search: debounced re-fetch of details only; overrides min-token while non-empty; cleared on full page reload.
- Sort: pure client-side re-sort of already-fetched rows.

### 6e. Tool-call log (background)
- **Write:** a post-tool hook POSTs `/api/tool-log` with {session id, tool name, optional input summary, optional success flag (defaults true)}. Server records it; bad payloads (missing session id or tool name) return a 400 with an error message.
- **Read recent:** GET `/api/tool-log?since=<seconds>` (default 3600) → recent calls.
- **Analyze:** GET `/api/tool-log/analyze?since&min_calls&gap` → summarized workflow candidates (see 5c).
- **Prune:** POST `/api/tool-log/prune` with {older_than_secs} (default 86400) → deletes old entries. This is the only destructive action in this whole area; if you surface a "Prune/Tisztítás" button, gate it behind a confirmation ("Töröljem a {N napnál} régebbi naplóbejegyzéseket? / Delete log entries older than {N days}?") and only show it to the operator.

### 6f. Confirmations for destructive actions
- Status page: none (read-only).
- Token Monitor: none (collect is insert-only; all filters are read-only).
- Tool-call log prune: confirm before deleting (6e).

---

## 7) STATES

| State | Status page | Token Monitor |
|---|---|---|
| **Loading** | Banner shows "Betöltés…/Loading…"; grid + list cleared. | Each widget renders from its fetch; show skeleton/placeholder cards and a chart placeholder while in flight. Collect button shows "Gyűjtés…/Collecting…". |
| **Empty** | Services: honest "no per-service data" note. Incidents: "Nincs korábbi incidens / No past incidents". | Summary: single "Nincs adat / No data — click Collect" card. Chart: centered "Nincs adat a kiválasztott időszakra / No data for the selected period". Details: single "Nincs ilyen hívás / No such call" row. |
| **Error** | Fetch threw → banner "Nem sikerült betölteni a státuszt / Failed to load status". Server reachable but verdict undeterminable → banner "Státusz nem elérhető / Status unavailable". | Failed sub-fetches abort that widget silently and leave prior content; Collect failure flashes "Hiba!/Error!" on the button. |
| **Permission denied** | If the operator-token auth fails, the dashboard's global auth gate handles it; treat a 401/403 as "show the auth gate", not an inline error. | Same — these pages assume an authenticated operator session. |
| **Live update / poll** | No polling by default (manual refresh). Optional opt-in 60s auto-refresh. | No polling; data is point-in-time per open/collect/filter-change. The chart re-renders on window resize (re-using the last fetched data) so it stays crisp on layout changes. |

---

## 8) PERMISSIONS / VISIBILITY

- Both pages are **operator-facing dashboard pages**, served behind the dashboard's operator-token auth. Agents do not browse this UI; they only WRITE to the tool-call log via the hook endpoint and have their usage ingested into the Token Monitor.
- There is **no autonomy-level gating** on viewing — these are observability screens, always readable by the operator. The only privileged write is **prune** (6e), operator-only and confirmation-gated.
- The Status page exposes only upstream public service info; it carries no secrets.
- The Token Monitor exposes per-agent usage; content previews are escaped (XSS-safe) but may contain task context, so treat the page as operator-only and do not expose it to agents.

---

## 9) DATA CONCEPTS (concept-level; do NOT copy any schema)

- **Upstream status snapshot** (read-only, fetched live): overall verdict; per-component health (name + state); recent incidents (title, description text, publish time, permalink, inferred state). Nothing persisted locally.
- **Token-usage record** (read; written by the collector, never by the UI): per API call — which agent, which session, when, input/output/cache-read/cache-creation token counts, an optional short content preview, an optional tool name, an optional correlated task title, and a project identifier. De-duplicated by (agent, session, time, input, output). This is **usage accounting against rate-limit windows**, not billing.
- **Collector cursor** (read/written by the collector): per-source-file progress marker so re-collection is incremental and idempotent.
- **Rolling budget windows** (derived, not stored): cumulative usage within the active 5-hour and weekly rate-limit windows, reset at window boundaries. These are the operator's real constraints under the flat subscription.
- **Tool-call log entry** (written by hook, read by analyzer): session, tool name, short input summary, success flag, timestamp. Aggregated into workflow candidates (dense same-session bursts).
- **Kanban correlation** (derived, read): a heuristic linking a usage record to a task by matching the assignee agent and the task's time window — surfaces "[task title]" on heavy calls.

---

## 10) i18n — all strings ship HU (default) + EN

Provide both; HU is the default UI language.

**Status page:**
| Key | HU | EN |
|---|---|---|
| nav | Státusz | Status |
| subtitle | Claude szolgáltatások állapota | Claude service status |
| refresh | Frissítés | Refresh |
| loading | Betöltés… | Loading… |
| overall.operational | Minden szolgáltatás működik | All services operational |
| overall.degraded | Aktív incidens | Active incident |
| overall.unknown | Státusz nem elérhető | Status unavailable |
| overall.loadError | Nem sikerült betölteni a státuszt | Failed to load status |
| services.heading | Szolgáltatások | Services |
| services.empty | Nincs per-szolgáltatás adat (a komponens-státusz nem elérhető). | No per-service data (component status unavailable). |
| comp.operational | működik | working |
| comp.degraded_performance | lassú | slow |
| comp.partial_outage | részleges kimaradás | partial outage |
| comp.major_outage | kimaradás | outage |
| comp.under_maintenance | karbantartás | maintenance |
| incidents.heading | Incidensek | Incidents |
| incidents.empty | Nincs korábbi incidens | No past incidents |
| inc.resolved | Megoldva | Resolved |
| inc.monitoring | Figyelés | Monitoring |
| inc.identified | Azonosítva | Identified |
| inc.investigating | Vizsgálat | Investigating |

**Token Monitor:**
| Key | HU | EN |
|---|---|---|
| nav / title | Token Monitor | Token Monitor |
| subtitle | Ügynök token-fogyasztás nyomon követése | Track agent token consumption |
| period.1h / .24h / .7d / .30d | 1 óra / 24 óra / 7 nap / 30 nap | 1 hour / 24 hours / 7 days / 30 days |
| agent.all | Mind | All |
| collect | Gyűjtés | Collect |
| collect.running | Gyűjtés… | Collecting… |
| collect.done | Kész (N új) | Done (N new) |
| collect.error | Hiba! | Error! |
| summary.empty.label | Nincs adat | No data |
| summary.empty.sub | Kattints a „Gyűjtés" gombra | Click the "Collect" button |
| summary.sub | {calls} hívás, out: {output} | {calls} calls, out: {output} |
| budget.5h | 5 órás ablak | 5-hour window |
| budget.weekly | Heti ablak | Weekly window |
| budget.sub | kumulatív az aktuális ablakban | cumulative in current window |
| timeline.heading | Idővonal | Timeline |
| timeline.empty | Nincs adat a kiválasztott időszakra | No data for the selected period |
| legend.5hWindow | 5h ablak | 5h window |
| legend.weeklyWindow | heti ablak | weekly window |
| legend.5h / .day / .week / .peak | 5h / nap / hét / csúcsidő | 5h / day / week / peak |
| tooltip.total | Összesen | Total |
| tooltip.peak | CSÚCSIDŐ | PEAK |
| details.heading | Legnagyobb hívások | Largest calls |
| details.minTokens | Min token: | Min tokens: |
| details.search | Keresés (ágens, tool, tartalom)… | Search (agent, tool, content)… |
| details.count | {N} sor | {N} rows |
| details.empty | Nincs ilyen hívás a szűrt időszakban | No such call in the filtered range |
| col.time / .agent / .input / .output / .content | Idő / Ágens / Input / Output / Tartalom | Time / Agent / Input / Output / Content |

**Tool-call log (if surfaced):**
| Key | HU | EN |
|---|---|---|
| panel.title | Eszközhívás-napló | Tool-call log |
| workflow.title | Lehetséges munkafolyamatok | Workflow candidates |
| prune | Tisztítás | Prune |
| prune.confirm | Töröljem a {N} napnál régebbi naplóbejegyzéseket? | Delete log entries older than {N} days? |

---

## Token-count formatting (shared helper)

All token magnitudes display compactly: ≥1e9 → "N.NB", ≥1e6 → "N.NM", ≥1e3 → "N.NK", otherwise the plain integer; null/NaN → "0". Call counts use locale digit grouping. Never append a currency symbol or convert to money anywhere — this entire area is token/usage accounting under a flat subscription, not API spend.

---

## Build acceptance checklist
- Status page renders banner + services grid + incidents from one live fetch, refreshes on demand, and shows honest empty/error states (no fake green grid).
- Token Monitor renders agent summary cards, two budget cards, a canvas timeline with stacked bars + two resetting cumulative lines + reset guides + peak shading + hover tooltip + clickable legend, and a sortable/searchable details table.
- Period/agent/min-token/search filters drive the right scope and the right (full vs details-only) reloads; collect is insert-only with a progress button.
- No dollars, no cost, no invoices anywhere. All strings exist in HU (default) + EN.
- Visual look defers entirely to `01-design.md`.
