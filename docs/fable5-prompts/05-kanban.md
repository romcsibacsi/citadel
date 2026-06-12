# Build Prompt — Kanban View

> **CLEAN-ROOM NOTICE (read first).** This document is an original behavioral and visual
> specification written for an engineer ("Fable 5") who has never seen the reference product.
> It describes **what the screen looks like and does** — regions, controls, fields, flows,
> states — not how any existing code is written. Implement it from scratch in whatever stack
> you choose. Do not seek out, copy, or reproduce any pre-existing source code, identifiers,
> file names, route strings, or database schema. Where an HTTP path or field name appears
> below, treat it as a **suggested contract you may rename**, not as a literal to be copied.
> All visual styling (colors, spacing scale, typography, radii, shadows, motion) is defined
> in **`01-design.md`** — this document references that design system and never restates it.

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** The Kanban view is the operator's single shared work board. It is where the
human operator and the AI agents see, create, assign, prioritize, discuss, approve, and
retire tasks. Every real piece of delegated work shows up here as a **card** that moves
left-to-right across four lifecycle columns. The board is the visible contract between the
operator and the agent team: when the operator drags a card into "in progress," the system
wakes the assigned agent; when an agent finishes, the card lands in "done." It also doubles
as the approval queue: cards that an agent has parked on the operator's decision surface a
prominent badge here and in the sidebar.

**Navigation placement.** Second item in the primary left sidebar navigation, directly under
the dashboard/overview item.

- **Icon idea:** three vertical bars of descending height side by side — a minimal "board
  columns" glyph (think a tiny bar chart / column stack), rendered as a stroked line icon
  consistent with the rest of the sidebar iconography in `01-design.md`.
- **Nav label:** HU `Kanban` / EN `Kanban`.
- **Sidebar badge:** a small numeric pill attached to this nav item showing the count of
  cards awaiting operator approval (see §5.6 and §6.7). Hidden when the count is zero.
- **One-line subtitle (page header tagline):**
  - HU: `Megosztott munkatábla — feladatok, felelősök, jóváhagyások.`
  - EN: `Shared work board — tasks, owners, approvals.`

---

## 2) PAGE LAYOUT & APPEARANCE

> Structure only. All look-and-feel (palette, type ramp, spacing tokens, card elevation,
> drag affordances) lives in `01-design.md`.

Top to bottom, the page has three stacked regions:

1. **Toolbar row** (single horizontal strip across the top).
   Left-aligned group: a "Project" label + a project filter dropdown, then a "Assignee" label
   + an assignee filter dropdown, then an owner quick-filter toggle button ("Waiting on me").
   Right-aligned (pushed to the far end of the row): an "Archive" toggle button.

2. **Board region** (the default view). A horizontal row of **four equal columns** laid out
   left → right in fixed lifecycle order:
   1. Planned
   2. In progress
   3. Waiting
   4. Done

   Each column is a vertical panel with a **column header** (title text + a live count chip +,
   on the first three columns only, a small "+" add-card button) and a scrollable **column
   body** that holds the card tiles stacked vertically. Cards are the only content inside a
   body. The board should remain usable on a wide desktop screen; columns may scroll
   independently. (The "Done" column has **no** add button — you only reach Done by finishing
   work, not by creating a card there.)

3. **Archive list region** (alternate view, mutually exclusive with the board). A single
   vertical list of compact rows. When the archive view is active, the board region is hidden
   and this list is shown; toggling back hides the list and re-shows the board.

Three modal dialogs overlay the page when invoked (each centered, dimmed backdrop, close-on-
backdrop-click and close-on-Escape): the **New/Edit Card** modal, the **Card Detail** modal,
and the **Breakdown** modal. See §5.

---

## 3) CONTROLS (every interactive element, HU + EN)

### Toolbar
- **Project filter** — dropdown.
  - Label: HU `Projekt:` / EN `Project:`
  - First option always: HU `Mind` / EN `All` (value = no filter).
  - Remaining options are the distinct project names currently in use on the board, populated
    dynamically. Selecting one filters the board to cards in that project; selecting "All"
    clears it. If the previously selected project disappears from the list, the filter falls
    back to "All".
- **Assignee filter** — dropdown.
  - Label: HU `Felelős:` / EN `Assignee:`
  - First option always: HU `Mind` / EN `All`.
  - Remaining options are every known assignee (operator, the system/bot identity, and each
    agent), shown by display name. Filtering is **case-insensitive** against the card's stored
    assignee, so a casing mismatch still matches. Selecting filters the board to that
    assignee's cards.
- **Owner quick toggle** — button (a one-click "show only what's on me").
  - Label: HU `👤 Rám vár` / EN `👤 Waiting on me`
  - Tooltip: HU `Csak a rám (a tábla felelőse) váró kártyák` / EN `Only cards waiting on me
    (the board owner)`.
  - Toggles the assignee filter to the board's **owner identity** (the assignee whose type is
    "owner") and back off. It visually shows pressed/active state when on, and keeps the
    assignee dropdown in sync. **This button is hidden entirely if no owner-type assignee
    exists** in the current assignee list.
- **Archive toggle** — button, pushed to the far right of the toolbar.
  - Label when on the live board: HU `Archív` / EN `Archive`.
  - Label when already in the archive view: HU `← Aktív tábla` / EN `← Active board`.
  - Switches between the live board and the archived-cards list (§5.7).

### Column headers
- **Column title** — static text per column (see §4 for the four labels).
- **Column count chip** — read-only number; live count of cards currently shown in that
  column after filters.
- **Add card "+"** — button on the Planned, In-progress, and Waiting column headers only.
  - Tooltip: HU `Új kártya` / EN `New card`.
  - Opens the New Card modal pre-set to that column's status (§5.1).

### Card tile (inline controls)
- **Whole tile** — clickable; opens the Card Detail modal (§5.3).
- **Tile is draggable** — drag to any column to change status / reorder (§6.2).
- **Approve / Reject buttons** — appear inline on a tile **only** when that card is flagged as
  needing operator approval (§4, §6.7):
  - Approve: HU `✓ Jóváhagyom` / EN `✓ Approve`.
  - Reject: HU `✗` (icon only) / EN `✗`, tooltip HU `Elutasítom` / EN `Reject`.
  - These stop the click from also opening the detail modal.
- **Subtask badge** — appears on a tile when the card has child cards; clicking it opens the
  parent card's detail (§4).

### New/Edit Card modal — see §5.1 for field list.
### Card Detail modal — see §5.3 for buttons.
### Breakdown modal — see §5.5 for buttons.

---

## 4) LISTS / CARDS / TABLES

### 4a) Card tile (board)
Each card tile, top to bottom, shows:
- **Project tag** (only if the card has a project) — a small chip with the project name, at the
  top of the tile.
- **Title row** — the card's running sequence number as a small monospace `#N` prefix (if the
  card has one), followed by the card title text.
- **Footer row**, containing in order:
  - **Approval badge** (only if the card needs approval) — a prominent warning chip:
    HU `⚠ jóváhagyás` / EN `⚠ approval`, tooltip HU `Operátori jóváhagyásra vár` / EN
    `Awaiting operator approval`.
  - **Assignee chip** (only if an assignee is set) — a small colored "dot" containing the
    first letter of the assignee's display name, followed by the display name. The dot's color
    encodes the assignee **type** (owner / bot / agent / unknown) per `01-design.md`. If the
    stored assignee is not found in the known list, still render a fallback chip with the raw
    name and a neutral "unknown" dot — a card must never silently lose its assignee chip.
  - **Due-date chip** (only if a due date is set) — short month/day label. If the due date is
    in the past **and** the card is not in Done, render it in the "overdue" emphasis style.
- **Approve/Reject action row** (only if the card needs approval) — the two inline buttons
  from §3.
- **Subtask badge** — hidden by default; if the card has children it shows
  HU `{N} subtask` / EN `{N} subtasks` and is clickable (opens detail). The count is fetched
  per-card asynchronously after the board renders.

Card **priority** is carried on the tile as a data attribute and surfaced via styling per
`01-design.md` (e.g., a colored left edge) — there is no separate priority text on the tile
itself.

Cards within a column are sorted by their stored sort order (the manual ordering set by drag).

### 4b) Column count chips
Four live counters, one per column, reflecting the number of cards visible in each column
after the project + assignee filters are applied.

### 4c) Archive list rows (archive view)
Each archived card is one compact horizontal row:
- Left/main block:
  - **Title** (bold).
  - **Meta line** (muted, smaller): the running number `#N`, the card's last status, the
    assignee (or an em dash if none), the archived date (localized), and the project name if
    any — separated by middots.
- Right side: a **Restore** button — HU `Visszaállítás` / EN `Restore` — returns the card to
  the active board (§6.9).

### 4d) Children/subtask list (inside Card Detail) — see §5.4.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

### 5.1) New / Edit Card modal
Shared modal used both for creating a new card and for editing an existing one. Title bar text:
- Create mode: HU `Új kártya` / EN `New card`.
- Edit mode: HU `Kártya szerkesztése` / EN `Edit card`.

Fields, in order:
1. **Title** — single-line text input. **Required.**
   - Label: HU `Cím` / EN `Title`.
   - Placeholder: HU `Feladat megnevezése` / EN `Task name`.
2. **Description** — multi-line text area (a few rows tall). Optional.
   - Label: HU `Leírás (opcionális)` / EN `Description (optional)`.
   - Placeholder: HU `Részletek, kontextus...` / EN `Details, context...`.
3. **Assignee** — dropdown (half-width, paired with Priority on one row).
   - Label: HU `Felelős` / EN `Assignee`.
   - First option: HU `-- Nincs --` / EN `-- None --` (unassigned).
   - Then one option per known assignee, shown by display name.
4. **Priority** — dropdown (half-width).
   - Label: HU `Prioritás` / EN `Priority`.
   - Options: HU `Alacsony` / `Normál` (default) / `Magas` / `Sürgős` —
     EN `Low` / `Normal` (default) / `High` / `Urgent`.
5. **Due date** — date picker (half-width, paired with Project). Optional.
   - Label: HU `Határidő (opcionális)` / EN `Due date (optional)`.
6. **Project** — single-line text input with an **autocomplete suggestion list** of existing
   project names (free text allowed; choosing a suggestion or typing a new name both work).
   Optional. (half-width)
   - Label: HU `Projekt (opcionális)` / EN `Project (optional)`.
   - Placeholder: an example project name, e.g. HU/EN `e.g. Dream Engine`.
7. Two **hidden** carry fields the form tracks internally: the id of the card being edited
   (empty in create mode) and the target status column (set when "+" was clicked).
8. **Save button** at the bottom.
   - Label: HU `Mentés` / EN `Save`; busy state shows a spinner + HU `Mentés...` / EN
     `Saving...`.

Behavior: opening for **create** clears all fields, sets priority to Normal, focuses the
Title field, and remembers the originating column. Opening for **edit** (from the detail
modal's Edit button) pre-fills every field from the card and remembers the card id + current
status. Save with an empty title does nothing but re-focus Title. See §6.1.

### 5.2) (reserved — no separate pane)

### 5.3) Card Detail modal
Opened by clicking a card tile (or its subtask badge). Title bar: the card's running number
prefix `#N` (if any) followed by the card title.

Contents top to bottom:

**A. Meta grid** — a labeled key/value grid with six items:
- **Identifier** — HU `Azonosító` / EN `ID`: shows the running number and the stable short
  hex id together (monospace), with a tooltip explaining "running number · hex id".
- **Status** — HU `Állapot` / EN `Status`: localized status label
  (Planned / In progress / Waiting / Done).
- **Assignee** — HU `Felelős` / EN `Assignee`: the assignee's display name, or HU `-- nincs --`
  / EN `-- none --`. **This value is inline-editable** — clicking it swaps in a dropdown of all
  assignees (plus a "none" option); choosing a value saves immediately, updates the card, shows
  a toast, and refreshes the board. Tooltip: HU `Kattints a módosításhoz` / EN `Click to edit`.
- **Priority** — HU `Prioritás` / EN `Priority`: localized priority label.
- **Project** — HU `Projekt` / EN `Project`: the project name, or "-- none --".
- **Due date** — HU `Határidő` / EN `Due date`: localized date, or "-- none --".

**B. Description block** — the card's full description text (read-only here; edited via the
Edit button → the New/Edit modal).

**C. Comments section** — HU `Megjegyzések` / EN `Comments`:
- A scrollable list of existing comments, newest handling per `01-design.md`. Each comment row
  shows the **author name**, the **timestamp** (localized date+time), and the **comment body**.
- A **comment composer** below the list:
  - A text area. Placeholder: HU `Megjegyzés írása...` / EN `Write a comment...`.
  - An **author select** with label HU `Komment szerzője:` / EN `Comment author:`. It is
    pre-defaulted to the system/bot identity (resolved by type, never a hard-coded name), or
    the first assignee if no bot exists. Tooltip explains the author can be changed and that
    the card's responsible person appears at the top.
  - A **Send** button: HU `Küldés` / EN `Send`.

**D. Subtasks section** (HU `Subtask-ok` / EN `Subtasks`) — **shown only if the card has
children**. A list of child cards; see §5.4.

**E. Action row** at the bottom, three buttons:
- **Edit** — HU `Szerkesztés` / EN `Edit`: closes detail, opens the New/Edit modal in edit
  mode (§5.1).
- **Archive** — HU `Archiválás` / EN `Archive`: archives the card (§6.8).
- **Delete** — HU `Törlés` / EN `Delete`: destructive, danger-styled (§6.10).

### 5.4) Subtasks (children) list inside Card Detail
Each child row shows:
- **Title** (bold) + the child's **status** as a short localized tag in brackets
  (Planned / In progress / Waiting (short: `Vár`) / Done).
- A muted sub-line: the child's assignee (if any) and a truncated snippet of its description
  (roughly the first ~80 characters).
- The whole row is **clickable**: it closes the current detail and opens the child card's own
  detail modal (drill-down navigation between parent and children).

### 5.5) Breakdown modal
A modal for reviewing and accepting an **auto-suggested breakdown** of a parent task into
subtasks (the suggestions are produced upstream — e.g., by an agent — and handed to this modal;
the modal is the operator's accept/edit/reject gate). The same modal is reused by the Idea-box
"promote to board" flow; in this view it is used in **kanban** mode for a parent card.

Title bar: HU `Breakdown javaslat` / EN `Breakdown proposal`.

Contents:
- A muted context line naming the parent: HU `Szülő: {parent title}` / EN `Parent: {parent
  title}`.
- A list of proposed subtask rows. Each row contains:
  - An ordinal number (1., 2., …).
  - An **editable title** text input pre-filled with the proposed title.
  - An **"include" checkbox**, checked by default — HU `Bele` / EN `Include` — so the operator
    can drop individual subtasks before creating.
  - An **assignee dropdown** (none + all assignees), pre-selected to the proposed assignee.
  - A **priority badge** showing the proposed priority (localized), styled per `01-design.md`.
- Action row:
  - **Create subtasks** — HU `Subtask-ok létrehozása` / EN `Create subtasks` (primary).
  - **Cancel** — HU `Mégse` / EN `Cancel`.

Behavior: on accept, only the checked rows are submitted, using the (possibly edited) title and
chosen assignee, plus the proposed priority and description. Each becomes a **child card of the
parent**, inheriting the parent's project. A summary comment is added to the parent recording
how many subtasks were created and their ids. On cancel/reject, the modal closes with a toast
HU `Breakdown elvetve` / EN `Breakdown discarded`. See §6.6.

### 5.6) Sidebar approval badge
Not a modal, but a persistent UI element: the numeric pill on the Kanban nav item. Shows the
count of cards currently awaiting operator approval; hidden at zero. See §6.7 + §7.

### 5.7) Archive view
Toggled from the toolbar. Replaces the board with the archive list (§4c). If there are no
archived cards, show an empty-state message centered in the region: HU `Nincs archivált kártya`
/ EN `No archived cards`. Each row offers Restore (§6.9).

---

## 6) FLOWS & BEHAVIOR (action → contract → effect)

> Endpoint paths below are a **suggested** REST contract; rename freely. Behavior/effect is the
> binding part.

### 6.0) Initial load
On entering the view (live board): fetch the active cards, the assignee list, and the project
list in parallel, then populate the project filter, the project autocomplete suggestions, and
the assignee filter, then render the board.
- Cards: `GET /api/kanban` → array of active cards.
- Assignees: `GET /api/kanban/assignees` → list of `{ name, type, displayName }`, where type ∈
  {owner, bot, agent}. The owner entry uses a neutral fallback label (e.g. "Operator") if no
  explicit owner name is configured, so the option is never blank.
- Projects: `GET /api/kanban-projects` → array of distinct project name strings.

### 6.1) Create / edit a card
- **Create:** `POST /api/kanban` with title (required), description, assignee, priority,
  project, due date (as a timestamp), and the chosen status column. Server assigns a short id
  (and a running sequence number). On success: toast HU `Kártya létrehozva` / EN `Card
  created`, close modal, reload board.
- **Edit:** `PUT /api/kanban/{id}` with the updated fields. On success: toast HU `Kártya
  frissítve` / EN `Card updated`, close modal, reload board. 404 → error toast.
- On any save error, show a toast HU `Hiba a mentés során: {msg}` / EN `Save error: {msg}`.

### 6.2) Drag a card (move / reorder / dispatch)
Cards are draggable between and within columns with a live insertion indicator. On drop:
`POST /api/kanban/{id}/move` with the new status and the computed sort order (its index in the
target column). On success, reload the board.
- **Side effect — agent dispatch:** when a card enters **In progress**, the system wakes the
  card's assigned agent exactly once (a once-only dispatch; subsequent moves into in-progress
  do not re-fire). The wake routes a message to the responsible target telling it the card was
  moved to in-progress and to move it to Done when finished. Dispatch only fires if that agent
  is actually running; dispatch errors never block or fail the move.
- **Side effect — idea archive on done:** when a card enters **Done**, if it is linked to an
  idea-box entry, that idea is archived (preserved, not deleted) so the resolved idea leaves
  the active idea list. Errors here never block the move.
- On move failure: toast HU `Hiba az áthelyezés során` / EN `Error while moving`.

### 6.3) Filters
Project filter, assignee filter, and the owner quick-toggle each re-render the board client-
side from the already-loaded cards (no refetch needed). Assignee matching is case-insensitive.
The owner toggle flips the assignee filter to/from the owner identity and keeps the dropdown +
its own pressed state in sync.

### 6.4) Add a comment
From the detail modal: `POST /api/kanban/{id}/comments` with `{ author, content }`. Both are
required; empty content re-focuses the field, missing author shows a toast HU `Válassz szerzőt
a megjegyzéshez` / EN `Choose a comment author`. On success the composer clears and the detail
refreshes (showing the new comment). On HTTP error the textarea is **not** cleared and an error
toast is shown, so a failed comment is never silently "lost." Comments are append-only
(no edit/delete in this view).

### 6.5) Inline-edit assignee (detail meta)
Clicking the Assignee meta value swaps in a select; choosing a different value sends
`PUT /api/kanban/{id}` with the full card plus the new assignee. On success: update the card,
toast HU `Felelős frissítve` / EN `Assignee updated`, refresh the board. On failure: revert the
displayed value and toast HU `Hiba a mentésnél` / EN `Save error`. Selecting the same value is a
no-op.

### 6.6) Accept a breakdown
`POST /api/kanban/{id}/breakdown/accept` with the list of accepted subtasks (title, assignee,
priority, description). Server creates them as children of the parent (inheriting the parent's
project) in one transaction and appends a summary comment to the parent. On success: toast
HU `{N} subtask létrehozva` / EN `{N} subtasks created`, close both the breakdown and the detail
modals, reload the board. Empty selection → toast HU `Válassz legalább egy alfeladatot` /
EN `Select at least one subtask`.

### 6.7) Approve / reject a card (needs-approval gate)
A card flagged as needing approval shows the inline Approve/Reject buttons (and the badge).
- Approve: `POST /api/kanban/{id}/approve`. Reject: `POST /api/kanban/{id}/reject`.
- Effect of either: the "needs approval" flag is **lowered** (so the badge clears), a comment
  is recorded noting who decided and when (HU `✓ Jóváhagyva (dashboard).` /
  `✗ Elutasítva (dashboard).`), and a signal is sent to the orchestrator agent so it can
  continue or stop. **Important contract:** the button only lowers the flag and signals — it
  does **not** itself start the (potentially dangerous) work; the responsible agent/orchestrator
  does that. After the decision, reload the board and refresh the approval badge count.
- Creating or updating a card **into** the needs-approval state also fires a one-shot operator
  notification ("Awaiting approval: …") — only on the false→true transition, not on every save.

### 6.8) Archive a card
From the detail modal: `POST /api/kanban/{id}/archive`. On success: close detail, toast
HU `Kártya archiválva` / EN `Card archived`, reload board. The card leaves the active board and
appears in the archive list.

### 6.9) Restore an archived card
From an archive row: `POST /api/kanban/{id}/unarchive`. On success: toast HU `Kártya
visszaállítva` / EN `Card restored`, reload (still in archive view, which will now omit it).
404 → error toast.

### 6.10) Delete a card — **destructive, requires confirmation**
From the detail modal: first show a native confirm prompt HU `Biztosan törlöd ezt a kártyát?` /
EN `Delete this card permanently?`. Only on confirm: `DELETE /api/kanban/{id}`. On success:
close detail, toast HU `Kártya törölve` / EN `Card deleted`, reload board. This is irreversible
(unlike archive). Archive should be presented as the safe default; delete is the danger action.

### 6.11) Toggle archive view
Flip between the live board and the archive list. Entering archive fetches
`GET /api/kanban?archived=true`; leaving it re-fetches the live board.

---

## 7) STATES

- **Loading:** the board fetches its three data sources on entry; render once they resolve.
  Subtask badges and approval counts are fetched lazily/asynchronously after the initial render
  (the board should never block on them).
- **Empty board:** columns simply render with no tiles and a count of `0`. (No special empty
  illustration is required on the board itself.)
- **Empty archive:** centered message HU `Nincs archivált kártya` / EN `No archived cards`.
- **Error (fetch failure):** log and degrade gracefully — keep the last good render rather than
  blanking the board; per-card badge fetch failures are silently ignored. User-facing failures
  for actions surface as toasts (see each flow).
- **Live update / polling:** the **approval badge** count is polled on a periodic timer
  (about once a minute) and also refreshed immediately after any approve/reject. The board
  itself reloads after each mutating action (create/edit/move/comment/archive/restore/delete/
  breakdown). There is no continuous board push; reloads are action-driven.
- **404 on a mutating action:** show a "card not found" error toast (HU `Kártya nem található`
  / EN `Card not found`).

---

## 8) PERMISSIONS / VISIBILITY

- The board is the **operator's** primary surface and a **shared** surface with agents. The
  operator can create, edit, move, comment, assign, approve/reject, archive, restore, delete,
  and accept breakdowns.
- **Approval gating is the key trust boundary:** an agent that wants to do something risky parks
  the card in the needs-approval state instead of proceeding. Only the operator's approve/reject
  here clears that flag and signals the agent to continue or stop. The agent never self-approves;
  approving here does not itself execute the risky work — it only authorizes the responsible
  agent to.
- **Dispatch is autonomy/availability gated:** moving a card to in-progress wakes the assigned
  agent only if that agent is actually running; it is a once-only nudge and never escalates
  privilege.
- The **owner identity** is determined by assignee *type* (the "owner" entry), never by a
  hard-coded name, so the "Waiting on me" quick filter and owner concept work on any deployment;
  if there is no owner-type assignee the quick toggle is hidden.
- Comment authorship is selectable (operator, bot, or any agent) so multi-party discussion on a
  card is faithfully attributed.

---

## 9) DATA CONCEPTS (concept level — read/written by this view)

- **Card:** id (short stable hex), running sequence number, title, description, status
  (planned | in_progress | waiting | done), assignee (free string matched to the assignee
  roster), priority (low | normal | high | urgent), project (free-text label), due date
  (timestamp), sort order within column, needs-approval flag, optional parent-card reference
  (for subtasks), archived state + archived timestamp, a once-only "dispatched" marker, and an
  optional link to an originating idea.
- **Comment:** belongs to a card; author, content, created timestamp. Append-only.
- **Assignee roster entry:** name, type (owner | bot | agent), display name.
- **Project:** simply the distinct set of project labels in use across cards.
- **Approval count:** derived — the number of active cards with the needs-approval flag set.
- **Subtask/child relationship:** a card may have child cards (parent reference); children
  inherit the parent's project on creation via breakdown.

This view **reads** cards (active + archived), assignees, projects, comments, child cards, and
the approval count. It **writes** cards (create/edit/move/assign/approve/reject/archive/
unarchive/delete), comments (append), and child cards (via breakdown accept). Moving to
in-progress and to done trigger the dispatch and idea-archive side effects respectively.

---

## 10) i18n

All user-facing strings ship in **Hungarian (default)** and **English**, including: the nav
label and subtitle, all four column titles, every toolbar label/placeholder, all form field
labels/placeholders/hints, all dropdown option labels (priority, status, assignee "none"),
all modal titles and buttons, every toast and confirmation, the empty-state messages, the
approval badge tooltip, and the meta-grid labels. Status and priority values are stored
language-neutral and **localized only at render time** via label maps (e.g. `in_progress` →
HU `Folyamatban` / EN `In progress`; `urgent` → HU `Sürgős` / EN `Urgent`). Dates/times are
formatted with the active locale. The defaults shown throughout this document are the Hungarian
strings; provide the English equivalents alongside each.
