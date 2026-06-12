# Fable 5 Build Prompt — Autonomy (Autonómia) View

> **CLEAN-ROOM NOTICE.** This is an original behavioral + visual specification written for an engineer ("Fable 5") who has never seen the reference product. Implement it from scratch. Do not seek, request, or reproduce any source code, identifiers, file names, or database schema from any prior system. Everything below describes *what the view does and looks like* (facts, behavior, appearance) — never *how it was coded*. For all colors, spacing, typography, radii, shadows, and theme tokens, defer to `01-design.md`.

---

## 1) PURPOSE & WHERE IT LIVES

**What this view is for.**
This is the operator's single control panel for tuning **how much initiative the assistant system is allowed to take on its own**, broken down by *category of action*. Think of it as a per-category "trust dial." Each category of autonomous activity (e.g. tidying the task board, retrying a failed deploy, sending an email) has a trust **level** from **1 to 3**. Level 1 means the system may only *notice and report*; level 2 means it may *propose and wait for approval*; level 3 means it may *act autonomously and report afterward*. The operator sets each dial here.

Crucially, certain high-consequence categories (publishing content, money movement, deleting data, changing permissions/sharing, sending external messages) are **hard-locked at level 1 by a code-enforced safety constraint** — the UI shows them as permanently locked and they cannot be raised, no matter what is sent to the server. Other categories may carry a softer **cap** (a maximum level below 3) that is allowed but limits how high the dial can go.

This view is also the *policy source* that the background automation ("heartbeat") and the orchestrator consult before deciding whether to bother the operator. Raising a dial to level ≥ 2 is what permits the system to surface proposals/escalations to the operator for that category; below that, the system records the item silently rather than pinging the operator.

**Where it lives.**
- A primary left-sidebar navigation item labeled **"Autonómia" (Autonomy)**.
- **Icon idea:** a *shield* glyph (a security/guard shape) — it conveys "trust boundaries / safety." (The same shield motif is reused inside the page as the "capped" marker; a *padlock* glyph is reused for the hard-locked marker.)
- Clicking the nav item routes to the Autonomy page and immediately (re)loads the current configuration.

**Page title + subtitle (bilingual; HU is the default, EN is the alternate):**
- Title: **"Autonómia"** / "Autonomy"
- Subtitle: **"Heartbeat fokozatos autonómia szintek"** / "Heartbeat graduated autonomy levels"

---

## 2) PAGE LAYOUT & APPEARANCE

Structure only — visual styling lives in `01-design.md`.

Top to bottom, the page is composed of four stacked blocks inside the standard page container:

1. **Page header row.** Left side: the page title and subtitle (see §1). Right side, aligned to the far end of the same row: a single compact **secondary button** — "Frissítés" (Refresh) — with a circular-arrow / reload icon.

2. **Legend strip.** A horizontal bar (its own bordered card) explaining what the three levels mean. It contains three legend items laid out in a row, each with a small colored **dot** followed by a bold number and a short label:
   - dot in a *muted/neutral* color · **1** · "Csak jelez" (Notify only)
   - dot in the *accent* color · **2** · "Javasol, jóváhagyásra vár" (Proposes, waits for approval)
   - dot in the *success/green* color · **3** · "Autonóm, utólag jelent" (Autonomous, reports afterward)

3. **The ladder grid.** A vertical stack of **rows**, one per category. This is the heart of the view (the "autonomy ladder"). Rows are rendered dynamically from the loaded config; there is no static row markup. Each row is a bordered card; see §4 for the exact contents of a row.

4. **Footer line.** A single small muted line beneath the grid showing when the configuration was last changed (see §5/§7).

**Row visual variants (structure-level cues; exact colors in `01-design.md`):**
- A **normal** row (editable, no cap): full opacity, the three level buttons are interactive.
- A **capped** row (editable but max level < 3): carries a distinct **left edge accent stripe** and shows a small **"Max N. szint"** (Max level N) marker (shield icon) on the row; the level buttons above the cap are visibly de-emphasized and non-interactive.
- A **locked** row (hard safety lock): rendered **dimmed / lower opacity**, the whole row is non-interactive (no hover affordance, no clickable buttons), and it shows a **"Biztonsági zár"** (Safety lock) marker with a padlock icon.

---

## 3) CONTROLS — every interactive element

All labels ship in HU (default) + EN.

| Control | Type | HU label | EN label | What it does |
|---|---|---|---|---|
| Refresh | Secondary/compact button (circular-arrow icon) | **Frissítés** | Refresh | Re-fetches the autonomy configuration from the server and re-renders the grid + footer from scratch. |
| Level selector | A 3-segment button group **per category row** | buttons read **1**, **2**, **3** | 1, 2, 3 | A segmented "pill" control where exactly one segment is the active (selected) level. Clicking a *selectable* segment sets that category's level to that number (see §6). |

**Per-segment behavior inside a level selector:**
- The segment equal to the category's current level is rendered **active/filled** (color keyed to the level: 1 = neutral, 2 = accent, 3 = success — see legend).
- A segment **above the category's cap** (its number > the category's max level) is rendered **faded and disabled** ("over the cap" state); clicking does nothing.
- If the category is **hard-locked**, *every* segment is disabled and the whole row ignores pointer input — there is no way to click any level.
- Otherwise (selectable), clicking a segment immediately issues the change request.

There are **no** text inputs, dropdowns, free-text fields, search boxes, filters, or tabs on this view. The only inputs are the per-row level segments and the Refresh button. (No placeholders exist because there are no text fields.)

---

## 4) LISTS / CARDS — the ladder rows

The grid is a list of **category rows**. There is exactly one row per configured category. Each row shows, left to right:

1. **Category label** (HU text describing the action category; bold-ish, takes the flexible left portion of the row). Examples of the categories that exist (label text, HU / EN gloss):
   - **"7+ napos done kártya archiválás"** — Archive done cards older than 7 days
   - **"Beakadt task: assignee nudge (2 kör után eszkalál)"** — Stuck task: nudge the assignee (escalate after 2 rounds)
   - **"Memória rendberakás (vektorizálás, teszt-spam cold-ba)"** — Memory tidy-up (vectorize; move test-spam to cold storage)
   - **"Déli/reggeli rutin triviális javításai"** — Trivial fixes from the midday/morning routine
   - **"Elbukott deploy/CI újrapróbálkozás"** — Retry a failed deploy / CI
   - **"Kanban kártya átstrukturálás / sub-task bontás"** — Restructure a board card / split into sub-tasks
   - **"Skill-patch alkalmazás"** — Apply a skill patch
   - **"Email küldés / válasz"** — Send / reply to email *(this one is **capped at level 2**, not lockable to 3)*
   - **"Publikálás (Skool / blog / közösség)"** — Publish content (community / blog) *(**hard-locked, level 1**)*
   - **"Vásárlás / pénzmozgás"** — Purchase / money movement *(**hard-locked, level 1**)*
   - **"Fájl / adat törlés"** — File / data deletion *(**hard-locked, level 1**)*
   - **"Jogosultság-változtatás / megosztás"** — Permission change / sharing *(**hard-locked, level 1**)*
   - **"Külső üzenet küldés"** — Send an external message *(**hard-locked, level 1**)*

2. **A status marker** (conditional, sits between label and selector):
   - If the category is **hard-locked**: the padlock marker **"Biztonsági zár"** (Safety lock).
   - Else if the category is **capped** (max < 3 but not locked): the shield marker **"Max N. szint"** (Max level N), where N is the category's max level (e.g. "Max 2. szint").
   - Else: no marker.

3. **The level selector** (the 3-segment 1/2/3 group), right-aligned. Active segment = the category's current level. Segments above the cap are faded/disabled.

**Per-row actions / menus:** there is no kebab/overflow menu and no per-row detail link. The *only* action on a row is choosing a level via the selector. Editable rows respond to hover (subtle border emphasis); locked rows do not.

There are **no** tables and **no** nested expandable cards in this view. The "list item" is the row, and it is fully self-contained.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

This view has **no modals, no detail panes, no drawers, no expandable cards, and no confirmation dialogs.** Every interaction happens inline on the row. This is deliberate: setting a level is a single click with an immediate effect.

The only transient overlays are:
- **Toast/snackbar messages** (a brief, auto-dismissing notification at a corner of the screen) used to surface errors from a level change or a save failure. A toast appears, stays a few seconds, then fades. See §6 and §7 for exact messages.

The only persistent "informational" elements are:
- **The legend strip** (described in §2) — static explanatory content, not interactive.
- **The footer line** — shows last-modified time. Two forms:
  - When a modification timestamp exists: **"Utolsó módosítás: <localized date-time>"** (Last modified: …), formatted in Hungarian locale.
  - When no modification has ever been recorded: **"Még nem módosított"** (Not modified yet).

---

## 6) FLOWS & BEHAVIOR (behavior/contract — not code)

### Flow A — Load / open the page
1. The operator navigates to Autonomy (or clicks Refresh).
2. The view shows a transient loading line inside the grid area: **"Betöltés..."** (Loading…).
3. The view requests the current autonomy configuration from the backend: **GET `/api/autonomy`**.
   - **Contract:** returns the whole config object — a version number, a last-updated timestamp (epoch seconds), an optional documentation string, and an array of categories. Each category carries: a stable **key** (machine id), a **label** (display text), a current **level** (1–3), a **locked** flag (boolean), and a **maxLevel** (the cap, 1–3).
4. On success: the grid is cleared and one row is rendered per category (per §4), and the footer is set from the timestamp (per §5).
5. On failure / non-OK response: the grid is replaced with an error line (see §7) and the footer is cleared.

### Flow B — Change a category's level
1. The operator clicks a selectable level segment (a level ≤ the category's cap, on a non-locked row).
2. The view sends **POST `/api/autonomy`** with a body identifying the **category key** and the **target level** (a number 1–3).
3. **Backend validation & contract (in order):**
   - The level must be a number in **1–3**; otherwise the request is rejected as a bad request (the UI surfaces a generic error toast).
   - The category key must exist; otherwise *not found*.
   - If the category is **locked** and the requested level is **> 1**, the request is **refused** with a *forbidden* result and a message stating the category is locked at level 1 as a safety constraint. **This is the code-enforced hard lock — the server will not raise these categories even if the UI is bypassed.** (Locked categories: publish content, payment/money movement, data delete, permission change/sharing, external message.)
   - If the requested level **exceeds the category's cap (maxLevel)**, the request is rejected as a bad request with a message naming the max allowed level.
   - Otherwise the level is persisted, the config's last-updated timestamp is refreshed, and the server returns a success acknowledgement (echoing the key, the new level, and the new timestamp).
4. **On success:** the view simply **re-loads the whole config** (re-runs Flow A), so the newly-active segment and the updated footer timestamp appear. There is **no** optimistic in-place toggle; the source of truth is re-fetched.
5. **On any non-OK response:** the view shows a **toast** with the server's error message if present, otherwise a generic **"Hiba"** (Error). The dial visibly stays where it was (because the re-load was skipped on error).
6. **On a network/exception failure of the POST itself:** a toast reading **"Hiba a mentésnél"** (Error while saving).

**Confirmations / destructive actions:** none. Changing a level is reversible by clicking another level, so there is no confirm step. The *destructive* categories themselves are protected not by a confirm dialog but by being hard-locked at level 1 (you cannot arm them at all from this view).

### Flow C — How this gates operator-facing escalation (the downstream effect)
This view does not perform escalation itself; it **writes the policy** that other parts of the system read:
- Background automation and the orchestrator consult a category's level before acting.
- **Level 1** → the system may only *notice and record* the item (e.g. drop it into an idea/inbox feed); it must **not** ping/escalate to the operator.
- **Level 2** → the system may *propose* an action and **escalate to the operator for approval**; nothing happens until the operator approves.
- **Level 3** → the system may *act on its own* and merely **report afterward**.
- The rule of thumb the rest of the system follows: **operator-facing escalation is gated on level ≥ 2** for the relevant category; below that, record silently.
- Hard-locked categories (always level 1) therefore can **never** be performed autonomously and never trigger an approval-style escalation that would let the system act — they remain "notify only," which is the safety guarantee.

---

## 7) STATES

- **Loading:** while fetching, the grid shows a single muted line **"Betöltés..."** (Loading…). The Refresh button can be clicked again to re-trigger.
- **Empty:** if the config has zero categories, the grid simply renders nothing (no rows) and the footer reflects the timestamp state. (In practice the config always ships with the standard category set, so a truly empty grid indicates a config problem.)
- **Error (load failed / config missing):** the grid is replaced with an error line **"Nem sikerült betölteni az autonómia konfigot."** (Failed to load the autonomy config.) and the footer is cleared. The backend returns *not found* if the config is absent.
- **Error (save failed):** surfaced as a **toast** (see Flow B): the server's specific message, or **"Hiba"** / **"Hiba a mentésnél"**.
- **Permission-denied on a locked category:** the UI prevents the click entirely (segments disabled), but if a raise is somehow attempted, the backend returns a *forbidden* result and the UI shows the lock message as a toast.
- **Live-update / polling:** there is **no automatic polling or live stream** on this view. The data refreshes only when the page is opened/navigated to or when Refresh is pressed, and it self-refreshes once after a successful level change. The "last modified" footer is the operator's freshness cue.

---

## 8) PERMISSIONS / VISIBILITY

- This is an **operator-only control surface.** It is part of the operator's private management UI, not something an agent edits through this page.
- **Agents do not change their own autonomy here.** The autonomy levels constrain what the automated system is permitted to do; an agent raising its own permission is exactly what the lock + cap model prevents. The hard-locked categories enforce, at the server, that the most dangerous actions can never be elevated — this is the "no self-escalation of privilege" guarantee, made visible.
- **Visibility of the gating effect:** the levels set here are consumed elsewhere (heartbeat/orchestrator). The view itself shows the *policy*; the *consequences* (whether the operator gets pinged) play out in other surfaces (idea feed, notifications). Make clear in the UI copy/legend that level 2 = "waits for approval" and level 3 = "acts then reports," so the operator understands the escalation contract they are setting.

---

## 9) DATA CONCEPTS (read / written — concept level)

**Read (on load, via GET):**
- A **config document** with: a schema/version number, a **last-updated timestamp** (epoch seconds; 0 = never modified), an optional human-readable **documentation note** describing the level semantics, and a list of **categories**.
- Each **category** concept: a stable machine **key**, a human **label**, the current **level** (1–3), a **locked** boolean (the hard safety lock → always pinned to level 1), and a **maxLevel** cap (1–3) limiting how high the dial may go.

**Written (on a level change, via POST):**
- Only two fields are sent: the target category **key** and the new **level**.
- The server persists the new level into that category, bumps the config's **last-updated timestamp**, and returns an acknowledgement. Nothing else on the category (label, key, locked, cap) is editable from this view.

**Invariants the data model must guarantee:**
- The five high-consequence categories (publish, payment, data-delete, permission-change, external-message) are **locked = true** with **maxLevel = 1** and can never be persisted above level 1. This is enforced server-side, independent of the UI.
- A category's stored level may never exceed its maxLevel.
- The level domain is strictly the integers **1, 2, 3**.

---

## 10) i18n — STRINGS (HU default + EN)

Ship every string in Hungarian (default) and English. Suggested key list and values:

| Concept | HU (default) | EN |
|---|---|---|
| Nav item / page title | Autonómia | Autonomy |
| Subtitle | Heartbeat fokozatos autonómia szintek | Heartbeat graduated autonomy levels |
| Refresh button | Frissítés | Refresh |
| Legend level 1 | Csak jelez | Notify only |
| Legend level 2 | Javasol, jóváhagyásra vár | Proposes, waits for approval |
| Legend level 3 | Autonóm, utólag jelent | Autonomous, reports afterward |
| Loading line | Betöltés... | Loading… |
| Load error | Nem sikerült betölteni az autonómia konfigot. | Failed to load the autonomy config. |
| Locked marker | Biztonsági zár | Safety lock |
| Cap marker (N = number) | Max {N}. szint | Max level {N} |
| Footer, with date | Utolsó módosítás: {dátum} | Last modified: {date} |
| Footer, never modified | Még nem módosított | Not modified yet |
| Generic save error toast | Hiba | Error |
| Save exception toast | Hiba a mentésnél | Error while saving |
| Locked-raise refusal (server) | A(z) „{kategória}" kategória 1. szintre zárva (biztonsági korlát). | Category "{key}" is locked at level 1 (safety constraint). |
| Over-cap refusal (server) | A(z) „{kategória}" max szintje {N}. | Category "{key}" max level is {N}. |

**Category labels** (the row labels) also need both languages — see the bilingual list in §4. Keep the HU label as the canonical display string; the EN gloss is the translation. The level numbers (1/2/3) are language-neutral.

**Date formatting:** the footer's "last modified" timestamp should be rendered in the user's locale (Hungarian by default), as a full date-and-time.

---

### Implementation note for Fable 5
Build this entirely from this spec. The only backend surface you need is two endpoints — **GET `/api/autonomy`** (return the config) and **POST `/api/autonomy`** (accept `{ key, level }`, validate per §6, persist, return ack). Enforce the hard lock and the cap on the **server**, never trusting the client. The view is intentionally minimal: a legend, a refreshable grid of single-click trust dials, and a last-modified footer — no modals, no polling. All look-and-feel (colors for the 1/2/3 levels, the accent stripe, the dimmed locked rows, spacing, the segmented pill) comes from `01-design.md`.
