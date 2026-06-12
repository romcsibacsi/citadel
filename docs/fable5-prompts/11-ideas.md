# Fable 5 Build Prompt — Idea Box (Ötletláda) View

> CLEAN-ROOM NOTICE: This is an original behavioral and visual specification written from observation of an existing product's *behavior*. It contains no source code, identifiers, file names, or database schema from any prior implementation. Implement it from scratch in whatever stack you choose. For all visual styling (colors, spacing scale, typography, radii, shadows, badge palettes, pill borders) defer entirely to the design system document `01-design.md` — this document specifies STRUCTURE and BEHAVIOR, not pixels.

---

## 1) PURPOSE & WHERE IT LIVES

The Idea Box is the operator's **capture-and-triage inbox for development ideas, suggestions, and proposals**. It is the holding place where loose ideas land before they become real, tracked work. Both the human operator and the AI agents (especially the orchestrator) drop ideas here; the operator then triages each one — reviews it, rejects it, archives it, or **promotes it onto the Kanban board** where it becomes a tracked task. The view is deliberately lightweight: a grouped, filterable list of compact idea cards, a row of status counters, and two creation/triage modals. It is the opposite of the Kanban board — Kanban is committed work; the Idea Box is the proposal funnel that feeds it.

- **Navigation item.** Lives in the primary left navigation rail as a top-level entry, positioned in the lower/utility cluster of the rail (it sits near the secrets/vault entry and just before the system-updates entry in nav order).
- **Nav label:** HU `Ötletláda` / EN `Idea Box`.
- **Nav icon idea:** a thin-stroke "information/lightbulb-of-thought" glyph — a circle outline containing a short vertical stroke above a single dot (an "i"-in-a-circle / info mark, evoking a captured note or insight). Keep it a thin line icon consistent with the other rail icons. (A lightbulb outline is an equally acceptable alternative if your icon set has one — the concept is "an idea / a noted suggestion".)
- **Page title (H1):** HU `Ötletláda` / EN `Idea Box`.
- **One-line subtitle under the title:** HU `Fejlesztési ötletek és javaslatok` / EN `Development ideas and suggestions`.

---

## 2) PAGE LAYOUT & APPEARANCE

Structure only — see `01-design.md` for all styling.

The page is composed top-to-bottom of:

1. **Page header row** spanning the full width:
   - Left: the H1 title and the subtitle line, stacked.
   - Right (pushed to the far edge), a horizontal cluster of three controls, in this order:
     1. A **category filter dropdown** (narrow).
     2. A **status filter dropdown** (narrower).
     3. A **primary "new idea" button** (compact), with a leading `+` and a short label.

2. **A status-counter strip** directly below the header: a single horizontal row of small counter tiles, one per lifecycle status, that wraps to a second line on narrow widths. Each tile is a small bordered card showing a large number over a small caption. This strip reflects **global totals per status, independent of the active filters** (see §6).

3. **The idea list** filling the remaining vertical space: a single vertical column of **category-grouped sections**. Each section is a small uppercase category heading (a quiet, letter-spaced label) followed by that category's idea cards stacked tightly. Sections are ordered by the grouping that naturally falls out of the result order (newest-first within each category — see §6). The list area scrolls; the header and counter strip stay above it.

4. **Two modal overlays** owned by this page, hidden until invoked:
   - The **idea create/edit modal** (medium width).
   - The **promote-to-Kanban phase-picker modal** (narrow).
   - A **third, shared "breakdown proposal" modal** (defined once for the whole app and reused here) appears during the AI-breakdown promote flow.

There is no left/right split, no detail pane, and no inline expansion — every idea's full content is either visible on its card or opened in the edit modal.

---

## 3) CONTROLS — every button / field / dropdown / filter

All labels ship HU (default) + EN. Placeholders are HU with EN equivalents noted.

### Header controls

- **Category filter** (dropdown / `<select>`).
  - First/default option: HU `Összes kategória` / EN `All categories` (value = "no filter").
  - Remaining options are the **distinct categories that currently exist among ideas**, sorted alphabetically, populated dynamically each time the page loads. The dropdown preserves the operator's current selection across reloads if that category still exists.
  - Changing it re-loads the list scoped to that category. The counter strip does **not** change with this filter.

- **Status filter** (dropdown / `<select>`). Fixed option set, in this order:
  - HU `Aktív` / EN `Active` — the **default selection** (value = "active"); shows every non-archived idea regardless of its specific status.
  - HU `Új` / EN `New`.
  - HU `Átnézve` / EN `Reviewed`.
  - HU `Kanbanban` / EN `On Kanban`.
  - HU `Elutasítva` / EN `Rejected`.
  - HU `Archív` / EN `Archived`.
  - Changing it re-loads the list scoped to that status. The counter strip does **not** change with this filter.

- **New-idea button** (primary, compact). Label HU `+ Új ötlet` / EN `+ New idea`. Opens the create/edit modal in **create** mode.

There is **no free-text search field** and **no sort control** on this view.

### Create/Edit modal controls (see §5 for layout)

- **Title field** (single-line text input). Label HU `Cím *` / EN `Title *` (required, marked with an asterisk). Placeholder HU `Rövid, egyértelmű cím` / EN `Short, clear title`.
- **Description field** (multi-line textarea, ~4 rows). Label HU `Leírás` / EN `Description` (optional). Placeholder HU `Részletes leírás...` / EN `Detailed description...`.
- **Category dropdown** (`<select>`). Label HU `Kategória` / EN `Category`. A fixed seed list of options: HU `Sales` / `Oktatás` / `Automatizálás` / `Integráció` / `Rendszer` / `Egyéb` → EN `Sales` / `Education` / `Automation` / `Integration` / `System` / `Other`. There is no free-text "add new category" input on this modal — new categories enter the system only via the API (e.g. agent-created ideas), but they will then show up in the header category filter once they exist.
- **Cancel button** (secondary). Label HU `Mégse` / EN `Cancel`. Closes the modal without saving.
- **Save button** (primary, compact). Label HU `Mentés` / EN `Save`. Validates and persists (see §6).
- **Close "×"** in the modal header — same effect as Cancel.

### Promote phase-picker modal controls (see §5)

- **Detail-elaboration button** (secondary, left-aligned, full-width). Bold label HU `Részlet kidolgozás (Várakozik)` / EN `Detail elaboration (Waiting)`.
- **Plan button** (primary compact, left-aligned, full-width). Bold label HU `Terv (Tervezett)` / EN `Plan (Planned)`.
- **Cancel button** (secondary). Label HU `Mégse` / EN `Cancel`.
- **Close "×"** in the header — same effect as Cancel.

### Per-card action buttons

See §4 for which buttons appear on which card given its status. Each is a tiny compact button.

---

## 4) LISTS / CARDS — each item and EXACTLY what it shows

### The status-counter strip

Exactly **five** counter tiles, always in this fixed order, each showing a number and a caption. The number is colored per the status's accent (defer exact hues to `01-design.md`; the intent is: New = primary/accent color, Reviewed = amber/orange, On-Kanban = green, Rejected = red, Archived = muted grey).

| Order | Caption (HU / EN) | Counts |
|---|---|---|
| 1 | `Új` / `New` | ideas in "new" status |
| 2 | `Átnézve` / `Reviewed` | ideas in "reviewed" status |
| 3 | `Kanbanban` / `On Kanban` | ideas promoted to a Kanban card |
| 4 | `Elutasítva` / `Rejected` | rejected ideas |
| 5 | `Archív` / `Archived` | archived ideas |

These counts are **global** (every idea ever, active + archived), never narrowed by the active category or status filter. So the Archived tile always shows the true archived total even while the Active view is displayed.

### The idea list — grouping

Ideas are grouped under **category headings** (a quiet uppercase, letter-spaced label per category). Within a category the cards are ordered **newest-created first**. Empty state: see §7.

### The idea card

A compact horizontal card. Left side (flex-grow):

- **Row 1:** the idea **title** (semibold) followed immediately by a small **status pill** — a colored, thin-outlined pill whose text and border take the status's color, showing the status's HU/EN label (`Új`/`New`, `Átnézve`/`Reviewed`, `Kanbanban`/`On Kanban`, `Elutasítva`/`Rejected`, `Archív`/`Archived`).
- **Row 2 (only if a description exists):** the **description** in muted small text. Shown in full (not truncated to a fixed line count at the structural level; defer any clamp to `01-design.md`).

Right side (flex-shrink, right-aligned, wraps): the **per-card action buttons**, which depend on status:

**If the idea is ARCHIVED** — no action buttons. Instead a muted caption: HU `archiválva · <date>` / EN `archived · <date>`, where `<date>` is the archive date formatted in the locale (HU locale by default). If no archive timestamp is present, just `archiválva` / `archived`.

**For every NON-archived idea**, show the applicable subset of these buttons (left→right):

1. **Reviewed** — HU `Átnézve` / EN `Reviewed` (secondary, compact). Shown **only when** the idea is not already reviewed and not already on Kanban (i.e. for "new" and "rejected"). Sets status → reviewed.
2. **Reject** — HU `Elutasít` / EN `Reject` (secondary, compact, red text). Shown when the idea is not already rejected. Sets status → rejected.
3. **Re-open** — HU `Újra` / EN `Reopen` (secondary, compact). Shown **only when** the idea is currently reviewed or rejected. Sets status → new.
4. **Edit** — HU `Szerkeszt` / EN `Edit` (secondary, compact). Always shown (for non-archived). Opens the edit modal.
5. **To Kanban (AI)** — HU `Kanbanra (AI)` / EN `To Kanban (AI)` (primary, compact). Shown when the idea is **not** already on Kanban and **not** rejected. Triggers the AI-breakdown promote flow (§6).
6. **Archive** — HU `Archiválás` / EN `Archive` (secondary, compact). Always shown (for non-archived). Archives the idea.
7. **Delete** — HU `Töröl` / EN `Delete` (secondary, compact, red text). Always shown (for non-archived). Permanently deletes the idea (with confirm).

Notes:
- A "new" idea shows: Reviewed, Reject, Edit, To-Kanban(AI), Archive, Delete.
- A "reviewed" idea shows: Reject, Reopen, Edit, To-Kanban(AI), Archive, Delete.
- A "rejected" idea shows: Reviewed, Reopen, Edit, Archive, Delete (no To-Kanban).
- An "on-Kanban" idea shows: Reject, Edit, Archive, Delete (no Reviewed, no To-Kanban — it is already on the board).
- An "archived" idea shows only the muted "archived · date" caption.

There is **no per-card overflow/kebab menu** — all actions are inline buttons. There is **no direct "simple promote" button on the card**; the only promote affordance on the card is the AI-breakdown one. (A simpler phase-picker promote modal also exists in the system and is wired to a `promote-to-kanban` capability — see §5 and §6 — and may be surfaced from the card if you choose; in the observed product the card's promote affordance is the AI path.)

---

## 5) OPENED MODALS / DETAIL PANES — full contents

### A) Create / Edit Idea modal

Medium width. Header shows a title that switches by mode:
- Create mode title: HU `Új ötlet` / EN `New idea`.
- Edit mode title: HU `Ötlet szerkesztése` / EN `Edit idea`.

Header also has a close "×".

Body (vertical stack):
1. **Title field** (`Cím *` / `Title *`) — required.
2. **Description textarea** (`Leírás` / `Description`).
3. **Category dropdown** (`Kategória` / `Category`) on its own row.

Footer (right-aligned): **Cancel** (`Mégse`/`Cancel`) and **Save** (`Mentés`/`Save`).

Behavior:
- In **create** mode the fields open blank (description and title cleared; category at its first option).
- In **edit** mode the fields are pre-filled from the selected idea (title, description, the idea's current category selected). Status and source are **not** editable in this modal.

### B) Promote-to-Kanban phase picker modal

Narrow. Header: HU `Kanbanba küldés` / EN `Send to Kanban`, plus a close "×".

Body:
- A short prompt line: HU `Melyik fázisban?` / EN `In which phase?`.
- Two stacked, left-aligned, full-width choice buttons:
  - **Detail elaboration** — bold HU `Részlet kidolgozás (Várakozik)` / EN `Detail elaboration (Waiting)`. Creates a Kanban card in the **"waiting"** column, titled with a "[detail elaboration]" prefix before the idea title (the card is a placeholder asking the team to flesh the idea out).
  - **Plan** — bold HU `Terv (Tervezett)` / EN `Plan (Planned)`. Creates a Kanban card in the **"planned"** column, titled exactly with the idea title (the idea is ready to be planned as-is).

Footer (right-aligned): **Cancel** (`Mégse`/`Cancel`).

### C) Breakdown proposal modal (shared, reused for AI promote)

This is the same modal the Kanban board uses for AI subtask breakdown; the Idea Box reuses it. Header: HU `Breakdown javaslat` / EN `Breakdown proposal`, plus a close "×".

Body:
- A muted context line naming the **parent**: HU `Szülő: <idea title>` / EN `Parent: <idea title>`.
- A **list of proposed subtasks**, one editable row each. Each row contains:
  - A small ordinal label (`1.`, `2.`, …).
  - An **editable title input** pre-filled with the suggested subtask title.
  - An **"include" checkbox** labeled HU `Bele` / EN `Include`, checked by default — unchecking excludes that subtask from creation.
  - On a second line: an **assignee dropdown** (first option HU `-- nincs --` / EN `-- none --`, then the roster of agents by display name), pre-selected to the AI's suggested assignee; and a **priority badge** (read-only pill) showing the suggested priority with HU/EN labels (`Alacsony`/`Low`, `Normál`/`Normal`, `Magas`/`High`, `Sürgős`/`Urgent`).
- Footer: a primary **Create subtasks** button HU `Subtask-ok létrehozása` / EN `Create subtasks`, and a secondary **Cancel** HU `Mégse` / EN `Cancel`.

Behavior of the breakdown modal in the idea context: see §6 (it calls the idea promote-breakdown flow and creates a parent card + one child card per included subtask).

---

## 6) FLOWS & BEHAVIOR — step by step + API contract

All endpoints below are concept-level contracts (method + path + payload + effect), not source.

### Loading the page

On entering the view, the page issues **four reads in parallel**:
1. `GET /api/ideas?status=<statusFilter>&category=<categoryFilter>` → the **filtered list** that gets rendered.
2. `GET /api/ideas/categories` → the distinct category names, to (re)populate the category filter dropdown.
3. `GET /api/ideas?status=active` → all non-archived ideas (for counters).
4. `GET /api/ideas?status=archived` → all archived ideas (for counters).

It then renders: counters from (active + archived) totals; the category dropdown from (2), preserving the prior selection; and the grouped list from (1). Status semantics on `GET /api/ideas`: `status=archived` → only archived; `status=active` or omitted → everything except archived; any specific status value → exact match on that status. Results are ordered newest-created first.

### Create a new idea

`+ Új ötlet` opens the modal in create mode. **Save** validates that title is non-empty (if empty: show an error toast HU `Cím kötelező` / EN `Title required`, do not submit). On valid: `POST /api/ideas` with `{ title, description?, category, source: "manual", status: "new" }`. Server assigns a short id, defaults category to "Egyéb"/"Other" if absent, defaults source to "manual", status to "new". On success: close modal, reload the page.

### Edit an idea

`Szerkeszt`/`Edit` opens the modal pre-filled. **Save** → `PUT /api/ideas/<id>` with the changed `{ title, description?, category }`. Server returns 404 with message HU `Ötlet nem található` / EN `Idea not found` if the id is gone. On success: close modal, reload.

### Change status (Reviewed / Reject / Reopen)

Each of these inline buttons calls `PUT /api/ideas/<id>` with just `{ status: <new status> }`:
- Reviewed → `status: "reviewed"`.
- Reject → `status: "rejected"`.
- Reopen → `status: "new"`.
No confirmation dialog for these (they are reversible). On failure show a toast HU `Státusz mentés hiba` / EN `Status save failed`. On success: reload.

### Archive an idea (manual)

`Archiválás`/`Archive` → `POST /api/ideas/<id>/archive`. Server sets status → archived and stamps an archive timestamp (idempotent — archiving an already-archived idea is a no-op). The row is **preserved, never deleted**. On success: toast HU `Ötlet archiválva` / EN `Idea archived`, then reload. On failure: toast HU `Archiválás hiba` / EN `Archive failed`. No confirm dialog (archiving is reversible by editing/reopening; archived items remain visible under the Archived filter).

### Delete an idea (permanent)

`Töröl`/`Delete` → **first shows a native confirm** HU `Biztosan törlöd?` / EN `Are you sure you want to delete?`. Only on confirm: `DELETE /api/ideas/<id>` (hard delete; 404 if already gone). On success: reload. This is the only destructive, non-recoverable action on the view.

### Simple promote (phase picker)

When invoked, the picker modal opens. Choosing **Detail elaboration** or **Plan** calls `POST /api/ideas/<id>/promote` with `{ phase: "detail" | "plan" }`. Server:
- Creates a new Kanban card under a fixed project named HU `Fejlesztési ötletek` / EN `Development ideas`, assigned to the orchestrator agent, normal priority, description copied from the idea.
- For `detail`: card status "waiting", title prefixed with a "[detail elaboration]" marker.
- For `plan`: card status "planned", title = idea title.
- Sets the idea's status → "kanban" and stores the **bidirectional link** (the idea now records the new card's id; the card lives under the ideas project). 
On success: toast HU `Kanban kártya létrehozva: <card id>` / EN `Kanban card created: <card id>`, then reload. The idea moves out of the Active list (now "On Kanban") and into the On-Kanban counter.

### AI breakdown promote ("To Kanban (AI)")

This is the richer promote path on the card. Steps:
1. If the agent/assignee roster hasn't been loaded yet (operator went straight here without visiting the board), fetch it via `GET /api/kanban/assignees` so the breakdown modal's assignee dropdown is populated; if that fails, the dropdown falls back to "none".
2. Show a progress toast HU `AI kidolgozza az ötletet...` / EN `AI is elaborating the idea...`.
3. `POST /api/ideas/<id>/breakdown` → server returns a **draft list of subtasks**. (Generation is deterministic, derived from the idea's description: the description is split into bullet/numbered/newline items, markers stripped, deduped, capped at a dozen, and each item heuristically routed to an agent by keyword; if the description has fewer than two splittable items, a single subtask is produced from the title.) On error or empty list, show a toast (`Breakdown hiba` / `Breakdown error`, or HU `Az AI nem adott vissza alfeladatot` / EN `The AI returned no subtasks`) and stop.
4. Open the **breakdown proposal modal** (§5C) seeded with those subtasks and the idea title as parent.
5. The operator edits titles, toggles include checkboxes, reassigns assignees. Pressing **Create subtasks** collects only the **included** rows; if none are included, toast HU `Válassz legalább egy alfeladatot` / EN `Select at least one subtask` and stop.
6. `POST /api/ideas/<id>/promote-breakdown` with `{ subtasks: [...] }`. Server creates **one parent Kanban card** (from the idea, status "planned", under the "Development ideas" project, assigned to the orchestrator) plus **one child card per included subtask** (each with its chosen assignee and priority, parented to the parent card). It then sets the idea → "kanban" with the **bidirectional link** to the parent card. Requires at least one subtask, else 400 HU `Legalább egy jóváhagyott alfeladat kötelező` / EN `At least one approved subtask is required`.
7. On success: close modal, toast HU `Kanbanra emelve: <n> alfeladat + szülő kártya` / EN `Promoted to Kanban: <n> subtasks + parent card`, then reload.

### Bidirectional link & done→archive auto-sweep

Promoting (either path) records the link **both ways**: the idea remembers its card; the card belongs to the ideas project. Two server-side hooks keep the idea lifecycle in sync with the board:
- **On card → done:** when any Kanban card transitions to the "done" column, the server looks up the idea linked to that card (reverse lookup by card id) and, if found and not already archived, **auto-archives that idea**. This is error-tolerant — the card move never fails even if the idea-archive step does. Effect: a completed task automatically clears its originating idea out of the Active list.
- **Reconcile-archived sweep:** `POST /api/ideas/reconcile-archived` archives, in one pass, **every non-archived idea whose linked card is already "done"** (a belt-and-suspenders backfill for ideas that predate the done hook or were missed). Returns the count archived. It is idempotent (a second run archives zero). This is a maintenance/first-use action; surface it as an optional admin control or run it implicitly on first load if you wish (the observed product exposes it as an endpoint rather than a prominent button).

### Live update behavior

The view does **not** poll. It reloads in full after every mutating action (create, edit, status change, archive, delete, both promote paths) and whenever a filter dropdown changes, and once on entering the page. There is no websocket/SSE stream for ideas. If you want freshness while the operator is idle on the page, a gentle periodic re-load is acceptable but is not required by the contract.

---

## 7) STATES

- **Empty list:** when the filtered query returns nothing, the list area shows a centered, muted, padded message HU `Nincs ötlet` / EN `No ideas`. (No illustration required; defer styling to `01-design.md`.) Counters still render their global totals.
- **Loading:** the four parallel fetches resolve quickly; show the page chrome immediately. A brief skeleton or simply rendering once data arrives is acceptable. The AI-breakdown path explicitly shows an in-flight toast while the server computes the breakdown.
- **Error (read):** if a fetch fails, the list/counters simply stay empty rather than crashing the page; the operator can change a filter to retry. (Defer to your stack's error toasting.)
- **Error (write):** every mutating action surfaces a short toast on failure with the HU/EN strings listed in §6; on success some actions toast a confirmation, others (status changes) just silently reload.
- **404 on a stale id:** edit/delete/archive/promote against a deleted idea return a not-found error (`Ötlet nem található` / `Idea not found`); the page reload then reflects the true state.
- **Permission denied:** see §8.

---

## 8) PERMISSIONS / VISIBILITY

The Idea Box is part of the operator's authenticated dashboard. All endpoints sit behind the same bearer-token auth as the rest of the dashboard API; an unauthenticated request is rejected. Concretely:

- **Operator (human) — full control.** Sees all ideas, can create/edit/change-status/archive/delete/promote. This is the only role that uses the UI.
- **Agents (programmatic) — capture, gated by autonomy.** Agents do not use this UI; they **write ideas via the API** (`POST /api/ideas` with `source` set to the agent's name, e.g. the orchestrator records ideas it judges worth the operator's attention). Whether an agent escalates an idea to the operator's attention is **gated by the system autonomy level** — at low autonomy an agent merely records the idea silently into the box; at higher autonomy (the system's "level ≥ 2" threshold) it may proactively surface/escalate it. This gating lives in the agent layer, not in this view — but the **Idea Box is the canonical sink** for agent-surfaced proposals, and the "source" field distinguishes operator-entered (`manual`) from agent-entered ideas (the orchestrator's name, scheduled-task names, etc.). You should preserve and display nothing role-sensitive beyond honoring the auth gate; there is no per-idea ACL.
- **Autonomy-category convention.** Agent-recorded ideas typically carry a generic idea category; because the category filter is populated from whatever categories exist, agent-introduced categories appear in the filter automatically. There is no separate "autonomy" UI on this page — the link is conceptual: this box is where the autonomy pipeline (and the scheduled "dream"/"team-sync" jobs) deposit their suggestions for human triage.

If the token is missing/invalid, treat it as a hard auth failure (the app's global behavior): redirect to login or show the app-level auth-error state rather than a per-view permission message.

---

## 9) DATA CONCEPTS read/written (concept level)

An **Idea** record carries:
- a short **id**;
- **title** (required);
- **description** (optional, free text);
- **category** (defaults to "Egyéb"/"Other");
- **status** — one of: new, reviewed, kanban, rejected, archived;
- **source** — who created it (`manual` for operator, or an agent/job name);
- **kanban_id** — the linked Kanban card id once promoted (the bidirectional link; null otherwise);
- **archived_at** — the archive timestamp (set when archived; null otherwise);
- **created_at / updated_at** timestamps.

Reads: the filtered idea list, the distinct category list, and the two unfiltered (active / archived) lists for counters. Writes: create idea; update idea (title/description/category/status/kanban link); archive idea; delete idea; promote (creates a Kanban card + sets status+link); breakdown (read-only draft generation) and promote-breakdown (creates parent+child cards + sets status+link); reconcile-archived (bulk status update). Promote and the done-hook also **write to the Kanban domain** (new cards) and read the agent/assignee roster.

Related concepts this view touches but does not own: **Kanban cards** (created by promote; the "Development ideas" project; the "waiting"/"planned"/"done" columns; parent/child cards), and the **agent roster** (assignee dropdown in the breakdown modal).

---

## 10) i18n — every string ships HU (default) + EN

| Context | HU (default) | EN |
|---|---|---|
| Nav label / page title | Ötletláda | Idea Box |
| Subtitle | Fejlesztési ötletek és javaslatok | Development ideas and suggestions |
| Category filter (all) | Összes kategória | All categories |
| Status filter: active | Aktív | Active |
| Status filter / pill: new | Új | New |
| Status filter / pill: reviewed | Átnézve | Reviewed |
| Status filter / pill: kanban | Kanbanban | On Kanban |
| Status filter / pill: rejected | Elutasítva | Rejected |
| Status filter / pill: archived | Archív | Archived |
| New-idea button | + Új ötlet | + New idea |
| Counter captions | Új / Átnézve / Kanbanban / Elutasítva / Archív | New / Reviewed / On Kanban / Rejected / Archived |
| Empty list | Nincs ötlet | No ideas |
| Card: archived caption | archiválva · <dátum> | archived · <date> |
| Card btn: reviewed | Átnézve | Reviewed |
| Card btn: reject | Elutasít | Reject |
| Card btn: reopen | Újra | Reopen |
| Card btn: edit | Szerkeszt | Edit |
| Card btn: to-kanban AI | Kanbanra (AI) | To Kanban (AI) |
| Card btn: archive | Archiválás | Archive |
| Card btn: delete | Töröl | Delete |
| Modal title: create | Új ötlet | New idea |
| Modal title: edit | Ötlet szerkesztése | Edit idea |
| Field: title (req) | Cím * | Title * |
| Title placeholder | Rövid, egyértelmű cím | Short, clear title |
| Field: description | Leírás | Description |
| Description placeholder | Részletes leírás... | Detailed description... |
| Field: category | Kategória | Category |
| Category options | Sales / Oktatás / Automatizálás / Integráció / Rendszer / Egyéb | Sales / Education / Automation / Integration / System / Other |
| Modal btn: cancel | Mégse | Cancel |
| Modal btn: save | Mentés | Save |
| Promote modal title | Kanbanba küldés | Send to Kanban |
| Promote prompt | Melyik fázisban? | In which phase? |
| Promote: detail | Részlet kidolgozás (Várakozik) | Detail elaboration (Waiting) |
| Promote: plan | Terv (Tervezett) | Plan (Planned) |
| Breakdown modal title | Breakdown javaslat | Breakdown proposal |
| Breakdown parent line | Szülő: <cím> | Parent: <title> |
| Breakdown include checkbox | Bele | Include |
| Breakdown assignee none | -- nincs -- | -- none -- |
| Priority labels | Alacsony / Normál / Magas / Sürgős | Low / Normal / High / Urgent |
| Breakdown accept | Subtask-ok létrehozása | Create subtasks |
| Toast: title required | Cím kötelező | Title required |
| Toast: status save fail | Státusz mentés hiba | Status save failed |
| Toast: archived ok | Ötlet archiválva | Idea archived |
| Toast: archive fail | Archiválás hiba | Archive failed |
| Confirm: delete | Biztosan törlöd? | Are you sure you want to delete? |
| Toast: kanban created | Kanban kártya létrehozva: <id> | Kanban card created: <id> |
| Toast: AI elaborating | AI kidolgozza az ötletet... | AI is elaborating the idea... |
| Toast: no subtasks (AI) | Az AI nem adott vissza alfeladatot | The AI returned no subtasks |
| Toast: breakdown error | Breakdown hiba | Breakdown error |
| Toast: pick a subtask | Válassz legalább egy alfeladatot | Select at least one subtask |
| Toast: promoted (n) | Kanbanra emelve: <n> alfeladat + szülő kártya | Promoted to Kanban: <n> subtasks + parent card |
| Error: not found | Ötlet nem található | Idea not found |
| Error: need one subtask | Legalább egy jóváhagyott alfeladat kötelező | At least one approved subtask is required |
| Project name (created cards) | Fejlesztési ötletek | Development ideas |

HU is the default UI language; EN is the alternate. Numbers/dates use the HU locale by default.

---

## Implementation notes (non-binding)

- The counter strip's "global, filter-independent" rule is the one subtle bit: compute it from two unfiltered reads (active + archived), not from the visible list.
- The category dropdown is data-driven — never hardcode it (except the create modal's seed list).
- Keep destructive vs. reversible actions distinct: only **Delete** confirms and is irreversible; archive/reject/review are quiet and recoverable.
- The breakdown modal is shared infrastructure — build it once and parameterize it by "mode" (idea vs. board) so the accept button targets the right endpoint.
- All look-and-feel (counter tile styling, pill colors, button sizes, modal chrome) defers to `01-design.md`.
