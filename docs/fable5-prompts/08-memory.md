# Fable 5 Build Prompt — Memory (Memória) View

> CLEAN-ROOM NOTICE — This is an original behavioral and visual specification written for an engineer who has never seen the reference product. Implement it from scratch in your own code. Do not seek, copy, or reproduce any source code, identifiers, file names, database schema, or API route strings from any prior system — everything below is described at the level of appearance, behavior, and contract only. Where API shapes are named, treat them as a contract you are free to implement however you like. All visual styling (colors, spacing, typography, radii, shadows, motion) is governed by **01-design.md** — this document defines structure and behavior, not pixels.

---

## 1) PURPOSE & WHERE IT LIVES

**What this is.** The Memory view is the AI team's shared knowledge base — a place where the operator and the agents store, browse, search, visualize, and recall durable facts ("memories"). A memory is a short-to-medium text note tagged with a *tier* (importance/freshness band), an owning *agent*, and optional *keywords*. The view also exposes two alternate lenses on the same underlying data: a force-directed **graph** that draws memories as connected nodes, and a **recall/journal timeline** that reconstructs what happened on a given date or matched a query.

**Navigation.** Two sibling nav entries live in the left sidebar:
- **Memória** (EN: *Memory*) — the main memory workspace (list + graph + daily log lenses live here as in-page tabs).
- **Napló** (EN: *Journal* / *Recall*) — the recall/timeline lens, reachable as its own page.

Use distinct icons: for Memory, a brain or a stack-of-cards / database glyph; for Journal, a calendar-with-clock or open-book glyph. Pick one consistent icon idea per entry and keep it stable across themes.

**Page subtitles (shown under the page title).**
- Memory page title: **Memória** / *Memory*. Subtitle: **AI csapat tudásbázisa** / *The AI team's knowledge base*.
- Journal page title: **Napló** / *Journal*. Subtitle: **Session recall: napi naplók és emlékek visszakeresése** / *Session recall: retrieve daily logs and memories*.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — styling per 01-design.md)

### Memory page (top to bottom)
1. **Page header row** — left: title + subtitle. Right: a cluster of two action buttons (Új emlék / New memory; Költöztetés / Import — described in §3).
2. **Stats strip** — a horizontal row of compact stat cards summarizing the corpus (total, per-tier counts, vector coverage), plus an inline action button pinned to the far right (Generate vectors). Detailed in §4.
3. **Toolbar row** — a full-text search field (with a magnifier icon), a search-mode dropdown, and an agent filter dropdown.
4. **Tab strip** — a horizontal set of segmented tabs that switch the lens below: Hot, Warm, Cold, Shared, Gráf (Graph), Napló (Log). The first four are tier filters over the list; the last two swap the body to a different lens entirely.
5. **Body region** — exactly one of three mutually exclusive panels is visible at a time:
   - **List panel** (for the four tier tabs): a vertical stack of memory cards, plus an empty-state block.
   - **Graph panel** (for Gráf): a full-bleed canvas area with an overlaid controls hint, a transient zoom indicator, an empty-state block, and a slide-in detail panel.
   - **Daily-log panel** (for Napló-in-Memory): a date navigator (prev / current-date / next) over a list of that day's log entries, plus an empty-state block.

### Journal / Recall page (separate page)
1. **Page header** — title + subtitle.
2. **Recall toolbar** — a text search field, a date picker, a free-text date-expression field, an agent filter, and a primary Search button.
3. **Summary line** — a single compact row summarizing the matched range and counts.
4. **Timeline region** — a chronological, date-grouped list of mixed log + memory entries.

Both pages are single-column, scrollable, responsive. The graph canvas must fill its container and resize with it.

---

## 3) CONTROLS — every interactive element (HU default / EN)

### Memory page header
- **Button: Új emlék / New memory** (primary, plus-icon). Opens the memory create/edit modal in *create* mode (§5).
- **Button: Költöztetés / Import** (secondary, upload-icon). Opens a bulk-import modal (a system-migration helper). Out of scope for full detail here; behavior summarized in §6. At minimum it accepts a batch of text chunks and bulk-creates memories, optionally auto-classifying each into a tier via a local model.

### Toolbar
- **Search field — placeholder: "Keresés az emlékekben…" / "Search memories…"** (magnifier icon inside). Free-text query over memory content and keywords. Behavior: debounced live search (~300 ms after typing stops) and immediate search on Enter. The same field also drives live highlight/fade in the graph lens (see §6).
- **Dropdown: search mode** with two options:
  - **Hibrid keresés / Hybrid search** (default).
  - **Kulcsszavas / Keyword (full-text)**.
  This selects how the query is matched (concept in §9). It only affects results when the search field is non-empty.
- **Dropdown: agent filter** — first option **Minden ügynök / All agents** (empty value), followed by one option per agent (value = agent identifier, visible text = agent display label). Populated from the agent roster. Changing it re-runs whichever lens is active (list, graph, or log).

### Tab strip (segmented)
Each tab carries a small emoji/icon + label. Exactly one is active.
- **🔥 Hot** — list filtered to the *hot* tier (active by default on first open).
- **🌡️ Warm** — list filtered to *warm*.
- **❄️ Cold** — list filtered to *cold*.
- **🔗 Shared** — list filtered to *shared*.
- **🕸️ Gráf / Graph** — switches body to the graph lens.
- **📋 Napló / Log** — switches body to the daily-log lens.

### Stats strip controls
- **Button: Vektorok generálása / Generate vectors** (secondary, compact, pinned right). Triggers embedding backfill for memories that lack a vector (§6). While running it shows **Generálás… / Generating…** and is disabled.

### Graph lens overlays
- **Controls hint** (static text, bottom corner): "Scroll: zoom | Drag: move nodes / Click: details / Dbl-click: edit" — localize: HU "Görgő: nagyítás | Húzás: csomópont mozgatása / Kattintás: részletek / Dupla kattintás: szerkesztés".
- **Zoom indicator** (transient): shows current zoom as a percentage; appears on zoom change and fades after ~1.2 s.
- The graph reuses the toolbar search field for in-graph filtering (no separate field).

### Daily-log lens controls
- **Button: ‹ (Előző nap / Previous day)** and **Button: › (Következő nap / Next day)** flanking the **current date label**.

### Journal / Recall page toolbar
- **Search field — placeholder: "Keresés a napló szövegében…" / "Search the journal text…"** (magnifier icon). Free-text query across logs + memories. Enter triggers a search.
- **Date picker** (native date input, calendar icon). Defaults to today (computed in the operator's Budapest timezone). A tooltip on it shows how many days have journal entries.
- **Free-text date expression field — placeholder: "pl. tegnap, múlt héten… / e.g. yesterday, last week…"**. Accepts natural-language relative dates (see §6, parser). Enter triggers a search. If non-empty, it overrides the date picker.
- **Dropdown: agent filter** — first option **Minden ágens / All agents** (empty value), then one per agent. Changing it refreshes the per-agent list of journaled dates (and updates the picker's day-count tooltip).
- **Button: Keresés / Search** (primary, compact). Runs the recall query.

---

## 4) LISTS / CARDS / TABLES — exact item contents

### Stats strip (cards)
Rendered from a stats summary. Cards, left to right:
- **Total card** — big number = total memory count; label **Összes / Total**.
- **One card per tier present** — big number = count in that tier, colored to that tier's accent; label = the tier's display name with its emoji (🔥 Hot, 🌡️ Warm, ❄️ Cold, 🔗 Shared).
- **Vectors card** — big number = count of memories that have an embedding; label **Vektorok (NN%) / Vectors (NN%)** where NN% = embedded ÷ total, rounded.
- **Generate-vectors button** pinned to the right edge of the strip (see §3).

### Memory list cards (List lens)
The body is a vertical stack; each memory is one card. A card shows, in this order:
- **Header row:**
  - **Tier badge** — pill colored to the tier, text = tier display label (with emoji).
  - **Agent badge** — pill showing the owning agent's identifier (falls back to the main agent if unset).
  - **Date** — the memory's creation timestamp, formatted in Hungarian locale / Budapest time (e.g. "2026. 06. 12. 14:32").
  - **Salience tag** — shown only when a numeric salience is present: a small chip reading **"S: 1.40"** (two decimals), tooltip **"Relevancia érték" / "Relevance value"**. (Salience concept in §9.)
- **Content (collapsed)** — the memory text truncated to ~120 characters with an ellipsis. Tapping/clicking the card body toggles the card open to reveal the **full content** (the truncated and full versions are both present; expansion swaps which is visible). Clicking the action buttons does NOT toggle expansion.
- **Keywords row** — if the memory has keywords, render each as a small tag chip. Keywords may arrive as a comma-separated string or a list; split, trim, drop empties.
- **Footer row (per-item actions):**
  - **Szerkesztés / Edit** (secondary, small). Opens the modal in edit mode pre-filled from this memory.
  - **Törlés / Delete** (danger, small). Deletes after confirmation.

**Empty state for the list:** a centered block, text **"Nincs emlék ebben a kategóriában" / "No memories in this category."**

### Daily-log entries (Log lens)
A date navigator at top (prev / current date / next), then a list of that day's journal entries. Each entry shows its timestamp/label, the owning agent, and the entry text. Empty state: **"Nincs naplóbejegyzés ezen a napon" / "No journal entries on this day."**

### Recall timeline items (Journal page)
A flat, chronological, date-grouped list. Items are sorted ascending by timestamp; when the date changes, insert a **date header** (YYYY-MM-DD). Two item kinds:
- **Log item** — header shows the formatted timestamp label and an **agent badge**; body shows the log text.
- **Memory item** — header shows the formatted timestamp label, a **tier/category badge** (colored), and an **agent badge**; body shows the memory text; if it has keywords, a trailing line **"Kulcsszavak: …" / "Keywords: …"**.

Empty state: **"Nincs találat erre az időszakra." / "No results for this period."**

---

## 5) OPENED CARDS / MODALS / DETAIL PANES — full contents

### A) Memory create/edit modal
A centered, wide modal overlay (dim backdrop). Closes on the × button, on backdrop click, or after a successful save.

**Header:** title text = **"Új emlék" / "New memory"** in create mode, or **"Emlék szerkesztése" / "Edit memory"** in edit mode. Close button (×).

**Body fields (top to bottom):**
- **Row of two half-width fields:**
  - **Ügynök / Agent** — dropdown, one option per agent (value = identifier, text = label). In edit mode, preselect the memory's agent.
  - **Tier** — dropdown with four options, each with emoji + a parenthetical hint:
    - 🔥 **Hot (aktív)** / *Hot (active)*
    - 🌡️ **Warm (stabil)** / *Warm (stable)* — default selection in create mode.
    - ❄️ **Cold (archív)** / *Cold (archive)*
    - 🔗 **Shared (megosztott)** / *Shared (shared)*
- **Tartalom / Content** — multi-line textarea (~5 rows), placeholder **"Mit kell megjegyezni…" / "What should be remembered…"**. Required.
- **Kulcsszavak / Keywords** — single-line text input, placeholder **"pl. marketing, kampány, ROI" / "e.g. marketing, campaign, ROI"**, with an inline hint label: **"(vesszővel elválasztva, keresést segíti)" / "(comma-separated, improves search)"**.
- A hidden field carries the edited memory's id in edit mode (empty in create mode).
- **Button: Mentés / Save** (primary). Creates or updates (§6).

**Create-mode prefill nuance:** when opened via the header Új emlék button while a tier tab is active, the Tier dropdown defaults to that active tier (and to Warm when the Graph or Log lens is active). When opened via a card's Edit button or via the graph (double-click), all fields prefill from that memory.

### B) Graph node detail panel (Graph lens)
A slide-in panel anchored within the graph area, shown when a node is **single-clicked**. Contents:
- **Header:** tier badge (colored, label = Hot/Warm/Cold/Shared) + agent identifier + a close button (×).
- **Date line:** the memory's creation label (if present).
- **Content block:** the full memory text.
- **Keywords:** keyword tag chips (if any).
Closing it (× or clicking empty canvas) clears the selection and re-renders the graph. **Double-clicking** a node instead opens the edit modal (§A) prefilled from that memory.

### C) Graph hover tooltip (Graph lens)
On hover (when no node is selected), a small floating tooltip near the node shows: a bold line **"<Tier> | <agent>"**, a muted line **"N connections" / "N kapcsolat"**, and (if any) a truncated keyword line. This is ephemeral and disappears when the cursor leaves.

### D) Import modal (summary)
Opened by Költöztetés / Import. A wide modal with explanatory text and a way to submit a batch of text chunks for bulk creation. On submit it imports each chunk as a memory; if a local model is available it auto-assigns a tier + keywords per chunk, otherwise it defaults everything to Warm. On completion it reports how many were imported and the per-tier breakdown. (Full field-by-field design of this modal is secondary; match the create modal's visual language.)

---

## 6) FLOWS & BEHAVIOR — step by step + API contract + effect

> All endpoints below are a contract you implement freely. Request/response shapes are described conceptually. Errors surface as a toast unless noted.

### 6.1 Open Memory page
On entering the page: (1) load the agent roster and populate both the toolbar agent filter and the modal's agent dropdown; (2) load corpus stats and render the stats strip; (3) load the memory list for the default tier (Hot).

### 6.2 List load / filter / search
Build a query with: free-text `q` (if any), `mode` (hybrid|fts, only when `q` present), `agent` (if a specific agent is chosen), `tier` (the active tab), and a result cap (~50).
- **GET memories list** → returns an array of memory objects, each with content, tier/category, agent, keywords, salience, and human-readable created/accessed labels (embeddings are stripped from the payload).
- Effect: render cards (§4). If the array is empty, show the list empty state.
- **Filter semantics (contract):**
  - No `q`, no `agent` → operator/admin view: list across all scopes, newest-accessed first.
  - `q` + `agent` → search that agent's memories (plus shared); if the primary search yields nothing, fall back to a substring match over content/keywords for that agent + shared.
  - `q` + hybrid mode → fuse keyword (full-text) ranking with vector-similarity ranking (concept §9) and return the blended top results.
  - `q` only → full-text search in the operator's default scope, with a substring fallback.
  - A `tier` value further narrows results to that tier client-side/server-side.

### 6.3 Create a memory
From the modal Save: require non-empty content (if empty, focus the content field, do nothing). **POST a new memory** with agent, content, tier, keywords.
- Server validates: content required; **content is screened by a safety filter** that rejects text matching suspicious/injection patterns (e.g. shell-exec snippets, "ignore previous instructions"-style prompt-injection) with a 400 + a "rejected by security filter" message; tier must be one of the four allowed values (else 400). On accept it stores the memory (with a default salience) and returns the new id.
- Effect: toast **"Emlék létrehozva" / "Memory created"**, close modal, reload list + stats.

### 6.4 Edit a memory
From a card's Edit button or a graph node double-click: open the modal prefilled. Save issues **PUT to the memory's id** with content, tier, agent, keywords. 404 if the id is unknown. Effect: toast **"Emlék frissítve" / "Memory updated"**, close modal, reload list + stats.

### 6.5 Delete a memory
From a card's Delete button: show a confirm dialog **"Biztosan törlöd ezt az emléket?" / "Delete this memory for sure?"**. On confirm, **DELETE the memory's id** (404 if unknown). Effect: toast **"Emlék törölve" / "Memory deleted"**, reload list + stats. This is the one destructive action and must always confirm first.

### 6.6 Stats + embedding backfill
- **GET stats** → total count, per-tier counts, count of memories that have an embedding. Render the strip; compute the vector coverage percent.
- **Generate vectors** button → **POST backfill**. Server generates embeddings for every memory lacking one (throttled), returns how many it produced. Effect: toast **"NN emlékhez vektor generálva" / "Generated vectors for NN memories"**, reload stats. The button shows a generating state and disables while in flight.

### 6.7 Graph lens
On selecting Gráf: **GET the memory list** (agent filter applied, larger cap ~200). If empty → graph empty state. Otherwise:
- Reset zoom/pan, clear any selection, hide the detail panel.
- **Build nodes** — one per memory. Node radius scales with how connected it is.
- **Build edges** — connect two memories when they **share one or more keywords** (edge strength = number of shared keywords); additionally, with low probability, lightly connect memories that share the same agent AND tier (a weak grouping force).
- **Layout** — a force-directed simulation: nodes repel each other, edges act as springs, a gentle pull centers the cloud, and nodes of the same tier are softly attracted to their tier's centroid (so tiers cluster). Run a burst of pre-settle iterations, then animate to rest over a short number of frames.
- **Render** — a dotted grid background; soft tinted "halo" backgrounds behind each tier cluster; curved (bezier) edges with a subtle pulsing/breathing animation and width scaled by strength; circular nodes colored by tier with a persistent pill label (first ~25 chars of the content). Hovering or selecting a node highlights it and its directly connected neighbors and dims the rest.
- **Interactions:** scroll = zoom toward cursor (clamped, with the transient % indicator); drag empty space = pan; drag a node = reposition it; hover = tooltip (§C); single-click a node = open detail panel (§B); double-click a node = open edit modal; click empty space = deselect.
- **Graph search:** typing in the toolbar search field filters the graph live — matching nodes (content/keywords/agent contain the query) glow, non-matching nodes and their edges fade. Clearing the field restores all.
Note: in the graph, tier colors are: hot ≈ red, warm ≈ warm-orange, cold ≈ cool-blue, shared ≈ muted gold — defer exact values to 01-design.md but keep the four distinguishable.

### 6.8 Daily-log lens (within Memory)
On selecting Napló tab: load the journal entries for the current date (agent filter applied) and render them; prev/next buttons step the date and reload. Empty state if no entries that day.

### 6.9 Journal / Recall page
On entering: default the date picker to today (Budapest tz); populate the agent filter; load the per-agent list of dates that have journal entries (to drive the picker tooltip and a sensible default); run an initial recall for today.
- **Run recall (Search button, or Enter in either text field):** build a request with: a `date` param (the free-text expression if present, else the picked date), optional `q` (search text), optional `agent`.
- **GET recall** → returns `{ dateRange, logs[], memories[], summary{logCount, memoryCount, agents[]} }`.
  - If `q` is present and no date expression → pure search mode: full-text match across memories + a substring match across logs, returning ranked results.
  - If a date/range is present → fetch all logs + memories in that range; if `q` is also present, additionally filter both lists to those containing the query.
  - **Date expression parsing (contract):** the server understands ISO dates (`YYYY-MM-DD`), ISO ranges (`A – B`), and a rich set of Hungarian + English relative expressions: ma/today, tegnap/yesterday, tegnapelőtt, weekday names ("hétfő", "múlt kedd"), "N nappal ezelőtt"/"N napja", "N héttel ezelőtt", "ezen a héten"/"this week", "múlt héten"/"last week", "ebben a hónapban"/"this month", "múlt hónapban"/"last month", "elmúlt N nap"/"utolsó N nap", month names with a day ("június 12") or with an ordinal week ("június első hét"), and bare month names. Unparseable input → 400 with **"Nem értelmezhető dátum: …" / "Could not parse date: …"** shown inline in the timeline.
- **Render:** the summary line shows the date (or "from – to"), **"N naplóbejegyzés" / "N journal entries"**, **"N emlék" / "N memories"**, and **"Ágensek: …" / "Agents: …"** if any. The timeline renders date-grouped, time-sorted log + memory items (§4). Loading shows **"Betöltés…" / "Loading…"**; a fetch error shows **"Hiba történt" / "An error occurred"** (or the server's error message) in place of the timeline.

---

## 7) STATES

- **Loading:** list/graph silently swap content on reload (no skeleton required, but a brief loading affordance is welcome). Recall timeline shows an explicit "Betöltés… / Loading…" line. The backfill button shows a "Generálás… / Generating…" disabled state.
- **Empty:** list → "Nincs emlék ebben a kategóriában"; graph → "Nincs elég emlék a gráf megjelenítéshez / Not enough memories to render the graph"; daily log → "Nincs naplóbejegyzés ezen a napon"; recall → "Nincs találat erre az időszakra."
- **Error:** network/save/delete failures → toast (e.g. "Hiba a mentés során / Save failed", "Hiba a törlés során / Delete failed"). Recall fetch failure → inline error text. A safety-filter rejection on create → toast with the rejection reason.
- **Permission-denied:** the dashboard sits behind a single operator auth boundary (token/session). If a request is unauthorized, surface a generic auth error and do not render stale data. (Agents do not use this UI — see §8.)
- **Live-update / polling:** the memory list and graph do **not** auto-poll — they refresh on user action (tab switch, filter change, search, save/delete, backfill). The recall page refreshes on demand. (Other dashboard pages may poll; this view is action-driven. If you add background refresh, keep it conservative so it doesn't interrupt graph dragging or card expansion.)

---

## 8) PERMISSIONS / VISIBILITY

- This view is **operator-facing**. The single operator sees and manages the whole corpus across all agents (the "Minden ügynök / All agents" default view lists memories from every scope, including those written under non-default chat scopes — make sure the list count and the stats count agree).
- **Agents do not edit memory through this UI.** Agents read/write memory programmatically (via their own tools / the same API). The operator's create/edit/delete here is unrestricted by autonomy level — this is the human's console.
- **Autonomy gating** applies to *agent* behavior elsewhere (whether an agent may proactively store/escalate), not to operator actions in this view. Do not gate operator create/edit/delete behind autonomy.
- The **safety filter on content** (see §6.3) is a guardrail that applies to *all* writes (operator and agent) — content matching injection/exec patterns is rejected server-side regardless of who submits it.
- "Shared" memories are visible across agents by design; tier "shared" is the cross-agent band. Reflect this in any per-agent scoping: an agent's view always also includes shared memories.

---

## 9) DATA CONCEPTS (read/written, concept level)

- **Memory** — the core record: text content; a **tier/category** (one of hot, warm, cold, shared); an owning **agent**; optional **keywords** (comma-separated); a **salience** number; created and last-accessed timestamps; and an optional **embedding** vector (never sent to the browser). The four tiers express importance/freshness: *hot* = active/now, *warm* = stable knowledge/preferences/config, *cold* = long-term archive, *shared* = relevant to multiple agents.
- **Salience** — a relevance/strength score (starts at a baseline ~1.0, capped at ~5.0). It **rises slightly each time a memory is accessed/retrieved** and **decays slowly over time** for older memories (a gentle daily decay, floored near zero — memories are never auto-deleted, they just fade in salience). The UI displays it read-only on cards (the "S: x.xx" chip). It is not directly editable by the operator; it is a side effect of access + age.
- **Keywords** — drive both search recall and the graph's edge formation (shared keywords = an edge).
- **Embeddings + full-text search (FTS)** — two retrieval mechanisms over the same corpus:
  - **FTS / keyword search** — token/word matching over content (and keywords). Fast, exact-ish. This is the "Kulcsszavas / Keyword" mode.
  - **Embeddings / vector search** — each memory can have a numeric vector capturing its meaning, computed by a local embedding model; queries are embedded and compared by similarity, enabling semantic matches that don't share literal words.
  - **Hybrid search** — fuses the two rankings (reciprocal-rank-style blend) so results benefit from both literal and semantic relevance. This is the default search mode.
  - **Backfill** — embeddings are generated lazily/asynchronously; the stats strip shows coverage and the Generate-vectors button fills in any missing vectors.
  - **Semantic vs episodic framing (sector concept):** memories also carry an implicit *sector* notion — durable semantic knowledge versus episodic/event memories. Tiers approximate this in the UI; if you expose a sector dimension, treat semantic = stable knowledge (warm/cold-ish) and episodic = time-stamped events (surfaced strongly in the recall/journal timeline). Keep it concept-level unless 01-design.md asks for an explicit sector filter.
- **Daily log / journal entries** — separate time-stamped text records per agent per day; the recall view merges these with memories created in the same window into one timeline. Recall can also resolve natural-language date expressions to a date range.
- **Written by the UI:** new/edited/deleted memories; embedding backfill requests; (import) bulk-created memories. **Read by the UI:** memory lists (filtered/searched), stats, the agent roster, recall results, and the set of dates that have journal entries.

---

## 10) i18n

All user-visible strings ship in **Hungarian (default)** and **English**. Wire every label, placeholder, button, tab, badge, empty/loading/error message, toast, and tooltip through the i18n layer. Canonical pairs (HU → EN):

- Memória → Memory · AI csapat tudásbázisa → The AI team's knowledge base
- Napló → Journal · Session recall: napi naplók és emlékek visszakeresése → Session recall: retrieve daily logs and memories
- Új emlék → New memory · Költöztetés → Import · Mentés → Save · Szerkesztés → Edit · Törlés → Delete
- Keresés az emlékekben… → Search memories… · Keresés a napló szövegében… → Search the journal text…
- Hibrid keresés → Hybrid search · Kulcsszavas → Keyword (full-text)
- Minden ügynök → All agents · Minden ágens → All agents · Ügynök → Agent
- Hot/Warm/Cold/Shared (keep tier names; tooltips: aktív/stabil/archív/megosztott → active/stable/archive/shared) · Gráf → Graph · Napló (tab) → Log
- Tier → Tier · Tartalom → Content · Kulcsszavak → Keywords · (vesszővel elválasztva, keresést segíti) → (comma-separated, improves search)
- Mit kell megjegyezni… → What should be remembered… · pl. marketing, kampány, ROI → e.g. marketing, campaign, ROI
- Összes → Total · Vektorok (NN%) → Vectors (NN%) · Vektorok generálása → Generate vectors · Generálás… → Generating…
- S: (salience chip) tooltip Relevancia érték → Relevance value
- Új emlék (modal) → New memory · Emlék szerkesztése → Edit memory
- Emlék létrehozva → Memory created · Emlék frissítve → Memory updated · Emlék törölve → Memory deleted
- Biztosan törlöd ezt az emléket? → Delete this memory for sure?
- Hiba a mentés során → Save failed · Hiba a törlés során → Delete failed · Tartalom elutasítva (biztonsági szűrő) → Content rejected (security filter)
- Nincs emlék ebben a kategóriában → No memories in this category · Nincs elég emlék a gráf megjelenítéshez → Not enough memories to render the graph · Nincs naplóbejegyzés ezen a napon → No journal entries on this day
- pl. tegnap, múlt héten… → e.g. yesterday, last week… · Keresés → Search
- Betöltés… → Loading… · Hiba történt → An error occurred · Nem sikerült betölteni → Could not load · Nem értelmezhető dátum: → Could not parse date:
- NN naplóbejegyzés → NN journal entries · NN emlék → NN memories · Ágensek: → Agents: · Kulcsszavak: → Keywords: · Nincs találat erre az időszakra. → No results for this period.
- Görgő: nagyítás | Húzás: csomópont mozgatása / Kattintás: részletek / Dupla kattintás: szerkesztés → Scroll: zoom | Drag: move nodes / Click: details / Dbl-click: edit
- NN kapcsolat → NN connections · Előző nap → Previous day · Következő nap → Next day · NN nap naplóval → NN days with a journal

The default UI language is Hungarian; English is the secondary locale. Dates and times display in the operator's locale/timezone (Hungarian formatting, Europe/Budapest) regardless of UI language. Reference **01-design.md** for all visual styling, theming (light/dark), tier colors, and motion.
