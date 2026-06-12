> CLEAN-ROOM BUILD SPEC — for "Fable 5". This is a behavioral + visual specification, reconstructed from observed product behavior. It contains NO source code, identifiers, file names, or database schema from any prior implementation. Reimplement ORIGINALLY. All look-and-feel (colors, spacing, typography, shadows, motion, component skins) is governed by `01-design.md`; this document specifies WHAT exists and HOW it behaves, not how it is coded or styled.

# 07 — Schedules (Ütemezések)

The Schedules view lets the operator create, edit, pause, and delete recurring AI tasks that fire on a cron timetable and dispatch a prompt to an agent. It also visualizes the day/week of scheduled activity and surfaces a queue of tasks that could not run because their target was busy.

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** A control surface for *time-driven automation*. Each "schedule" is a named, reusable job: a prompt plus a cron timetable plus a target agent. When the timetable fires, the system delivers that prompt to the chosen agent's live session, exactly as if the operator had typed it. Schedules are how the operator sets up "every morning summarize my email," "every 15 minutes watch my calendar and only ping me if something's urgent," "weekly Monday status report," etc. The view also exposes a special low-noise job kind (a "heartbeat" that only speaks up when something is worth surfacing) and a recovery queue for jobs that got skipped because their agent was mid-task.

**Navigation.** A primary left-sidebar nav item labeled **"Ütemezések" / "Schedules"**. Icon idea: a clock face with hands (a circle with two short radial strokes meeting near center), echoing "scheduled time." Selecting it shows the Schedules page and hides all others. The page is operator-facing; it is one of the main top-level destinations alongside Activity, Messages, Memory, etc.

**Page title + subtitle.**
- H1: **"Ütemezések"** (EN: **"Schedules"**)
- Subtitle: **"Időzített feladatok kezelése"** (EN: **"Manage scheduled tasks"**)

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — defer styling to `01-design.md`)

Top to bottom:

1. **Page header row.** Left side: H1 + subtitle (above). Right side: a **view-toggle + action cluster** containing, in order:
   - Three mutually-exclusive **view-mode buttons** (icon-only, with tooltips): List, Daily Timeline, Week. Exactly one is "active" at a time; default is List.
   - A primary **"Új feladat" / "New task"** button (plus-icon + label) that opens the create modal.

2. **Pending-retry banner (conditional).** Directly under the header, a full-width banner that only appears when the recovery queue is non-empty. Otherwise it is completely hidden (occupies no space). See §4 and §5.

3. **View container.** Exactly one of three sub-views is visible at a time, matching the active view-mode button:
   - **List view** — a vertical stack of schedule rows, plus a centered empty-state block when there are none.
   - **Daily Timeline view** — a horizontal 24-hour timeline: a top row of hour labels (00–23) and below it one horizontal track per agent, with task markers placed by time-of-day and a vertical "now" indicator.
   - **Week view** — a 7-column grid (Mon→Sun), each column a day, with an accordion/expand behavior so the focused day (today by default) is wide and shows time-positioned task cards while the others collapse to a count.

All three views read the same underlying schedule list; switching views never refetches required data (it re-renders from the already-loaded set), though the page does refetch on load and after any mutation.

---

## 3) CONTROLS — every button / field / dropdown / toggle (HU + EN labels)

### 3.1 Header controls

| Control | HU label / tooltip | EN | Behavior |
|---|---|---|---|
| View: List | "Lista nézet" (tooltip) | "List view" | Switches to List view; marks itself active. |
| View: Daily Timeline | "Napi idővonal" | "Daily timeline" | Switches to the 24-hour timeline; re-renders markers. |
| View: Week | "Heti nézet" | "Week view" | Switches to the 7-day grid; re-renders. |
| New task | "Új feladat" | "New task" | Opens the create/edit modal in CREATE mode (empty form, title = "Új ütemezett feladat"), focuses the Name field after open. |

### 3.2 Create/Edit modal fields (full detail in §5)

The modal is a single scrollable form (a "wide" modal). Fields and controls, in order:

| Control | HU label | EN | Type | Placeholder / options | Notes |
|---|---|---|---|---|---|
| Name | "Név" | "Name" | text input | placeholder: "pl. reggeli-napindito" (EN: "e.g. morning-kickoff") | Required, unique identifier. Slugified server-side (lowercase, spaces→hyphens, strip non `[a-z0-9-]`). **Disabled (read-only) in EDIT mode.** |
| Agent | "Ügynök" | "Agent" | dropdown | populated from the agent roster + a "broadcast/all" entry (see §3.3) | The target that receives the prompt when it fires. |
| Type | "Típus" | "Type" | dropdown | "Feladat (mindig szól)" = Task (always speaks) / "Heartbeat (csak ha fontos)" = Heartbeat (only if important) | Switching to Heartbeat reveals the Template field and, if the prompt is empty, pre-fills a 15-minute cadence. |
| Template (heartbeat only) | "Sablon" | "Template" | dropdown | "Egyéni..." (Custom) / "Naptár figyelő" (Calendar watch) / "Email figyelő" (Email watch) / "Kanban határidő figyelő" (Kanban deadline watch) / "Teljes ellenőrzés" (Full check) | Hidden unless Type = Heartbeat. Picking a non-custom template overwrites Description, Prompt, and sets a custom cron (see §5.3). |
| Description | "Leírás" + hint "(rövid)" | "Description" + "(short)" | text input | placeholder: "Mit csinál ez a feladat" (EN: "What this task does") | Optional, short human label shown in lists. |
| Prompt | "Prompt" | "Prompt" | multiline textarea (~6 rows) | placeholder: "Röviden írd le mit csináljon (pl. 'nézd meg az emailjeimet és foglald össze')" (EN: "Briefly describe what it should do (e.g. 'check my emails and summarize')") | Required. The instruction delivered to the agent. Max length 50,000 chars (server enforces; over-limit → error). |
| Intelligent expand | "Intelligens kibővítés" (button) | "Smart expand" | button | — | Launches the AI prompt-expand wizard (see §5.2). |
| Expand status | (inline hint text) | — | text | — | Shows progress/error messages from the wizard. |
| Frequency | "Gyakoriság" | "Frequency" | dropdown | see §3.4 preset list | Drives which secondary fields show (Time vs Custom cron). |
| Time | "Időpont" | "Time" | time input | default "09:00" | Visible only for time-of-day frequencies (daily/weekdays/weekly). Hidden for interval frequencies and custom. |
| Custom cron | "Cron kifejezés" + hint "(perc óra nap hónap hétnap)" | "Cron expression" + "(min hour day month weekday)" | text input | placeholder: "0 12 * * *" | Visible only when Frequency = Custom. |
| Advanced section label | "Haladó beállítások" | "Advanced settings" | section heading | — | Groups the three advanced controls below. |
| Skip if busy | "Kihagyás, ha az ügynök foglalt" | "Skip if the agent is busy" | checkbox | — | When on, a tick that lands on a busy agent is silently dropped (no retry, no alert). |
| Always send | "Mindig küldje (a foglaltság ellenére is)" | "Always send (even if busy)" | checkbox | — | When on, the prompt is forced through even if the agent is busy. |
| Target session | (no visible label; placeholder only) | — | text input | placeholder: "Cél tmux session (opcionális, felülírja az alapértelmezettet)" (EN: "Target session (optional, overrides the default)") | Optional override of which live session receives the prompt. |
| **Bypass triage** (heartbeat advanced) | "Triage kihagyása (mindig fusson)" | "Bypass triage (always run)" | checkbox | — | **See §3.5 — backend-supported, must be surfaced.** For heartbeats: opt OUT of the importance gate so the job runs on EVERY tick regardless of whether anything is "worth surfacing." |
| Save | "Mentés" / loading: "Mentés..." | "Save" / "Saving..." | primary button | — | Creates or updates the schedule. Shows an inline spinner while in flight. |
| Close | "×" | "×" | icon button | — | Closes the modal without saving (also closes on overlay click). |

### 3.3 Agent dropdown contents

The dropdown is populated from the live roster: the **main/hub agent first** (shown by its display name), then every other configured agent by name. **Add a first-class "Mindenki / Broadcast (all)" entry** whose value means "fan out to the hub plus every currently-running agent." (The backend explicitly treats an agent value of "all" as a broadcast to main + all running agents — this MUST be selectable in the UI.) Each option carries the agent's display label; the agent's avatar is used elsewhere (rows, timeline, week cards).

### 3.4 Frequency presets (dropdown options)

| Value | HU label | EN | Resulting cron (min hour … weekday) | Shows Time? |
|---|---|---|---|---|
| daily | "Naponta" | "Daily" | `m h * * *` | yes |
| weekdays | "Hétköznap" | "Weekdays" | `m h * * 1-5` | yes |
| weekly-mon | "Hetente (hétfő)" | "Weekly (Mon)" | `m h * * 1` | yes |
| weekly-fri | "Hetente (péntek)" | "Weekly (Fri)" | `m h * * 5` | yes |
| hourly | "Óránként" | "Hourly" | `0 * * * *` | no |
| every2h | "2 óránként" | "Every 2 hours" | `0 */2 * * *` | no |
| every4h | "4 óránként" | "Every 4 hours" | `0 */4 * * *` | no |
| every30m | "30 percenként" | "Every 30 min" | `*/30 * * * *` | no |
| custom | "Egyéni cron..." | "Custom cron..." | (from the Custom cron field, verbatim) | no (shows Custom cron field) |

`m`/`h` come from the Time field (split on ":"). When Custom is chosen, the Custom cron input is shown and auto-focused. The five core presets the spec explicitly calls out — daily, weekdays, weekly-Mon, weekly-Fri, hourly — must all be present; the interval presets (2h/4h/30m) round out the set.

### 3.5 Bypass-triage note (IMPORTANT for the reimplementer)

The data model and scheduler already support a per-schedule **bypassTriage** flag, and it is persisted on create/update — but the legacy UI did NOT render a control for it. In the new build, **surface it as an advanced checkbox** (label above) that is only meaningful/visible when Type = Heartbeat. Semantics: a heartbeat normally passes through an importance "triage gate" and only escalates to the agent when a signal is detected; with bypass-triage ON, the heartbeat fires every tick unconditionally (used for "must run even on quiet days" consolidation jobs). For non-heartbeat tasks the flag is irrelevant (tasks always fire).

---

## 4) LISTS / CARDS / TABLES — each item and exactly what it shows

### 4.1 Schedule row (List view)

Each schedule renders as a clickable horizontal row with three zones:

**(a) Avatar zone (left).** The target agent's circular avatar image (falls back gracefully if the image fails to load — it simply hides rather than showing a broken icon).

**(b) Info zone (center).**
- **Title line:** the schedule's Description if present, else its Name. Followed by inline badges:
  - **Heartbeat badge** — "💓 heartbeat" — shown only when Type = Heartbeat.
  - **Status badge** — "aktív" (EN "active") in an active/positive style when enabled, or "szünet" (EN "paused") in a muted style when disabled.
- **Meta line** (small, muted), three items:
  - The raw cron string (monospace).
  - A **human-readable cron description** in Hungarian (see §6.7 mapping), e.g. "Naponta 09:00", "Hétköznap 08:30", "Minden órában", "30 percenként".
  - The agent's display label.

**(c) Actions zone (right).** Two icon buttons:
- **Toggle** — pause icon when enabled (tooltip "Szüneteltetés" / "Pause"), play icon when disabled (tooltip "Folytatás" / "Resume").
- **Delete** — trash icon, danger-styled (tooltip "Törlés" / "Delete").

**Row interaction.** Clicking anywhere on the row *except* the action buttons opens the Edit modal for that schedule. Clicking an action button does its action and stops propagation (does not open Edit).

### 4.2 Pending-retry banner & rows

When the recovery queue is non-empty, a banner appears (see §5.4) titled **"Függőben lévő ütemezett feladatok (N)"** (EN: "Pending scheduled tasks (N)") with a hint line. Inside, one row per stuck job, each showing:
- **Title:** the task's name, an agent badge (paused style) with the agent name, and optionally an alert badge:
  - "⚠️ riasztás elküldve" (EN "alert sent") with tooltip "Telegram riasztás elküldve" — when a Telegram alert has already been sent.
  - "⏳ riasztás esedékes" (EN "alert due") tooltip "Riasztás esedékes, a következő tick küldi" — when an alert is due and will be sent on the next tick.
- **Meta:** an age phrase + attempt count, e.g. "12 perce vár (3 próbálkozás)" (EN: "waiting 12 min (3 attempts)") and, if available, "ok: busy" (EN "reason: busy").
- A **danger trash icon** to cancel that pending retry (tooltip "Visszavonás" / "Cancel").

### 4.3 Timeline markers (Daily Timeline view)

Per-agent horizontal track; for each schedule, a small avatar **marker** is placed at the horizontal position corresponding to each hour the cron fires (computed from the cron's hour field; minute offsets the position slightly). A disabled schedule's markers render in a muted/disabled style. Hovering a marker shows a **tooltip** = "<description-or-name> - HH:MM". Clicking a marker opens that schedule's Edit modal. A vertical **"now" line** marks the current time across each track.

### 4.4 Week cards (Week view)

7 day-columns (Mon, Tue, Wed, Thu, Fri, Sat, Sun). Only **enabled** schedules whose cron matches that weekday appear. Today's column (and any user-expanded column) is wide; collapsed columns show only a short day letter and a **count badge** of matching tasks. The expanded column shows time-positioned **task cards**, each with the agent avatar, the fire time "HH:MM", and the description/name. Hour grid lines/labels (roughly 06:00–22:00) provide vertical scale. Cards firing at the same time render side-by-side. Clicking a card opens its Edit modal. Empty days show "Nincs feladat" (EN "No tasks").

---

## 5) OPENED CARDS / MODALS / DETAIL PANES — full contents

### 5.1 Create / Edit Schedule modal

One modal serves both modes; the title switches:
- CREATE: **"Új ütemezett feladat"** (EN "New scheduled task"). Name field enabled and focused.
- EDIT: **"Feladat szerkesztése"** (EN "Edit task"). Name field disabled (the identifier can't change); all other fields pre-filled from the schedule.

**Layout, top to bottom** (all controls detailed in §3.2):
1. Row: **Name** (left half) · **Agent** (right half).
2. Row: **Type** (left half) · **Template** (right half, hidden unless heartbeat).
3. **Description** (full width).
4. **Prompt** (full width textarea) + the **"Intelligens kibővítés"** button row + inline status + an inline **expand-questions block** (initially hidden; populated by the wizard — see §5.2).
5. Row: **Frequency** (left) · **Time** (right, conditionally hidden).
6. **Custom cron** field (full width, hidden unless Frequency = Custom).
7. **Advanced settings** section: "Skip if busy" checkbox, "Always send" checkbox, "Bypass triage" checkbox (heartbeat-relevant), and the "Target session" override input.
8. **Save** primary button (with loading state). Header **× close**.

**Pre-fill in EDIT mode:** Name (disabled), Description, Prompt, Skip-if-busy, Always-send, Target session, Type (heartbeat→heartbeat, anything else→task), the heartbeat template group's visibility (visible only if heartbeat), the Agent (matched to the schedule's agent if present in the list), and the Frequency/Time/Custom-cron derived by **parsing the stored cron back into the form** (see §6.6).

### 5.2 AI Prompt-Expand wizard (two-step, in-modal)

Triggered by **"Intelligens kibővítés" / "Smart expand"**. It is an inline expander inside the modal, not a separate dialog.

**Step A — generate clarifying questions.**
- Precondition: the Prompt field is non-empty (else it just focuses the prompt and does nothing).
- The button disables and the status text shows **"Kérdések generálása..."** (EN "Generating questions...").
- It asks the backend (passing the current short prompt + the selected agent name) to produce 3–4 **multiple-choice clarifying questions**, each with 2–4 options.
- On success: the status clears and the questions block renders. Each question shows its text and a row of **option buttons**. Selecting an option highlights it (single-select per question) and records the answer; re-selecting another option for the same question replaces the answer.
- Below the questions, an **"Prompt kibővítése" / "Expand prompt"** button (compact primary, with its own spinner).
- On error: status shows **"Hiba a kérdések generálásakor"** (EN "Error generating questions") and the button re-enables.

**Step B — expand the prompt from answers.**
- Pressing "Prompt kibővítése" requires at least one answered question, else it shows a toast **"Válaszolj legalább egy kérdésre"** (EN "Answer at least one question").
- The button shows its loading spinner; the backend is asked to expand the original short prompt into a detailed, concrete instruction using the (question, answer) pairs.
- On success: the expanded text **replaces the contents of the Prompt textarea**, the questions block hides, and a toast **"Prompt kibővítve!"** (EN "Prompt expanded!") shows.
- On error: toast **"Hiba a kibővítés során"** (EN "Error during expansion"); the button re-enables.

**Reset behavior:** opening the modal fresh clears the answers, hides the questions block, and clears the status.

### 5.3 Heartbeat templates (what each prefills)

When Type = Heartbeat and a template (other than "Egyéni...") is chosen, the form prefills Description + Prompt + a custom cron, and switches Frequency to Custom (showing the Custom-cron field, hiding the Time field):

| Template | Description set | Prompt (intent — paraphrase, write fresh HU copy) | Cadence |
|---|---|---|---|
| Calendar watch ("Naptár figyelő") | "Naptár figyelő" | Check today's calendar; if a meeting is within an hour, ping via Telegram and remind again 10 min before; if nothing upcoming, stay silent. | every 15 min |
| Email watch ("Email figyelő") | "Email figyelő" | Check email from the last hour; if an urgent/important message (client, boss, payment-related) arrives, ping via Telegram; ignore promos/newsletters. | every 30 min |
| Kanban deadline watch ("Kanban határidő figyelő") | "Kanban határidő figyelő" | Check the kanban board; if any card is due today or is urgent and not done, ping via Telegram; otherwise stay silent. | every 2 hours |
| Full check ("Teljes ellenőrzés") | "Teljes ellenőrzés" | Combined: calendar within an hour + urgent email last hour + kanban due today; ping concisely via Telegram only if anything matters, else stay quiet. | every 15 min |

Note: the prompts must be written fresh (HU default, EN equivalents) — these are *intent* descriptions, not text to copy.

### 5.4 Pending-retry banner (detail)

The banner (full contents listed in §4.2) carries:
- Header title **"Függőben lévő ütemezett feladatok (N)"** (EN "Pending scheduled tasks (N)").
- Hint line: **"Busy cél-session, a rendszer tovább próbálkozik. Nyilvánvaló hibánál visszavonhatod."** (EN: "Target session busy — the system keeps retrying. You can cancel an obviously-stuck one.")
- The per-row cancel control opens a **confirm dialog** "Biztosan visszavonod ezt a várakozó ütemezett feladatot?" (EN "Cancel this pending scheduled task?") before deleting.

---

## 6) FLOWS & BEHAVIOR — step by step + API contract + effect

> Endpoints below are **behavioral contracts** (method + path + payload + result), not implementation. Destructive actions confirm first.

### 6.1 Load the page
- On entering the view: fetch the agent roster, then fetch the schedule list, render the active sub-view, and fetch the pending-retry queue.
  - GET roster → `[{ name, label, avatar }]` (main agent first).
  - GET schedules → array of schedule objects (name, description, prompt, schedule/cron, agent, enabled, type, skipIfBusy, forceSend, targetSession, bypassTriage).
  - GET pending → array of pending-retry views.
- If the list is empty, the List view shows its empty state; the banner stays hidden if the queue is empty.

### 6.2 Create a schedule
1. Operator opens the modal via "Új feladat," fills the form, presses Save.
2. Client validation: Name required (focus if blank), Prompt required (focus if blank), a resolvable cron required (toast "Válassz ütemezést" / "Choose a schedule" if none). Frequency presets compute the cron from Time; Custom uses the field verbatim.
3. Save disables + shows spinner.
4. POST schedules with `{ name, description, prompt, schedule, agent, type, skipIfBusy, forceSend, targetSession?, bypassTriage? }`.
   - Server slugifies the name; rejects: blank name (400), blank prompt (400), prompt over 50,000 chars (413), blank/invalid cron shape (400 — cron must be a valid 5-field, or 6-field-with-seconds, expression ≤100 chars), and a name collision (409 "already exists"). Request body cap ~256 KB (413 if exceeded).
   - On success the schedule is persisted **enabled** with type defaulting to "task."
5. On success: toast **"Feladat létrehozva!"** (EN "Task created!"), close modal, reload list.
6. On error: toast **"Hiba: <message>"** (EN "Error: …"); modal stays open.

### 6.3 Edit a schedule
- Opening Edit: refetch the roster (so the agent dropdown is current), reset+prefill the form, open the modal in EDIT mode (Name disabled).
- Save → PUT schedules/<name> with the editable fields `{ description, prompt, schedule, agent, type, skipIfBusy, forceSend, targetSession?, bypassTriage? }`.
  - Server: 404 if the named schedule doesn't exist; 413 if prompt over the max; 400 if the supplied cron is invalid shape.
- On success: toast **"Feladat frissítve"** (EN "Task updated"), close, reload.

### 6.4 Toggle enable/disable
- Pressing the toggle icon on a row → POST schedules/<name>/toggle (server flips the enabled flag and returns the new state).
- Optimistic UX: toast **"Feladat szüneteltetve"** (EN "Task paused") or **"Feladat újraindult"** (EN "Task resumed") based on the prior state, then reload.
- On failure: toast **"Hiba történt"** (EN "Something went wrong").
- Disabled schedules: keep showing in List (with the "szünet/paused" badge) and Timeline (muted markers), but are **excluded from the Week view** (which only plots enabled jobs).

### 6.5 Delete
- Pressing the trash icon → **confirm** "Biztosan törlöd ezt a feladatot?" (EN "Delete this task?"). If confirmed, DELETE schedules/<name> (server removes the schedule's directory; 404 if not found).
- On success: toast **"Feladat törölve"** (EN "Task deleted"), reload. On failure: toast **"Hiba a törlés során"** (EN "Error during deletion").

### 6.6 Cron ↔ form mapping (round-trip)
- **Form → cron:** per §3.4.
- **Cron → form (for Edit / view labels):** parse the 5 fields and reverse-map to a preset where possible (e.g. `*/30 * * * *`→Every-30-min, `0 * * * *`→Hourly, `0 */2 * * *`→Every-2-hours, `0 */4 * * *`→Every-4-hours; time-based `m h * * *`→Daily at HH:MM, `* * 1-5`→Weekdays, `* * 1`→Weekly-Mon, `* * 5`→Weekly-Fri). Anything that doesn't fit a preset falls back to **Custom**, showing the raw cron in the Custom field. The Time field is shown only for the time-of-day presets.

### 6.7 Human-readable cron description (HU, for row meta lines)
Map common cron patterns to friendly Hungarian (with EN equivalents to ship):
- `*/N * * * *` → "N percenként" / "every N min"
- `0 */N * * *` → "N óránként" / "every N hours"
- `0 * * * *` → "Minden órában" / "Hourly"
- `m h * * 1-5` → "Hétköznap HH:MM" / "Weekdays HH:MM"
- `m h * * 0,6` → "Hétvégén HH:MM" / "Weekends HH:MM"
- single weekday → "Hétfőn/Kedden/…/Vasárnap HH:MM" (Mon/Tue/…/Sun)
- `m h * * *` → "Naponta HH:MM" / "Daily HH:MM"
- day-of-month set → "Minden hónap D. napján HH:MM" / "Day D of every month HH:MM"
- otherwise → show the raw cron.

### 6.8 Pending-retry semantics (why rows appear / cancel flow)
- When a tick lands on a busy agent and the schedule does NOT have "skip if busy," the runner enqueues a pending-retry row and keeps trying on subsequent ticks. If the busy state persists past an alert threshold, the system stamps and sends a Telegram alert (the row then shows "alert sent"; before that, if past-threshold, "alert due").
- A pending row exposes: task name, agent name, age (humanized: "<1 perce", "N perce", "N órája", "N ó M p-e"), attempt count, last reason, and alert status.
- Cancel → confirm → DELETE pending/<id> (numeric id; 404 if already gone), then refresh the queue. Cancelling lets the operator drop a job that is obviously never going to clear.

### 6.9 "All / broadcast" target
- A schedule whose agent = "all" fans the prompt out, on each fire, to the hub agent plus every currently-running agent. The List/Timeline grouping should represent this sensibly (e.g. show it under an "all/broadcast" pseudo-agent label).

---

## 7) STATES

- **Empty (List):** centered empty block with a clock icon and **"Nincsenek ütemezett feladatok"** (EN "No scheduled tasks").
- **Empty (Timeline):** centered muted text "Nincsenek ütemezett feladatok" inside the timeline body.
- **Empty (Week, per day):** "Nincs feladat" (EN "No tasks") in that day's column.
- **Loading:** initial load fetches roster + list + queue; the Save and Expand buttons each have explicit inline spinner states ("Mentés..." / loading; expand status "Kérdések generálása..."). There is no separate full-page skeleton — the views simply populate when data arrives.
- **Error:** fetch failures are logged and degrade gracefully (e.g. the pending banner hides on error rather than showing broken markup). Save/toggle/delete failures surface as toasts (see §6). The expand wizard shows inline error text/toasts.
- **No-data for pending queue:** banner stays fully hidden (no empty placeholder).
- **Live-update / polling:** the page reloads its data on every mutation (create/edit/toggle/delete, and pending-cancel). The pending queue and timeline "now" line reflect a periodic refresh; treat the pending queue and the timeline as **polled/refreshed** so a newly-stuck job appears without a manual reload, and the "now" indicator tracks real time. (Polling cadence is a tuning detail; the contract is "the operator should see new pending rows and an accurate now-line without leaving the page.")

---

## 8) PERMISSIONS / VISIBILITY

- This is an **operator-only** control surface. Agents do not edit their own schedules through this UI; the operator is the single privileged user of the dashboard.
- **Autonomy gating note:** scheduled jobs are how the system acts proactively. Operator-facing escalation that a heartbeat might trigger (e.g. a Telegram ping) is gated by the system's autonomy level — at low autonomy, proactive jobs should be conservative (record/observe rather than message). The Schedules UI itself is always available to the operator; the *consequences* of what a schedule does respect the global autonomy setting. Document this so heartbeats don't surprise the operator at low autonomy.
- No per-agent permission rows in this view; the only "permission denied" surface would be auth failure on the dashboard as a whole (handled at the app shell level, not here).

---

## 9) DATA CONCEPTS (concept-level, read/written)

A **Schedule** concept (one per named job):
- `name` — slug identifier (immutable after create).
- `description` — short human label.
- `prompt` — the instruction text delivered on fire (≤ 50,000 chars).
- `schedule` — a cron expression (5-field standard, or 6-field with seconds).
- `agent` — target agent name, or "all" for broadcast.
- `enabled` — boolean (toggled in the UI).
- `type` — "task" (default) or "heartbeat".
- `skipIfBusy` — boolean (drop a tick silently if the agent is busy).
- `forceSend` — boolean (push through even if busy).
- `targetSession` — optional session override.
- `bypassTriage` — boolean (heartbeats: run every tick, skipping the importance gate).
- (Implicitly) a created-at timestamp and a derived "next run."

A **Pending-retry** concept (recovery queue entry): id (numeric), task name, agent name, first-attempt time (→ derived age), attempt count, last reason, alert-sent timestamp (→ derived "alert sent" / "alert due").

Reads: roster, schedule list, pending queue. Writes: create/update/delete schedule, toggle enabled, cancel pending retry. The expand wizard reads the draft prompt + agent and writes the expanded prompt back into the form (not persisted until Save).

---

## 10) i18n — all strings ship HU (default) + EN

| Concept | HU (default) | EN |
|---|---|---|
| Nav / Title | Ütemezések | Schedules |
| Subtitle | Időzített feladatok kezelése | Manage scheduled tasks |
| New task | Új feladat | New task |
| View: list / timeline / week | Lista nézet / Napi idővonal / Heti nézet | List view / Daily timeline / Week view |
| Modal title (create) | Új ütemezett feladat | New scheduled task |
| Modal title (edit) | Feladat szerkesztése | Edit task |
| Name | Név | Name |
| Name placeholder | pl. reggeli-napindito | e.g. morning-kickoff |
| Agent | Ügynök | Agent |
| Broadcast option | Mindenki (összes ügynök) | Everyone (all agents) |
| Type | Típus | Type |
| Type: task | Feladat (mindig szól) | Task (always notifies) |
| Type: heartbeat | Heartbeat (csak ha fontos) | Heartbeat (only if important) |
| Template | Sablon | Template |
| Template: custom/calendar/email/kanban/full | Egyéni... / Naptár figyelő / Email figyelő / Kanban határidő figyelő / Teljes ellenőrzés | Custom... / Calendar watch / Email watch / Kanban deadline watch / Full check |
| Description (+hint) | Leírás (rövid) | Description (short) |
| Description placeholder | Mit csinál ez a feladat | What this task does |
| Prompt | Prompt | Prompt |
| Prompt placeholder | Röviden írd le mit csináljon (pl. 'nézd meg az emailjeimet és foglald össze') | Briefly describe what it should do (e.g. 'check my emails and summarize') |
| Smart expand | Intelligens kibővítés | Smart expand |
| Expand: generating | Kérdések generálása... | Generating questions... |
| Expand: error (questions) | Hiba a kérdések generálásakor | Error generating questions |
| Expand prompt button | Prompt kibővítése | Expand prompt |
| Expand: need an answer | Válaszolj legalább egy kérdésre | Answer at least one question |
| Expand: success | Prompt kibővítve! | Prompt expanded! |
| Expand: error (expand) | Hiba a kibővítés során | Error during expansion |
| Frequency | Gyakoriság | Frequency |
| Freq presets | Naponta / Hétköznap / Hetente (hétfő) / Hetente (péntek) / Óránként / 2 óránként / 4 óránként / 30 percenként / Egyéni cron... | Daily / Weekdays / Weekly (Mon) / Weekly (Fri) / Hourly / Every 2 hours / Every 4 hours / Every 30 min / Custom cron... |
| Time | Időpont | Time |
| Cron expr (+hint) | Cron kifejezés (perc óra nap hónap hétnap) | Cron expression (min hour day month weekday) |
| Advanced settings | Haladó beállítások | Advanced settings |
| Skip if busy | Kihagyás, ha az ügynök foglalt | Skip if the agent is busy |
| Always send | Mindig küldje (a foglaltság ellenére is) | Always send (even if busy) |
| Bypass triage | Triage kihagyása (mindig fusson) | Bypass triage (always run) |
| Target session placeholder | Cél tmux session (opcionális, felülírja az alapértelmezettet) | Target session (optional, overrides the default) |
| Save / saving | Mentés / Mentés... | Save / Saving... |
| Status: active / paused | aktív / szünet | active / paused |
| Heartbeat badge | 💓 heartbeat | 💓 heartbeat |
| Row action tooltips | Szüneteltetés / Folytatás / Törlés | Pause / Resume / Delete |
| Confirm delete | Biztosan törlöd ezt a feladatot? | Delete this task? |
| Toast: created/updated | Feladat létrehozva! / Feladat frissítve | Task created! / Task updated |
| Toast: paused/resumed | Feladat szüneteltetve / Feladat újraindult | Task paused / Task resumed |
| Toast: deleted / delete error | Feladat törölve / Hiba a törlés során | Task deleted / Error during deletion |
| Toast: generic error | Hiba történt / Hiba: <üzenet> | Something went wrong / Error: <message> |
| Choose schedule | Válassz ütemezést | Choose a schedule |
| Empty (list) | Nincsenek ütemezett feladatok | No scheduled tasks |
| Empty (week day) | Nincs feladat | No tasks |
| Pending banner title | Függőben lévő ütemezett feladatok (N) | Pending scheduled tasks (N) |
| Pending hint | Busy cél-session, a rendszer tovább próbálkozik. Nyilvánvaló hibánál visszavonhatod. | Target session busy — the system keeps retrying. You can cancel an obviously-stuck one. |
| Pending: alert sent / due | ⚠️ riasztás elküldve / ⏳ riasztás esedékes | ⚠️ alert sent / ⏳ alert due |
| Pending: age phrases | kevesebb, mint 1 perce / N perce / N órája / N ó M p-e | less than 1 min ago / N min ago / N hr ago / N hr M min ago |
| Pending: waiting line | N perce vár (K próbálkozás) | waiting N min (K attempts) |
| Pending: reason | ok: <…> | reason: <…> |
| Pending: cancel tooltip / confirm | Visszavonás / Biztosan visszavonod ezt a várakozó ütemezett feladatot? | Cancel / Cancel this pending scheduled task? |
| Cron readable (samples) | Naponta HH:MM / Hétköznap HH:MM / Minden órában / N percenként / N óránként | Daily HH:MM / Weekdays HH:MM / Hourly / every N min / every N hours |
| Day letters / full (Week) | H K Sze Cs P Szo V / Hétfő…Vasárnap | M T W T F S S / Monday…Sunday |

**Defaults & implementation notes for Fable 5.** Default language Hungarian; ship a complete EN mirror. Cron presets are first-class shortcuts that compile to standard cron; always allow a raw Custom cron escape hatch and validate shape before save. The "all/broadcast" target and the "bypass triage" checkbox are backend-supported and MUST be exposed in this build even though they were missing/partial in the reference UI. Everything visual (row styling, badges, timeline/week layout polish, modal chrome, spinners, empty-state art) defers to `01-design.md`.
