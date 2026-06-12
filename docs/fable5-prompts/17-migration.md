# Build Prompt — Migration (Költöztetés) View

> **Clean-room notice.** This is an original behavioral + visual specification written for an engineer ("Fable 5") who has never seen the reference product. Implement it from scratch. Do not seek, copy, or reproduce any source code, identifiers, file names, internal routes, or database schema from any existing system. Everything below describes *what the screen must do and look like* — observable behavior and contract — not how any prior code expresses it. For all visual styling (colors, spacing, typography, card chrome, button shapes, spinners, toasts, stat-card look), defer to **01-design.md**; this document defines structure and behavior only.

---

## 1) PURPOSE & WHERE IT LIVES

### What it is
The **Migration** view is a guided, three-step wizard that imports an **existing / legacy AI-assistant setup** from a folder on the host into one of *this* system's agents. "Migration" here means **bringing an old assistant's brain across**: its accumulated memories, its personality/persona document, the user/owner profile it knew, its heartbeat (periodic-behavior) config, schedules, daily logs, and general config/instruction files. The wizard **scans a source folder, lists what it found, then on confirmation reads those files, breaks their content into bite-size pieces, auto-classifies each piece into a memory tier, and writes them into the chosen agent's long-term memory store.** The end state is that the target agent "remembers" everything the old assistant knew.

It is explicitly aimed at users moving over from another personal-AI / assistant framework (the source-path placeholder hints at a workspace folder of a different tool). It is a one-way *import into our memory system*, not a sync and not a file copy.

### Where it lives
- **Left navigation:** a top-level sidebar entry labeled **Költöztetés** (HU, default) / **Migration** (EN).
- **Icon idea:** an "upload / move-in" glyph — an upward arrow rising out of an open tray/inbox (an "import into the house" feel). Any clean line-icon conveying *arrow-up-from-a-container* works. Keep it single-stroke to match the other sidebar icons (defer exact stroke weight to 01-design.md).
- **Page header:**
  - Title (H1): **Költöztetés** / **Migration**
  - Subtitle: **Korábbi AI asszisztens rendszer átmigrálása** / **Migrate an earlier AI-assistant system over**

### Navigation behavior
- Selecting the nav entry shows the Migration page and hides all others (standard single-page view switch).
- **On entering the page**, the target-agent dropdown (Step 1) is populated by fetching the current agent roster (see §6). This refresh happens every time the page is opened, so newly created agents appear.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only)

A single centered content column (wizard width, not full-bleed). Top: the page header (title + subtitle). Below it: a **wizard container** that holds three sequential "step" panels stacked in the DOM. Exactly one step panel is visible at a time; the other two are hidden.

- **Step 1 — Source (Forrás megadása):** a small form panel.
- **Step 2 — Findings (Találatok):** a results panel — a scrollable list of found items, a summary stat row beneath it, and an action bar.
- **Step 3 — Result (Eredmény):** a completion panel — a success block with stat tiles and a detail log, plus a reset button.

Each step panel carries a small numbered heading (e.g. "1. …", "2. …", "3. …"). The wizard advances forward (1→2→3) and can step back from 2→1, and reset from 3→1. There is no global progress bar required; the numbered headings carry the sense of progression. Styling, card borders, and the stat-tile look come from 01-design.md (reuse the same stat-card component used elsewhere in the app for the summary and result tiles).

---

## 3) CONTROLS (every interactive element)

### Step 1 — Source
| Control | HU label | EN label | Type | Behavior |
|---|---|---|---|---|
| Source path | **Workspace / mappa útvonala** | **Workspace / folder path** | Single-line text input | The absolute filesystem path of the legacy assistant's folder to scan. **Placeholder text** (example path hinting at a third-party assistant workspace): e.g. `/Users/username/.someassistant/workspace` — a representative home-dir workspace path; do **not** reuse any real product's exact folder name, just convey "a hidden tool-workspace folder under the user's home." Required. |
| Target agent | **Cél ügynök** | **Target agent** | Dropdown (select) | Which of this system's agents will *receive* the imported memories. Populated on page open from the roster (see §6). The first option is the main orchestrator agent (shown by its display name); the rest are the other agents by name. Defaults to the first (main) agent. |
| Scan button | **Feltérképezés** | **Scan** / **Map out** | Primary button | Triggers the scan of the source path. While running, the button is disabled and its label swaps to a spinner + **Keresés...** / **Scanning...**. |

**Step 1 validation:** if the path field is empty when Scan is pressed, do nothing except focus the path input (no toast).

### Step 2 — Findings
| Control | HU label | EN label | Type | Behavior |
|---|---|---|---|---|
| Back | **Vissza** | **Back** | Secondary button | Returns to Step 1 (re-show Step 1, hide Step 2). The previously scanned findings are kept in memory but the path/agent inputs retain their values; pressing Scan again re-scans. |
| Start migration | **Költöztetés indítása** | **Start migration** | Primary button | Runs the import of *all* listed findings into the selected target agent. While running, disabled with spinner + **Költöztetés...** / **Migrating...**. |

> **No per-item selection in this version.** The findings list is informational; "Start migration" imports **every** finding shown. (If Fable 5 wants per-item checkboxes, that is an enhancement — see §6 note — but the baseline contract is "import all found.")

### Step 3 — Result
| Control | HU label | EN label | Type | Behavior |
|---|---|---|---|---|
| New migration | **Új költöztetés** | **New migration** | Secondary button | Resets the wizard to Step 1 (hide Steps 2 & 3, show Step 1) so the user can run another import. |

There are **no** filters, search box, tabs, toggles, or sort controls anywhere in this view.

---

## 4) LISTS / CARDS / TABLES

### The Findings list (Step 2)
A vertical list. **One row per discovered file.** Each row shows exactly three things, left to right:

1. **Type icon** — a small emoji/glyph chosen by the finding's *type* (see type table below). Falls back to a generic document glyph for unknown types.
2. **Info block** (two stacked lines):
   - **Name** — the file's base name (e.g. `MEMORY.md`), HTML-escaped.
   - **Type label** — the human label for the type (HU; see table). Falls back to the raw type string if unmapped.
3. **Size** — file size shown in **KB**, rounded to one decimal (e.g. `12.4 KB`).

No per-row menu, no per-row action, no expand. Rows are read-only.

**Empty list:** if the scan returns zero findings, the list area shows a centered muted message: **Nem található migrálható tartalom** / **No migratable content found**.

#### Finding types, icons, and labels
The scanner assigns each file one of these types. Spec the icon + label pairs:

| Type (concept) | Icon idea | HU label | EN label |
|---|---|---|---|
| Personality / persona doc | 🎭 mask | **Személyiség** | **Personality** |
| User/owner profile | 👤 person | **Felhasználói profil** | **User profile** |
| Generic memory | 🧠 brain | **Memória** | **Memory** |
| Hot memory (active/urgent) | 🔥 fire | **Hot memória** | **Hot memory** |
| Warm memory (prefs/config) | 🌡️ thermometer | **Warm memória** | **Warm memory** |
| Cold memory (archive/lessons) | ❄️ snowflake | **Cold memória** | **Cold memory** |
| Heartbeat config | 💓 heartbeat | **Heartbeat konfig** | **Heartbeat config** |
| Configuration / instructions | ⚙️ gear | **Konfiguráció** | **Configuration** |
| Daily log | 📋 clipboard | **Napi napló** | **Daily log** |
| Schedule / cron | ⏰ alarm clock | **Ütemezés** | **Schedule** |
| (unknown) | 📄 page | (raw type string) | (raw type string) |

### The Summary stat row (Step 2, beneath the list)
A row of four **stat cards** (reuse the app's standard stat-card component). Each card shows a large number over a small caption:

| Card value | HU caption | EN caption | What it counts |
|---|---|---|---|
| total count | **Összesen** | **Total** | all findings |
| memory count | **Memória** | **Memory** | findings whose type is any memory variant (generic/hot/warm/cold) |
| profile count | **Profil** | **Profile** | personality findings + user-profile findings combined |
| config count | **Konfig** | **Config** | configuration findings + heartbeat findings combined |

### The Result stat tiles (Step 3)
After a successful run, a success block (see §5) shows **five** result stat tiles:

| Tile value | HU caption | EN caption | Color accent (concept) |
|---|---|---|---|
| imported total | **Importálva** | **Imported** | neutral/default text |
| hot count | **Hot** | **Hot** | red accent |
| warm count | **Warm** | **Warm** | warm orange accent |
| cold count | **Cold** | **Cold** | cool blue accent |
| shared count | **Shared** | **Shared** | muted gold/olive accent |

(Exact accent hues live in 01-design.md; the point is each tier has its own accent and the four tier tiles sit beside the "imported" total.)

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

This view has **no modals, no overlays, no slide-in detail panes, and no confirmation dialogs.** The entire experience is the three inline step panels. The only "detail" surfaces are:

### Step 3 success block (inline, not a modal)
Shown after a successful import. Contents, top to bottom:
- **Heading:** **Költöztetés kész!** / **Migration complete!**
- **Result stat tiles:** the five tiles from §4 (Imported / Hot / Warm / Cold / Shared).
- **Detail log:** a small multi-line block listing human-readable notes about what was imported, one note per line (HTML-escaped). Typical lines (concept-level, generated by the run — phrase originally):
  - `Személyiség: <filename>` — for each personality file imported
  - `Profil: <filename>` — for each profile file imported
  - `Heartbeat: <filename>` — for each heartbeat file imported
  - `<N> memória chunk feldolgozva` / `<N> memory chunks processed` — a single summary line for the bulk memory/config/log content
  - The detail block is omitted entirely if there are no notes.

### Transient feedback (toasts)
- Errors surface as a **toast** (the app's standard toast component), e.g. `Hiba: <message>` / `Error: <message>`. No error modal.

---

## 6) FLOWS & BEHAVIOR (step by step + contract)

### Flow A — Populate target-agent dropdown (on page open)
1. When the Migration page becomes visible, call the **roster endpoint** (GET, returns the list of agents: each with a machine name and a display label; the main orchestrator agent is first, by its configured display name; the rest follow by name).
2. Clear and repopulate the **Cél ügynök / Target agent** dropdown: each option's value = the agent's name, visible text = its label (or name).
3. Failures are swallowed silently (dropdown may be empty — acceptable degraded state).

### Flow B — Scan (Step 1 → Step 2)
1. User enters a source path and (optionally) picks a target agent, presses **Feltérképezés / Scan**.
2. If the path is blank, focus the input and stop (no request).
3. Show the button's loading state.
4. **Call the scan API** (POST) with the source path. Contract:
   - **400** if the path is empty/blank → error message: **Útvonal megadása kötelező** / **Path is required**.
   - **404** if the path does not exist on disk → **A megadott útvonal nem létezik** / **The given path does not exist**.
   - **200** otherwise, returning: the echoed source path, an array of **findings** (each: type, full path, base name, byte size), and a **summary** object with per-category counts and a total.
5. **What the scan does server-side (behavior to replicate):**
   - Looks for a fixed set of **known files by relative path** and assigns each a specific type when present. The known set (concept → type):
     - top-level long-term memory doc → **cold memory**
     - a "hot" memory file under a `memory/hot/…` path → **hot memory**
     - a "warm" memory file under a `memory/warm/…` path → **warm memory**
     - a persona/soul document → **personality**
     - a user/owner profile document → **profile**
     - a heartbeat document → **heartbeat**
     - one or more agent/tools/instruction docs (e.g. an `AGENTS`, `TOOLS`, and a root instruction file) → **config**
   - Then **scans a handful of likely subfolders** plus the root (concept: a `memory` folder, an alternate `memories` folder, a `bank` folder, a `notes` folder, and the root itself). In each, it lists files ending in `.md`, `.txt`, or `.json`, **excluding** common project-manifest files (package manifest, lockfile, TS config, an MCP config). Already-found files are skipped (dedupe by full path).
   - For each newly found file it requires it to be a real file **larger than ~20 bytes**, then **infers a type from the file name** (case-insensitive): names containing "soul"/"personality" → personality; "user"/"profile" → profile; "heartbeat" → heartbeat; "cron"/"schedule" → schedule; names that start with a `YYYY-MM-DD` date → daily-log; everything else → generic memory.
   - Builds the **summary counts**: personality, profile, memory (all memory-prefixed types), heartbeat, config, daily-log, schedule, and total.
6. On success: store the findings client-side, render the findings list + summary (§4), hide Step 1, show Step 2.
7. On error (non-2xx or network): toast `Hiba: <message>` and remain on Step 1.
8. Always restore the button from its loading state when finished.

### Flow C — Back (Step 2 → Step 1)
- Pressing **Vissza / Back** simply re-shows Step 1 and hides Step 2. No request. Inputs and findings are preserved.

### Flow D — Run migration (Step 2 → Step 3)
1. User presses **Költöztetés indítása / Start migration**.
2. **There is NO confirmation dialog and NO dry-run/preview vs. apply distinction in the baseline.** The scan/findings list *is* the preview; pressing Start performs the real import immediately. (See the "Dry-run gap" note below — Fable 5 should consider adding a confirm step since this writes persistent memory.)
3. Show the button loading state.
4. **Call the run API** (POST) with the full findings array and the chosen target agent name (if none chosen, the main agent is used as default). The import is **synchronous** — the request does not return until all content is imported, so the spinner may run for a while on large sources (each memory chunk involves a local-model categorization call; see below).
5. **What the run does server-side (behavior to replicate):**
   - **Personality findings:** read up to ~3000 chars of each, store as a single **warm** memory tagged as imported personality (keywords like "personality, soul, import"). One per file. Adds a detail line `Személyiség: <name>`.
   - **Profile findings:** same, stored as **warm**, tagged imported user profile. Detail line `Profil: <name>`.
   - **Heartbeat findings:** read up to ~2000 chars, stored as **warm**, tagged imported heartbeat config. Detail line `Heartbeat: <name>`.
   - **Bulk content** (all memory-type findings + config + daily-log): read each file and **split into chunks**:
     - `.json` files: if an array, one chunk per element (use the element's content/text field, else stringify); if an object, one chunk per key as `key: value`; if unparseable, the whole text as one chunk.
     - `.md` files: split on Markdown headings (`#`/`##` boundaries).
     - other text: split on blank-line paragraph breaks.
     - Keep only chunks longer than ~20 chars; cap each chunk at ~2000 chars.
   - **Categorize each chunk with a local model:** query the local model runtime for available models, pick a small general model (prefer a "gemma"-family small model, else the first non-embedding model). For each chunk, ask the model to return JSON `{"tier": "...", "keywords": "..."}` where tier ∈ {hot, warm, cold, shared} (hot = active/urgent, warm = preferences/config, cold = lessons/archive, shared = multi-agent). Parse the JSON; default to **warm** if anything is invalid or the model is unavailable. Store the chunk under the chosen tier with the model's keywords. Brief pause (~200 ms) between chunks to avoid hammering the model. On any per-chunk failure, fall back to storing it as **warm** with no keywords.
   - Track counts: total **imported** and per-tier `hot/warm/cold/shared`. Add a detail line `<N> memória chunk feldolgozva`.
   - Every stored memory is flagged **auto-generated** and triggers async embedding generation for later semantic search (fire-and-forget; the run does not wait on embeddings).
6. **Response contract:** `{ ok, imported, stats:{hot,warm,cold,shared}, details:[...] }`.
7. On success: hide Step 2, show Step 3, render the success block (§5).
8. On error: toast `Hiba: <message>`, stay on Step 2.
9. Always restore the button from loading.

### Flow E — New migration (Step 3 → Step 1)
- **Új költöztetés / New migration** resets to Step 1 (hide 2 & 3). The path/agent fields keep their prior values; the user can change them and scan again.

### Dry-run gap (important note for Fable 5)
The baseline has **no dry-run toggle, no per-finding checkboxes, and no destructive-action confirmation** — Start imports everything immediately and persistently. Because this writes durable memory into an agent, **the recommended (optional) enhancement** is: (a) per-finding include/exclude checkboxes in Step 2, and (b) a lightweight confirm ("Import N items into agent X?") before the run. If you keep the baseline-faithful version, at minimum make the "Start migration" button visually weighty/primary and the findings list clearly the preview. Document whichever you choose.

---

## 7) STATES

- **Initial / empty:** Step 1 visible with empty path field and a populated (or empty) agent dropdown. No findings yet.
- **Scanning (loading):** Scan button disabled, spinner + "Keresés... / Scanning...". Other controls untouched.
- **No findings:** Step 2 shows the centered muted "Nem található migrálható tartalom" message; the summary row still renders with zeros; **Start migration** is still pressable but will import nothing (consider disabling it when total = 0 — recommended).
- **Migrating (loading):** Start button disabled, spinner + "Költöztetés... / Migrating...". This can be **long-running** (per-chunk model calls); keep the spinner up the whole time. There is no progress percentage in the baseline (optional enhancement: a "X / N chunks" live counter, but the baseline import is a single synchronous call with no streamed progress).
- **Error states:**
  - Empty path on scan → silent focus, no error.
  - Path missing (404) → toast "A megadott útvonal nem létezik".
  - Path required (400) → toast "Útvonal megadása kötelező".
  - Any other scan/run failure or network error → toast `Hiba: <message>`; the wizard stays on its current step so the user can retry.
- **Success:** Step 3 with the success block and stat tiles.
- **Live-update / polling:** none. Nothing on this page polls or auto-refreshes. The only "refresh" is the agent dropdown repopulating each time the page is opened.

---

## 8) PERMISSIONS / VISIBILITY

- This is an **operator-facing administrative tool.** It is part of the human operator's control surface (the same dashboard that hosts agent management, MCP/connectors, status, etc.). Treat it as **operator-only**: agents do not drive this wizard themselves.
- The action is **privileged** — it writes persistent long-term memory into a chosen agent. There is **no autonomy-level gating in the baseline** (no "needs approval at level X"), because the human operator is the one clicking. If your system has a role model, gate the entire Migration nav entry + both endpoints behind the **operator** role; an agent identity should never be able to call the run endpoint to inject memories into another agent (that would be a privilege/trust concern).
- No sub-permission differences inside the view (no fields that appear only for some roles).

---

## 9) DATA CONCEPTS (read / written, concept-level)

**Read (from the source folder on disk):**
- A persona/personality document.
- A user/owner profile document.
- A heartbeat/periodic-behavior config.
- Long-term memory documents in tiers (hot/warm/cold) and generic memory notes.
- Config/instruction documents (agent list, tool list, root instructions).
- Schedules/cron files and dated daily-log files.
- Arbitrary `.md` / `.txt` / `.json` notes in a few likely subfolders, excluding project-manifest files.

**Written (into this system):**
- **Agent memory records.** Each is: a target agent id, the text content, a **tier/category** (hot | warm | cold | shared), optional **keywords**, an **auto-generated** flag (true for all imports), and timestamps. Each new memory also kicks off **async embedding generation** so it becomes searchable by semantic similarity later.
- Personality/profile/heartbeat are written as single warm memories with descriptive import tags; bulk content is written as many tier-classified chunks.

**External dependency:** a **local model runtime** (LLM server) is queried to (a) list models and (b) categorize each chunk's tier + keywords. If unavailable, everything still imports but defaults to the **warm** tier with empty keywords — the migration must not fail just because the local model is down.

**Nothing is deleted, moved, or modified on the source disk.** The source folder is read-only to this tool.

---

## 10) i18n — ALL STRINGS (HU default + EN)

Ship Hungarian as default, English as the alternate. Full table:

| Key (concept) | HU (default) | EN |
|---|---|---|
| Nav label | Költöztetés | Migration |
| Page title | Költöztetés | Migration |
| Subtitle | Korábbi AI asszisztens rendszer átmigrálása | Migrate an earlier AI-assistant system over |
| Step 1 heading | 1. Forrás megadása | 1. Specify source |
| Path label | Workspace / mappa útvonala | Workspace / folder path |
| Path placeholder | /Users/username/.someassistant/workspace | /Users/username/.someassistant/workspace |
| Target agent label | Cél ügynök | Target agent |
| Scan button | Feltérképezés | Scan |
| Scan loading | Keresés... | Scanning... |
| Step 2 heading | 2. Találatok | 2. Findings |
| Back button | Vissza | Back |
| Start migration button | Költöztetés indítása | Start migration |
| Migrating loading | Költöztetés... | Migrating... |
| Step 3 heading | 3. Eredmény | 3. Result |
| Success heading | Költöztetés kész! | Migration complete! |
| New migration button | Új költöztetés | New migration |
| Empty findings | Nem található migrálható tartalom | No migratable content found |
| Summary: total | Összesen | Total |
| Summary: memory | Memória | Memory |
| Summary: profile | Profil | Profile |
| Summary: config | Konfig | Config |
| Result tile: imported | Importálva | Imported |
| Result tile: hot | Hot | Hot |
| Result tile: warm | Warm | Warm |
| Result tile: cold | Cold | Cold |
| Result tile: shared | Shared | Shared |
| Detail: personality line | Személyiség: {name} | Personality: {name} |
| Detail: profile line | Profil: {name} | Profile: {name} |
| Detail: heartbeat line | Heartbeat: {name} | Heartbeat: {name} |
| Detail: chunks line | {n} memória chunk feldolgozva | {n} memory chunks processed |
| Type label: personality | Személyiség | Personality |
| Type label: profile | Felhasználói profil | User profile |
| Type label: memory | Memória | Memory |
| Type label: hot memory | Hot memória | Hot memory |
| Type label: warm memory | Warm memória | Warm memory |
| Type label: cold memory | Cold memória | Cold memory |
| Type label: heartbeat | Heartbeat konfig | Heartbeat config |
| Type label: config | Konfiguráció | Configuration |
| Type label: daily log | Napi napló | Daily log |
| Type label: schedule | Ütemezés | Schedule |
| Error: path required | Útvonal megadása kötelező | Path is required |
| Error: path missing | A megadott útvonal nem létezik | The given path does not exist |
| Error: generic prefix | Hiba: {message} | Error: {message} |
| Unit | KB | KB |

---

### Implementation summary for Fable 5
Build a centered 3-step wizard. Step 1 collects a folder path + a target agent (dropdown loaded from the roster on open). "Scan" POSTs the path; the server walks known files + a few subfolders, classifies each found file by name/location into typed findings, and returns them with per-category counts. Step 2 renders the findings as icon+name+type+size rows plus a 4-stat summary; "Start migration" POSTs all findings + the target agent. The server reads each file, splits content into ≤2000-char chunks, asks a local LLM to assign each chunk a memory tier (hot/warm/cold/shared) + keywords (default warm if the model is down), and writes them all as auto-generated agent memories (with async embeddings). Step 3 shows totals and per-tier counts plus a short detail log, and lets the user start over. No modals, no polling, no dry-run/confirm in baseline (consider adding a confirm + per-item selection since this writes durable memory). Operator-only. HU default, EN alternate. All look-and-feel per 01-design.md.
