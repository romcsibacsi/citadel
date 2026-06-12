# Build Prompt — "Updates / Frissítések" View (Fable 5)

> CLEAN-ROOM NOTICE — You (Fable 5) have never seen the reference product. This document is an ORIGINAL behavioral + visual specification: it describes WHAT the screen must look like and do, never HOW any existing code expresses it. Implement everything from scratch in your own architecture, your own names, your own markup and queries. Do not ask for or reproduce any source code, identifiers, file names, or database schema. Where this spec says "calls an endpoint," design your own route shape consistent with the rest of your app. For all visual styling (colors, spacing, typography, component look), defer to `01-design.md` — this document specifies structure and behavior only.

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** This view is the operator's one-click "is there a newer build, and may I install it safely?" surface for the CITADEL application itself. It answers three questions: (a) what version am I running, (b) is a newer version available on my own source repository, and (c) what changed. It then lets the operator apply the update in place — pull the new code, rebuild, and restart the running services — with a chain of safety pre-checks that REFUSE to proceed when applying an update would be dangerous or guaranteed to fail. This is a **self-update** surface: the app updates its own running code, so safety and honesty about failure are the dominant design concerns.

**Where it lives.** A primary item in the left navigation sidebar.
- Nav label: **"Frissítések"** (HU, default) / **"Updates"** (EN).
- Icon idea: a circular-arrows "refresh / sync" glyph (two arrows chasing each other in a loop) — the universal "check for new version" mark. Keep it line-style to match the other sidebar icons.
- **Nav badge.** The nav item carries a small count badge on its right edge. When the app is behind by N commits, the badge shows the integer N; when up-to-date (or status unknown), the badge is hidden entirely. The badge is driven by a background poll (see §7) so it stays correct even while the operator is on a different view.

**Page header.**
- Title (H1): **"Frissítések"** / **"Updates"**.
- Subtitle (muted, smaller): **"CITADEL verzió-ellenőrzés"** / **"CITADEL version check"**.

---

## 2) PAGE LAYOUT & APPEARANCE

Single scrollable column, no sub-tabs. Top to bottom:

1. **Header row** — left side: title + subtitle. Right side: an action cluster holding two buttons side by side (see §3): a secondary "Check" button and a primary "Update now" button. The "Update now" button is hidden unless an update is actually available.
2. **Status summary block** — a full-width banner directly under the header. It is a single prominent box whose appearance and text change with state (up-to-date / behind / error / loading). It shows the short current revision id, and when behind, the short target revision id and the count + source repo. This is the emotional center of the page; it should read instantly.
3. **Changelog section** — a labeled section titled **"Változások"** / **"Changes"**, containing a vertical list of change entries (one per incoming commit). Empty when up-to-date or when status is unknown.

All visual treatment (banner color variants, card chrome, list row styling, button styling, spinner) is specified in `01-design.md`. This section defines only the block order and that the status block is visually dominant.

---

## 3) CONTROLS

Every interactive control on the page, with bilingual labels:

| Control | HU label | EN label | Type | What it does |
|---|---|---|---|---|
| Check button | **Ellenőrzés** | **Check** | Secondary button (with refresh icon) | Forces a fresh remote check (see §6 Flow A). Disables itself while the check is in flight, re-enables on completion. |
| Update-now button | **Frissítés most** | **Update now** | Primary button | Begins the apply flow (see §6 Flow B). Hidden whenever no update is available or status is in error. Has two visual states: idle (shows its text label) and busy (shows an inline spinner, label hidden, button disabled). |

There are no text fields, dropdowns, toggles, filters, search boxes, or tabs on this page itself. The only "toggle"-like behavior is an implicit auto-stash choice surfaced as a confirmation dialog during the apply flow (see §5 and §6), not as a persistent control.

> Configuration note (not on this page): the source repository (owner/repo) and an optional access token for a private repository are configured elsewhere in the app's settings surface, NOT here. This page only consumes those settings. If the repo is unset, this page shows a helpful error (see §7). When you build the settings surface, expose:
> - **"GitHub repó (frissítés-forrás)"** / **"GitHub repo (update source)"** — free text, placeholder like `owner/repo`. Plain (non-secret) value.
> - **"GitHub token (privát repóhoz)"** / **"GitHub token (for private repo)"** — secret value, stored encrypted; placeholder hinting a token format. Only needed when the source repo is private.

---

## 4) LISTS / CARDS / TABLES

### 4a) Status summary block (single dynamic banner)

Not a list — one banner that renders one of four mutually exclusive contents. In every non-loading state it shows the **short current revision id** (first 7 characters of the running revision, or an en-dash placeholder if unknown). Concrete contents:

- **Loading:** plain text "Ellenőrzés…" / "Checking…", neutral styling.
- **Up-to-date:** bold lead "A legfrissebb verzión vagy" / "You're on the latest version", followed by the short current revision id in monospace, then "Nincs teendő." / "Nothing to do."
- **Behind (update available):** bold lead "{N} új commit elérhető" / "{N} new commits available", a clause naming the source repo in monospace, then a "current → latest" line showing both short revision ids in monospace ("Jelenlegi: {cur} → Legfrissebb: {lat}" / "Current: {cur} → Latest: {lat}").
- **Error:** bold lead "Nem sikerült ellenőrizni:" / "Couldn't check:" followed by the error message, and on a new line the short current revision id ("Jelenlegi: {cur}" / "Current: {cur}").

No per-item actions on the banner; it is informational only.

### 4b) Changelog list ("Változások" / "Changes")

A vertical list of change entries, newest first. Each entry shows EXACTLY:
- **Header line (two ends):**
  - Left: short revision id (7 chars) · author name, separated by a middle dot.
  - Right: the commit date as a plain `YYYY-MM-DD` calendar date (date only, no time).
- **Body line:** the first line of the commit message (subject only; multi-line bodies are truncated to the first line).

Entries are read-only. No per-item menu, no per-item buttons, no expand/collapse, no links out. When up-to-date, the list area shows a muted single line "Nincs változás." / "No changes." When status is unknown/error, the list is empty.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

This view has no detail panes or rich modals. It uses two **native confirm/alert-style dialogs** and ephemeral toast notifications. Specify them fully:

### 5a) Apply confirmation (blocking confirm)
Triggered the moment the operator clicks "Frissítés most" / "Update now", before anything else happens.
- Message (HU): "Frissítés most. A szolgáltatások újraindulnak, a dashboard ~30 másodpercig nem érhető el. Folytatod?"
- Message (EN): "Update now. Services will restart and the dashboard will be unavailable for ~30 seconds. Continue?"
- Buttons: OK / Cancel (native). Cancel aborts with no side effects. OK proceeds to the apply flow.

### 5b) Auto-stash retry confirmation (blocking confirm)
Triggered ONLY if the first apply attempt is refused specifically because the working tree has uncommitted local changes (the "dirty tree" refusal), AND auto-stash was not already requested.
- Message (HU): "A working tree-ben lokális változtatások vannak. Stash-eljem őket automatikusan, frissítsek, majd visszaállítsam?"
- Message (EN): "There are local changes in the working tree. Should I stash them automatically, update, then restore them?"
- Buttons: OK / Cancel. OK re-runs the apply flow WITH the auto-stash hint set (which tells the backend to stash-before / restore-after). Cancel aborts; nothing is applied.

### 5c) Toasts (ephemeral, non-blocking)
- On successful apply start: "Frissítés elindult, a dashboard újratöltődik…" / "Update started, the dashboard will reload…".
- On refused/failed apply (other than the dirty-tree-offering-stash case): "Frissítés nem indult: {reason or error}" / "Update didn't start: {reason or error}". The reason text should be the backend's human-readable message, not a bare status code.
- On unexpected network/JS error during apply or check: "Hiba: {message}" / "Error: {message}".

There are no other modals, side panels, or expandable cards.

---

## 6) FLOWS & BEHAVIOR

### Flow A — Check for updates ("Ellenőrzés" / "Check")
1. Operator clicks the Check button. Button disables.
2. App calls a "force a remote check" endpoint (POST-style, idempotent re-poll). Conceptually: refresh the cached comparison between the running revision and the source repo's tracked branch tip.
3. After that returns (success or failure), the app re-reads the cached status (a GET-style "current status" endpoint) and re-renders the whole page from it: status banner, changelog, and the nav badge.
4. Button re-enables.

The backend force-check, conceptually, does this: read the local running revision id; read the local branch name (the app tracks whichever branch it is actually on, NOT a hardcoded branch); resolve the configured source repo (explicit setting first, else process env, else auto-detect from a configured remote — with NO fallback to any upstream/origin project; this hardened design tracks only the operator's own mirror). Then query the source repo's API for the tip of that same branch, compare it to the local revision, and if behind, list the commits between local and remote (count + per-commit subject/author/date), newest first. The result is cached in memory.

### Flow B — Apply the update ("Frissítés most" / "Update now")
1. Operator clicks Update now → show confirm 5a. Cancel aborts.
2. On OK, button switches to busy (spinner, disabled).
3. App calls an "apply update" endpoint (POST-style) with a body carrying an `autoStash` boolean hint (false on the first attempt).
4. The backend runs a **preflight + concurrency gate** (see §6c). If it refuses, it returns a conflict-style status with a machine reason code AND a human message. The frontend parses the body even on a non-OK status so the real reason reaches the toast (never a bare "HTTP 409").
   - If the refusal reason is specifically "dirty tree" and auto-stash was not requested: reset the button to idle and show confirm 5b. On OK, recursively re-run Flow B from step 3 with `autoStash = true`. On Cancel, stop.
   - Any other refusal (wrong branch, detached HEAD, concurrent update already running, internal errors): reset the button to idle and toast the reason.
5. On an OK response (the backend has successfully spawned the detached update process), toast "Frissítés elindult…", leave the button busy, and schedule a full page reload after ~30 seconds (because the services — including this dashboard — will restart mid-update).

### 6c) Preflight, concurrency gate, and the update process (backend behavior contract)

This is the safety core. Reproduce this behavior faithfully (in your own implementation):

**Concurrency gate (no two updates at once).** The apply endpoint must guarantee only one update runs at a time, and the gate must survive the dashboard restarting in the middle of a successful update. Design:
- A single on-disk lock marker (a "pid + start-timestamp" file) under the app's writable store directory represents an in-progress update.
- The dashboard creates this marker **atomically and exclusively** (create-if-not-exists; fail if it already exists) right before launching the updater. The launched update process then takes ownership of the marker, overwriting it with its own process id + a millisecond start epoch, and is responsible for removing it on exit (success or failure) via a cleanup trap. Because the dashboard does NOT own/remove the marker for the life of the run, the gate persists across the dashboard's own restart that happens inside a successful update.
- If creation fails because the marker already exists, check whether the recorded process is actually alive: if alive AND not older than a staleness cutoff → refuse with reason "already-running" and report the pid in the message ("Update already running (pid {N}). Wait for it to finish, then retry."). If the recorded process is dead, or the recorded start time is older than the staleness cutoff (guard against pid recycling after a hard kill / power loss — use ~1 hour, far above any normal update duration), treat the marker as stale, remove it, and re-attempt the exclusive create. If THAT re-create loses a genuine race (someone else just grabbed it), refuse with "already-running" / a "retry in a few seconds" message. Distinguish a true race (already-exists) from a real write failure (permission/read-only/no-space) — the latter returns a server-error status, not a conflict.
- A liveness probe should treat "exists but owned by another user" as alive (be conservative). Reserved low pids (0, 1) must never be treated as a live updater (so a corrupt marker can't permanently jam the button). Accept both a legacy "pid only" marker format and the preferred "pid + epoch" format.

**Preflight (refuse runs that would fail or be unsafe).** Before launching the updater, run synchronous git checks against the app's checkout and refuse with a conflict status + reason if any fail:
- **Detached HEAD** → reason `detached-head`. Message: explain the repo is in a detached-HEAD state and tell the operator to check out the main branch first. ALWAYS hard-blocks (auto-stash cannot rescue it).
- **Wrong branch** (not on the expected update branch — conceptually "main") → reason `not-on-main`, and include the offending branch name in the response. Message: explain a fast-forward-only pull cannot fast-forward a feature branch and tell the operator to switch to the main branch first. ALWAYS hard-blocks.
- **Dirty working tree** (staged or unstaged modifications to tracked files) → reason `dirty-tree`. Message: tell the operator to commit or stash before updating. This is the ONLY refusal that auto-stash can override: if the apply was requested with the auto-stash hint, skip this block and let the updater do a managed stash-then-restore.
  - Exclusions when judging "dirty": ignore untracked files entirely (the project legitimately carries ad-hoc backup/scratch files that must not block an update), and ignore a specific self-modifying status/heartbeat file that the agent rewrites continuously (it would otherwise make the tree perpetually "dirty"). Any OTHER tracked modification still blocks.
- If the preflight check itself throws, release any lock you grabbed and return a server-error status with a "pre-check failed" message.
- When refusing, release the concurrency lock you took (do not leave a stale lock).

**The update process itself (what "apply" actually does once preflight passes).** The dashboard launches a detached background script (the dashboard does not block on it; its output is appended to a rotating log file in the store directory) and immediately returns OK. The script, in order:
1. Re-asserts the same branch / detached-HEAD / dirty-tree guards itself (defense-in-depth for manual invocations) and honors the same auto-stash env hint.
2. If auto-stash requested and tree dirty: stash local changes (recording the stash so it survives), proceeding only if the stash succeeds.
3. Records the old short revision, then performs a **fast-forward-only pull** of the tracked branch from the configured remote. If the new revision equals the old, it reports "already latest" and exits cleanly (no restart).
4. If dependency manifests/lockfiles changed between old and new: install dependencies **strictly against the committed lockfile** (lock-exact, not a loose install — so a supply-chain-compromised semver-compatible package cannot sneak in on a patch), then run a high-severity security audit of the production tree. The audit is a LOUD WARNING, not a hard gate (it can fail for reasons outside the operator's control, and aborting mid-way would leave a half-upgraded install) — it warns and continues, leaving the rollback decision to the operator.
5. Rebuilds the app from the new source.
6. Runs idempotent post-update sync steps (e.g., syncing hooks, seeding new skills/scheduled-tasks/config that don't already exist, merging only new config categories without touching operator-set values, environment hygiene). These are all skip-if-present / additive — never destructive to operator data.
7. If it auto-stashed earlier: restore the stash. If restore conflicts, it does NOT block the restart — it drops to a warning and leaves the stash entry recoverable (so the operator never silently loses work).
8. Restarts the services (stop then start), which includes this dashboard — this is why the frontend schedules a reload ~30s out.
9. Cleans up its lock marker on exit (via the trap), regardless of success or failure.

> Destructive-action confirmations: the only destructive-ish action is the apply itself (restarts services, mutates the checkout). It is gated by confirm 5a, and the dirty-tree path is gated by the additional confirm 5b before any stashing occurs.

---

## 7) STATES

- **Loading:** on entering the page (and at the start of every Check), the status banner shows the neutral "Ellenőrzés…" / "Checking…" text and the changelog list is cleared. The Check button shows disabled while its request is in flight; the Update-now button shows a spinner state while an apply is in flight.
- **Empty / up-to-date:** banner in the "up-to-date" variant; changelog shows the muted "Nincs változás." / "No changes." line; Update-now button hidden; nav badge hidden.
- **Behind:** banner in the "behind" variant with counts and revision ids; changelog populated newest-first; Update-now button visible; nav badge shows N.
- **Error:** banner in the error variant with the backend's message and the current revision; Update-now button hidden; changelog empty. Specific, human error messages must be surfaced verbatim, e.g.:
  - No source repo configured → a message instructing the operator to set the update source repo (env or a github remote).
  - Detached HEAD → "no branch to compare against."
  - Source branch missing on the repo, or repo private with no access → a message saying that branch doesn't exist on that repo (or it's private / inaccessible).
  - Local revision not present on the remote (unpushed / different base) → a message saying the local HEAD isn't on the repo.
- **Permission denied / unauthenticated:** every data endpoint sits behind the dashboard's bearer-token auth (see §8). A request without/with a bad token fails auth at the transport layer; the page should degrade to the error banner ("Hiba: …" / "Error: …") rather than showing stale-but-wrong "up-to-date".
- **Live-update / poll behavior:**
  - The nav badge polls the cached status on app startup and then on a slow interval (~5 minutes) so the badge stays current on any view without opening this page.
  - The backend itself runs a background checker: a first check shortly after startup, then a recurring re-check on a ~15-minute cadence, updating the in-memory cache. The page and badge read that cache; the explicit Check button forces an immediate refresh.
  - The page does NOT auto-poll its own content while open beyond the shared badge poll; the operator drives freshness with the Check button. (You may add a gentle on-open refresh, which is what happens implicitly because entering the page triggers a status read.)

---

## 8) PERMISSIONS / VISIBILITY

- CITADEL is a **single-user, operator-facing** system. The entire dashboard — including all update endpoints (status read, force-check, apply) — is protected by a single shared **bearer token** (persisted in the app's store, also overridable by env). There is no per-user role matrix; "operator" effectively means "anyone holding the dashboard token in this browser session."
- **Agents are not given this surface.** Background agents authenticate to the same API with the same token for their own narrow tasks, but the Updates view (and especially the apply action) is an operator UI affordance, not an agent capability. Self-update is a human-in-the-loop decision by design: an agent must never trigger an in-place self-update of the host application on its own. Treat "apply update" as operator-only at the product level (gate it behind the dashboard UI and the confirm dialogs), even though the transport auth is a single token.
- **Autonomy gating:** the apply action is never auto-fired by autonomy logic — it is always an explicit operator click confirmed by dialog 5a (and 5b for the dirty path). Do not wire any scheduled/autonomous task to the apply endpoint. The only autonomous behavior permitted around updates is the read-only background CHECK that feeds the badge.

---

## 9) DATA CONCEPTS (read / written)

Concept-level, not schema:
- **Update status (read, cached):** running revision id (full + short), local branch name, source repo (owner/repo), target/latest revision id (full + short), "behind by N" count, a list of incoming commits (each: short id, full id, subject line, author name, ISO date), last-checked timestamp, and an optional error string.
- **System settings (read here, written elsewhere):** the configured source repo identifier (plain) and an optional access token for a private repo (secret, stored encrypted). Read at runtime so saving them takes effect without a restart.
- **Concurrency lock marker (written by apply / cleared by updater):** an on-disk "pid + start-epoch" file in the store directory; created exclusively by the dashboard, owned and removed by the update process.
- **Update log (written by updater):** an appended, size-rotated text log of each update run in the store directory, so a failed detached run is inspectable after the fact.
- The Updates view itself **writes nothing persistent** from the browser; it only triggers the force-check and apply endpoints and renders cached status.

---

## 10) i18n

Ship Hungarian (default) and English for every string. Canonical set:

| Key | HU (default) | EN |
|---|---|---|
| nav.label | Frissítések | Updates |
| page.title | Frissítések | Updates |
| page.subtitle | CITADEL verzió-ellenőrzés | CITADEL version check |
| btn.check | Ellenőrzés | Check |
| btn.apply | Frissítés most | Update now |
| changes.heading | Változások | Changes |
| status.loading | Ellenőrzés… | Checking… |
| status.uptodate.lead | A legfrissebb verzión vagy | You're on the latest version |
| status.uptodate.tail | Nincs teendő. | Nothing to do. |
| status.behind.lead | {N} új commit elérhető | {N} new commits available |
| status.behind.repo | a {repo} repón | on the {repo} repo |
| status.behind.delta.cur | Jelenlegi: {cur} | Current: {cur} |
| status.behind.delta.lat | Legfrissebb: {lat} | Latest: {lat} |
| status.error.lead | Nem sikerült ellenőrizni: | Couldn't check: |
| status.error.current | Jelenlegi: {cur} | Current: {cur} |
| changes.none | Nincs változás. | No changes. |
| confirm.apply | Frissítés most. A szolgáltatások újraindulnak, a dashboard ~30 másodpercig nem érhető el. Folytatod? | Update now. Services will restart and the dashboard will be unavailable for ~30 seconds. Continue? |
| confirm.autostash | A working tree-ben lokális változtatások vannak. Stash-eljem őket automatikusan, frissítsek, majd visszaállítsam? | There are local changes in the working tree. Should I stash them automatically, update, then restore them? |
| toast.apply.started | Frissítés elindult, a dashboard újratöltődik… | Update started, the dashboard will reload… |
| toast.apply.refused | Frissítés nem indult: {reason} | Update didn't start: {reason} |
| toast.error | Hiba: {message} | Error: {message} |
| err.no-repo | Nincs GitHub repó beállítva — állítsd be a frissítés-forrás repót (env vagy github remote). | No GitHub repo configured — set the update-source repo (env or a github remote). |
| err.detached | Detached HEAD — nincs ág a frissítés-összehasonlításhoz. | Detached HEAD — no branch to compare against for updates. |
| err.no-branch-on-repo | A repón nincs ilyen ág (vagy a repó privát és nincs hozzáférés). | That branch doesn't exist on the repo (or the repo is private and inaccessible). |
| err.head-not-on-repo | A lokális HEAD nincs a GitHub repón — nincs pusholva, vagy eltérő bázis? | The local HEAD isn't on the GitHub repo — not pushed, or a different base? |
| reason.already-running | Frissítés már fut (pid {N}). Várd meg, amíg befejeződik, majd próbáld újra. | Update already running (pid {N}). Wait for it to finish, then retry. |
| reason.not-on-main | A(z) '{branch}' branchről nem lehet frissíteni. Válts előbb a main branchre. | Can't update from branch '{branch}'. Switch to the main branch first. |
| reason.detached-head | A repó detached-HEAD állapotban van. Válts a main branchre a frissítés előtt. | Repository is in a detached-HEAD state. Check out main before updating. |
| reason.dirty-tree | A working tree-ben nem-commitolt változtatások vannak. Commitold vagy stasheld őket frissítés előtt. | The working tree has uncommitted changes. Commit or stash them before updating. |

Defaults to HU; EN selectable via the app's language switch. Implementable from scratch; defer all look-and-feel to `01-design.md`.
