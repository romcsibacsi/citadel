# Fable 5 Build Prompt — Background Tasks view ("Háttér")

> CLEAN-ROOM NOTICE: This is an original behavioral + visual specification written for an engineer who has never seen the reference implementation. Build it from scratch in your own stack. Nothing here is copied source code, identifiers, file names, or database schema — it describes only observable appearance, controls, fields, flows, and contracts. Where an exact wire format is given (HTTP path, JSON key, status string), treat it as a contract you must satisfy, not as code to transcribe. For all visual look-and-feel (colors, spacing, typography, shadows, radii, badges), defer to `01-design.md`; this document specifies structure and behavior only.

---

## 1) PURPOSE & WHERE IT LIVES

**What it is.** "Háttér" (Background) is a lightweight **detached one-shot agent runner**. From this one screen the operator types a single task instruction, picks which agent should execute it, and fires it off to run **headlessly in the background** — no live chat, no interactive session. The job runs to completion on its own; the operator can watch its captured terminal output, see whether it succeeded, failed, or timed out, and cancel it mid-run. It is the "fire-and-forget errand" surface of the product, distinct from the conversational agent chat and from any scheduled/recurring-task feature.

**Mental model for the operator.** "Tell agent X to do this one thing now, in the background, and let me check on it later." Each launch produces a tracked job with a short ID, a status, a timestamp, and an output transcript.

**Where it lives.** It is a top-level entry in the left sidebar navigation, sitting in the operational cluster of the nav (near logs/activity-type entries, before the integrations/skills group). Selecting it swaps the main content area to this view (single-page-app style page switching; the active nav entry highlights). The view is reachable by a URL fragment/hash so it is deep-linkable and survives a refresh.

- **Nav label:** `Háttér` (HU) / `Background` (EN).
- **Icon idea:** a simple monitor/terminal-screen outline with a small stand (a rectangle on a short base) — evoking "a screen running a process." Single-stroke line icon, ~18px, matching the other nav glyphs. Use any equivalent "running process / terminal" line glyph.
- **Page heading (inside the view):** `Háttérfeladatok` (HU) / `Background tasks` (EN).
- **Subtitle under the heading:** HU `Háttérben futó feladatok indítása és követése` / EN `Launch and track background-running tasks`.

**Relationship to the file browser.** A separate, sibling nav entry exists for an embedded file browser (`Fájlok` / `Files`). That is **not** part of this view — it is its own page with its own spec. Do not merge them. This document covers only the background-task runner that the "Háttér" nav entry opens.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — see 01-design.md for styling)

Top-to-bottom, the view has three stacked regions inside the standard content column:

1. **Page header block.**
   - Large page title `Háttérfeladatok`.
   - Muted one-line subtitle beneath it (the HU/EN string above).
   - No action buttons live in the header (the launch controls are their own row below).

2. **Launch / control bar** (a single horizontal row that wraps to multiple lines on narrow widths). Left-to-right:
   - An **agent picker** dropdown (fixed, fairly narrow).
   - A **task description** text field that stretches to fill remaining width (with a sensible minimum width so it never collapses).
   - A **primary "Launch" button**.
   - A **"include finished" checkbox** with an inline label, styled as muted small text, vertically centered.

3. **Task list region** — a vertical stack of task cards filling the rest of the page. This is the only scrolling content area of interest. When there are no tasks it shows a single muted line of placeholder text instead of cards.

The whole view is operator-facing chrome; it does not use a multi-column dashboard grid. It is comfortable on both desktop and mobile (the control bar wraps; cards are full-width).

---

## 3) CONTROLS — every interactive element

All controls live in the launch/control bar plus per-card buttons (covered in §4) and modal buttons (§5).

### 3.1 Agent picker (dropdown / select)
- **Purpose:** choose which agent will execute the one-shot task.
- **Placeholder / first option:** a non-selectable-as-target default reading HU `Ágens` / EN `Agent` (empty value). If the operator tries to launch with this still selected, launching is blocked with a toast (see §6).
- **Options:** populated once, on first open of the view, from the agent roster endpoint (see §6/§9). The list contains the **main orchestrator agent first**, then every sub-agent. Each option's visible text is the agent's display label; its underlying value is the agent's stable identifier/name.
- **Convenience behavior:** if the roster contains exactly one agent, that single agent is auto-selected.
- **Secondary role:** the currently selected agent also acts as the **list filter** (see §3.4 / §6) — the task list shows tasks for the selected agent unless "include finished" + no-agent semantics broaden it. Practically: changing the dropdown both sets the launch target and re-scopes the list.

### 3.2 Task description field (single-line text input)
- **Placeholder:** HU `Feladat leírása...` / EN `Task description...`.
- **Purpose:** the full natural-language instruction handed to the agent as its prompt.
- **Behavior:** pressing **Enter** while focused triggers the same action as the Launch button. Trimmed before use; empty/whitespace-only is rejected (toast). Cleared automatically after a successful launch.

### 3.3 Launch button (primary)
- **Label:** HU `Indítás` / EN `Launch`.
- **Action:** validates inputs, posts the new background task, shows a success toast, clears the prompt field, and refreshes the list. Disabled (non-clickable, visibly so) for the duration of the in-flight request, then re-enabled.

### 3.4 "Include finished" toggle (checkbox + label)
- **Label:** HU `Befejezettek is` / EN `Include finished`.
- **Default:** unchecked.
- **Action:** when unchecked, the list shows **only currently-running** tasks. When checked, the list also includes completed jobs (done / failed / timeout), most-recent first, bounded to a recent window (see §6/§9). Toggling it immediately reloads the list.

There is **no separate search box, no sort dropdown, no tabs, and no status filter chips** in this view — scope is controlled solely by the agent dropdown and the "include finished" checkbox. (Do not add extra filters beyond these two.)

---

## 4) LIST / CARDS — the task list and per-item contents

The list region renders one **task card** per background task returned by the list query, in the order the API returns them (running/most-recent first). Each card is a self-contained block.

### 4.1 Card structure & exact fields shown
A card has a **status accent edge** (a colored left border) whose color encodes the status (see status palette in §7). Inside:

**Top row (two clusters, space-between):**
- **Left cluster:**
  - **Task ID** — a short uppercase hex-style identifier (8 characters), shown bold/emphasized.
  - **Status badge** — a small rounded pill, colored by status, with the localized status label as text (see §7 for the four labels/colors).
  - **Agent badge** — a small rounded pill (distinct accent color from the status badge) showing the executing agent's identifier.
- **Right cluster:**
  - **Started timestamp** — the launch time, rendered as a localized human-readable date-time string (Hungarian locale, Budapest timezone) in muted small text.
  - **Per-item action buttons — ONLY when the task is currently running:**
    - **"Output" button** — HU `Kimenet` / EN `Output` — opens the output modal (§5).
    - **"Stop" button** — HU `Leállítás` / EN `Stop` — cancels the running task (danger-colored text), after a confirmation (§6).
  - For non-running (finished) tasks, no action buttons appear in the card (their final output is already shown inline; see below).

**Body of the card:**
- **Prompt text** — the full task instruction the operator submitted, shown in normal-emphasis body text.
- **Finished timestamp line** — only present once the task has a finish time: a muted line reading HU `Befejezve: <localized datetime>` / EN `Finished: <localized datetime>`.
- **Output preview block** — only present if the task has captured output: a monospace, pre-formatted, scrollable block (capped height, e.g. ~200px, internal scroll, wrapping preserved) showing the **tail of the output** (last ~2000 characters). HTML-escape all output before rendering. For a running task this inline block shows whatever output existed at last list refresh; the live, full output is available via the Output modal.

### 4.2 Empty / placeholder
When the query returns zero tasks, the list region shows a single muted line: HU `Nincs háttérfeladat.` / EN `No background tasks.` (no card chrome).

There is no pagination control; the API itself caps the returned set to a recent window (see §9). There is no per-card overflow "⋯" menu — the only per-card actions are the two running-only buttons above.

---

## 5) OPENED MODALS / DETAIL PANES

There is exactly one modal in this view: the **task output viewer**.

### 5.1 Output modal (opened by the running card's "Kimenet" / "Output" button)
- **Trigger:** clicking the Output button on a running task. (Finished tasks display their output inline instead, so they do not open this modal in the running-only button path.)
- **Behavior on open:** it fetches the **single-task detail** for that ID, which returns the task record plus, for a running task, a freshly **live-captured** snapshot of the agent's terminal output at that moment. It displays the live snapshot if present, otherwise the stored output, otherwise a placeholder.
- **Appearance:** a centered overlay (dimmed full-screen backdrop) containing a card panel, max width roughly 800px, up to ~80% viewport height, with internal vertical scroll for long output.
- **Header row of the panel:**
  - **Title:** HU `Háttérfeladat <ID>` / EN `Background task <ID>` (the task's short ID).
  - **Close button** (top-right): HU `Bezárás` / EN `Close`.
- **Body:** a single monospace, pre-formatted, wrapping block showing the full captured output (or HU `(nincs kimenet)` / EN `(no output)` if there is none). HTML-escape the content.
- **Dismissal:** clicking the Close button, or clicking the dimmed backdrop outside the panel, removes the modal. (No auto-refresh inside the modal — it is a point-in-time snapshot; closing and reopening re-fetches.)

There are no other modals, side panels, drawers, or detail routes. There is no edit/rename, no re-run-from-history, and no "view full prompt" modal (the full prompt is already shown in the card body).

---

## 6) FLOWS & BEHAVIOR — step by step, with API contracts

All endpoints below are JSON over HTTP and require the standard authenticated operator session/bearer the rest of the app uses; the front-end wraps fetch to attach auth automatically.

### 6.1 Populate the agent dropdown (on first view open)
1. On the first time the view is shown, GET the **agent roster** endpoint: `GET /api/schedules/agents`.
2. Response is an array of agent descriptors, each with at minimum `{ name, label }` (and optionally an avatar URL — not required by this view). The first element is the **main orchestrator agent**; the rest are sub-agents.
3. Append one option per agent (text = `label`, value = `name`) after the default placeholder option. If exactly one agent is returned, pre-select it.
4. Wire the launch button, the prompt field's Enter key, and the "include finished" checkbox's change event. Do this wiring only once.
> Contract note: use the roster endpoint that **includes the main agent**, because the launch backend will accept the main agent as a valid target. (A different "sub-agents only" listing exists elsewhere in the app — do not use that one here, or the main agent would be unlaunchable.)

### 6.2 Load / refresh the task list
1. Build query params: include `agent=<selected agent value>` when an agent is selected; include `all=true` when "include finished" is checked.
2. `GET /api/background-tasks?<params>`.
3. Response: an array of task records (newest/running first), each containing at least: `id`, `agent_id`, `prompt`, `status`, `started_at`, `finished_at` (nullable), `output` (nullable), plus pre-formatted localized label fields `started_label` and `finished_label` (nullable) for display.
4. Render cards per §4. On HTTP error show an inline error line HU `Hiba a betöltésnél` / EN `Failed to load`; on network failure HU `Nem sikerült betölteni` / EN `Could not load`.
5. **Polling:** while this view is active, re-run this load automatically every ~10 seconds so running tasks update their status, timestamps, and inline output. Stop/replace the timer appropriately when re-entering the view (do not stack timers). (No websocket; simple interval polling.)

### 6.3 Launch a new task
1. Read the selected agent value and the trimmed prompt.
2. Client-side guards: if no agent selected → toast HU `Válassz ágenst` / EN `Choose an agent` and abort. If prompt empty → toast HU `Add meg a feladatot` / EN `Enter the task` and abort.
3. Disable the Launch button.
4. `POST /api/background-tasks` with JSON body `{ agent_id, prompt }`.
5. Outcomes:
   - **201 Created:** the created task record is returned. Clear the prompt field, toast HU `Háttérfeladat elindítva` / EN `Background task started`, reload the list (the new running card appears).
   - **400:** missing prompt or missing agent (server-side guard); the server returns an `error` message — show it as a toast.
   - **429 Too Many:** the per-agent concurrency cap is hit; the server returns an error message stating the maximum number of simultaneous background tasks per agent (cap = 3). Show that message as a toast; do not clear the prompt.
   - **Other error / network failure:** toast HU `Hiba történt` / EN `Something went wrong` (or HU `Nem sikerült elindítani` / EN `Failed to launch` on a thrown fetch).
6. Always re-enable the Launch button when done (success or failure).

**What the server does on launch (behavioral contract, not implementation):**
- It allocates a new short uppercase 8-hex-char ID.
- **Atomic per-agent cap:** before recording the task it counts the agent's currently-running tasks; if already at the cap (**3**), it refuses with the 429 error and does not start anything. The check-and-insert is atomic so two near-simultaneous launches can't both slip past the cap.
- It launches the chosen agent in a **detached, headless one-shot run** that executes the given prompt and exits, with its console output captured. The agent runs non-interactively (no chat session). The launch passes the prompt safely (no shell-injection / no env-leak of the prompt) and records a marker that carries the run's **exit code** so a non-zero exit is recorded as a failure, not a success.
- It records the job as `running` with the start time, then arranges to finalize it: a **completion poller** (every ~10s) detects when the run has finished and reads the final output + exit code; and a **timeout guard** force-finalizes the job after **30 minutes** if it is still running.

### 6.4 Finalization / status transitions (server-side, observable in the UI)
- **Completes with exit code 0 →** status becomes `done`, output stored (the captured transcript with the internal completion marker stripped).
- **Completes with non-zero exit →** status becomes `failed`, output stored.
- **Run process disappears unexpectedly (killed externally) →** status becomes `failed` with a brief note such as "(session ended)".
- **Still running at 30 minutes →** status becomes `timeout`, output = whatever was captured (or a "(timeout)" placeholder).
- **Server restart while a task was running:** on startup the server sweeps tasks still marked running: any whose underlying run is gone are marked `failed` (note like "(orphaned on restart)"); any still genuinely alive are re-attached to a fresh poller + timeout guard. The UI just shows the resulting status on next poll.

### 6.5 View live output (Output modal)
1. Click "Kimenet"/"Output" on a running card.
2. `GET /api/background-tasks/<ID>`.
3. 200 → render the modal (§5) using the live-captured snapshot if present, else stored output, else placeholder. 404 → toast HU `Nem sikerült betölteni` / EN `Could not load`. Other failure → generic error toast.

### 6.6 Cancel / stop a running task (destructive — confirmation required)
1. Click "Leállítás"/"Stop" on a running card.
2. **Confirmation prompt** (browser confirm or app confirm dialog): HU `Biztosan leállítod?` / EN `Are you sure you want to stop it?`. If declined, do nothing.
3. `DELETE /api/background-tasks/<ID>`.
4. Server behavior: captures whatever output exists, kills the underlying run if still alive, and marks the task `failed` with a note such as "(cancelled)". Returns success `{ ok: true }` (404 if the ID is unknown).
5. UI: on success toast HU `Leállítva` / EN `Stopped` and reload the list (the card flips to failed). On failure toast HU `Nem sikerült leállítani` / EN `Could not stop`.

> The only destructive action in this view is Stop/cancel, and it is gated by the confirmation above. Launching is not treated as destructive. There is no delete-from-history action (finished records simply age out of the bounded list window).

---

## 7) STATES — empty / loading / error / live

- **Loading (initial / refresh):** the list region may briefly show its prior content; on the very first load you may show the empty/placeholder until data arrives. (Refreshes are silent — the 10s poll should not flash a spinner; just diff in the new cards.)
- **Empty:** muted line HU `Nincs háttérfeladat.` / EN `No background tasks.` (per the current agent + finished filter).
- **List error (HTTP not-OK):** inline line HU `Hiba a betöltésnél` / EN `Failed to load`, in the danger color.
- **List error (network/throw):** inline line HU `Nem sikerült betölteni` / EN `Could not load`.
- **Status colors & labels** (status pill + card left edge): 
  - `running` → amber/orange, label HU `Fut` / EN `Running`.
  - `done` → green, label HU `Kész` / EN `Done`.
  - `failed` → red, label HU `Hiba` / EN `Failed`.
  - `timeout` → gray, label HU `Időtúllépés` / EN `Timed out`.
  - (Any unexpected status → fall back to gray and show the raw status string.)
- **Live-update:** automatic 10s polling of the list while the view is open; running cards advance to a terminal status without operator action. The Output modal is a point-in-time snapshot (re-open to refresh).
- **Permission-denied / auth failure:** if the underlying fetch wrapper hits an auth failure it follows the app-wide auth handling (e.g. redirect/re-auth); within this view treat it like a load error (show the error line). There is no separate per-element permission-denied state, because this is an operator-only surface (see §8).

---

## 8) PERMISSIONS / VISIBILITY

- **Operator-only surface.** This view is part of the operator's control dashboard. The whole dashboard is behind the standard operator authentication; agents do not use this UI. So there is effectively one role here: the human operator.
- **Any roster agent is a valid target,** including the **main orchestrator agent** and all sub-agents. There is no per-agent permission gate in *this* view — picking an agent and launching is allowed for the whole roster.
- **No self-escalation / no spawning new agents** happens here: this view dispatches a one-shot prompt to an *existing* agent; it never creates agents or changes their privileges. Keep it that way — do not add agent-creation here.
- **Autonomy gating note:** the runner itself does not branch on the system's global autonomy level — a launched task simply runs as that agent with that agent's own configured permissions/tooling. (If your build wants to surface an autonomy reminder, do it as informational text only; do not block launching based on autonomy in this view, to match the reference behavior.)
- **Concurrency is the real guardrail:** the per-agent cap of **3 simultaneous running tasks** is the protective limit the operator will actually hit; surface it clearly via the 429 toast.

---

## 9) DATA CONCEPTS (concept-level — design your own storage)

A **background task** record (one row per launched job) carries, at minimum:
- **ID** — short uppercase 8-hex-character primary identifier (also shown in the UI).
- **Agent identifier** — which agent executes it.
- **Prompt** — the operator's full instruction text.
- **Status** — one of exactly `running` / `done` / `failed` / `timeout` (constrain to this set).
- **Detached-run handle** — an opaque reference to the underlying headless run (so the server can poll/capture/kill it). Internal; not shown to the operator.
- **Started-at** — launch timestamp.
- **Finished-at** — completion timestamp (nullable until finalized).
- **Output** — captured console transcript (nullable; stored at finalization, with the internal completion marker stripped).

Read/derived for the API responses:
- `started_label` / `finished_label` — server-formatted localized (hu-HU, Budapest TZ) date-time strings for display.
- For the single-task detail of a running task: a **live output snapshot** captured on demand at request time (not persisted until the job finalizes).

Indexing/scoping concepts:
- List queries scope by agent and by "running-only vs include-finished."
- The "include finished" list is bounded to a **recent window** (cap ~50 most-recent records) and ordered newest-first; the running-only list returns all currently-running for the scope.
- Atomic insert-with-cap-check: counting an agent's running tasks and inserting the new one happen as one atomic operation to enforce the 3-task cap under concurrency.

The runner reads the **agent roster** (main agent + sub-agents) only to populate the picker; it does not write to agent records.

---

## 10) i18n — all strings ship HU (default) + EN

Default language is **Hungarian**; provide English equivalents behind the app's locale switch. Complete string set for this view:

| Key (suggested) | HU (default) | EN |
|---|---|---|
| nav.label | Háttér | Background |
| page.title | Háttérfeladatok | Background tasks |
| page.subtitle | Háttérben futó feladatok indítása és követése | Launch and track background-running tasks |
| picker.placeholder | Ágens | Agent |
| prompt.placeholder | Feladat leírása... | Task description... |
| btn.launch | Indítás | Launch |
| toggle.includeFinished | Befejezettek is | Include finished |
| list.empty | Nincs háttérfeladat. | No background tasks. |
| list.errorHttp | Hiba a betöltésnél | Failed to load |
| list.errorNetwork | Nem sikerült betölteni | Could not load |
| card.finishedPrefix | Befejezve: | Finished: |
| card.btn.output | Kimenet | Output |
| card.btn.stop | Leállítás | Stop |
| status.running | Fut | Running |
| status.done | Kész | Done |
| status.failed | Hiba | Failed |
| status.timeout | Időtúllépés | Timed out |
| modal.titlePrefix | Háttérfeladat | Background task |
| modal.btn.close | Bezárás | Close |
| modal.noOutput | (nincs kimenet) | (no output) |
| toast.chooseAgent | Válassz ágenst | Choose an agent |
| toast.enterTask | Add meg a feladatot | Enter the task |
| toast.started | Háttérfeladat elindítva | Background task started |
| toast.startFailedGeneric | Hiba történt | Something went wrong |
| toast.startFailedNetwork | Nem sikerült elindítani | Failed to launch |
| toast.loadDetailFailed | Nem sikerült betölteni | Could not load |
| confirm.stop | Biztosan leállítod? | Are you sure you want to stop it? |
| toast.stopped | Leállítva | Stopped |
| toast.stopFailed | Nem sikerült leállítani | Could not stop |
| error.capReached (server, 429) | Maximum 3 egyidejű háttérfeladat ágensenként. | Maximum of 3 concurrent background tasks per agent. |

Server-side validation messages also ship localized: missing prompt (HU `Prompt megadása kötelező` / EN `Prompt is required`), missing agent (HU `Agent ID megadása kötelező` / EN `Agent ID is required`), not-found (HU `Háttérfeladat nem található` / EN `Background task not found`).

---

## BUILD CHECKLIST (acceptance)
- [ ] Sidebar entry "Háttér" with a terminal/monitor line icon; hash-deep-linkable; activates the view.
- [ ] Header with title + subtitle; control bar with agent select, prompt input, Launch button, "include finished" checkbox.
- [ ] Agent picker populated from the roster endpoint **including the main agent**, main agent first; auto-select if only one.
- [ ] Launch posts `{agent_id, prompt}`; handles 201/400/429/error; clears prompt + toast on success; Enter-to-launch; button disabled in-flight.
- [ ] Task list via `GET /api/background-tasks` with agent + all params; cards show ID, status pill, agent pill, started label, prompt, finished label, output tail.
- [ ] Running cards (only) show Output + Stop buttons; finished cards show inline output and no buttons.
- [ ] Output modal fetches single-task detail (live snapshot for running), close via button or backdrop.
- [ ] Stop = confirm → DELETE → marks failed/"cancelled" → toast + reload.
- [ ] Four statuses with correct colors + localized labels; left-edge accent matches status.
- [ ] 10s auto-refresh while view active; per-agent cap of 3 enforced server-side with atomic check and 429 surfaced; 30-min timeout finalizes as `timeout`; orphan sweep on restart.
- [ ] All strings HU default + EN; output always HTML-escaped.
- [ ] Look/feel deferred to `01-design.md`.
