> CLEAN-ROOM BUILD PROMPT — written from a behavioral/visual observation of a reference product. You (the implementing engineer, "Fable 5") have NEVER seen the original source. Build this ORIGINALLY from the description below. Do not seek, transcribe, or reproduce any original source code, identifiers, file names, or database schema. This document describes WHAT the screen looks like and HOW it behaves — design and implement the HOW yourself. For all visual styling (colors, spacing, typography, card shadows, badge shapes, spinner), defer to `01-design.md`; this file specifies structure and behavior only.

# 10 — Skills (Skillek) View

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** This view manages the reusable "skills" the AI fleet can invoke — packaged capability folders, each documented by a single markdown manifest. A skill is a named bundle (a folder containing at minimum a manifest file conventionally named `SKILL.md`, optionally plus helper assets) whose YAML front-matter carries a human-readable description and trigger guidance. The view exists so the operator can: see every skill the system can currently "see," read what each one does, create a new skill from a plain-language description (the system writes the manifest for them), import a pre-packaged skill archive, and (in the per-agent variant) attach/detach skills to a specific agent.

**Two-tier model (core concept).** Skills exist at two scopes and this product surfaces both:
- **Global / fleet scope ("Skillek" top-level page).** Skills that live in the shared home skills location of the host install. Because every sub-agent runs under the same shared HOME as the main session, anything in this global location is automatically available to *every* agent — there is no per-agent copy step required for a global skill to be usable. This page is the fleet-wide library.
- **Per-agent scope (a "Skills" tab inside an individual agent's detail panel — documented here for completeness, but it lives in the Agents view, file `0X-agents.md`).** Each agent additionally owns a small private skills set. At runtime an agent sees its own private skills *plus* all global skills (inherited). A private skill of the same name shadows (overrides) a global one.

**Where it lives in navigation.** A left sidebar nav item labelled **"Skillek"** (EN: **"Skills"**). Icon idea: a five-point star/badge outline (an "achievement / capability" glyph) at ~18px stroke style, matching sibling nav icons. Selecting it shows the global Skills page; deselecting hides it (single-page app, pages toggled by `hidden`).

**Subtitle under the page title (HU default + EN):**
- HU: "A Claude Code által látott skillek (user mappa + plugin cache)"
- EN: "The skills visible to the runtime (user folder + plugin cache)"

(Clean-room note: keep the subtitle generic about "the runtime" rather than naming a specific product, unless the host product name is intentionally retained elsewhere.)

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — styling → `01-design.md`)

Top to bottom on the global Skills page:

1. **Page header block.**
   - A header row with two parts: left = page title `Skillek` (H1) + the subtitle line above it/under it. Right = a primary action button **"Új skill"** (a compact primary button with a plus icon).
   - Below the header row: an **info box** (a soft callout panel) explaining the inheritance model and the limitation about built-in CLI slash-commands (see section 7 for exact text).

2. **Stats strip.** A horizontal row of small stat cards (count + label each). Populated after load. Cards described in section 4.

3. **Skills grid.** A responsive card grid; one card per skill. Cards described in section 4.

4. **Empty state.** A centered illustration glyph (a key/skill outline icon ~48px) plus a short message, shown only when there are zero skills. Hidden otherwise.

Two modals are reachable from this page (overlay dialogs centered over a dimmed backdrop):
- **Create/Import modal** (shared markup, two tabs).
- **Skill detail modal** (read-only viewer).

The per-agent variant (in the agent detail panel) is a simpler vertical list with its own "Új skill" button — see sections 4 and 5.

---

## 3) CONTROLS — every button / field / tab / upload (HU + EN labels)

### Global Skills page
- **"Új skill" button** (EN: "New skill"), primary, plus-icon. Opens the Create/Import modal pre-scoped to **global**. On open it: clears the name field, clears the description field, clears any staged file, resets the modal to the **Create** tab, and focuses the name input after a short delay.

### Create/Import modal (shared between global page and per-agent tab)
Header: title **"Új skill"** (EN: "New skill") + an **×** close button.

Two tab buttons at the top of the modal body:
- **Tab "Létrehozás"** (EN: "Create") — generate a skill from a description. Active by default.
- **Tab "Importálás"** (EN: "Import") — upload a packaged skill archive.

Clicking a tab toggles which panel is visible and highlights the active tab.

**Create tab fields:**
- **Text input "Skill neve"** (EN: "Skill name"). Placeholder (HU): `pl. piackutato, riport-keszito` (EN equiv: `e.g. market-research, report-builder`). This is the folder/identifier name.
- **Textarea "Írd le szabadon, mit csináljon ez a skill"** (EN: "Describe in your own words what this skill should do"), ~5 rows. Placeholder (HU): an example describing a market-research report skill, e.g. `pl. Piackutatási riportokat készít: versenytárs elemzés, piaci trendek, SWOT analízis. A riportot strukturáltan, táblázatokkal adja vissza magyarul.` (EN equiv: `e.g. Produces market-research reports: competitor analysis, market trends, SWOT. Returns structured output with tables, in Hungarian.`)
- **Primary button "Skill generálás"** (EN: "Generate skill"). Has a loading state that swaps the label for a spinner + **"Generálás…"** (EN: "Generating…") while the request runs; the button is disabled during the call.

**Import tab fields:**
- **Label "Skill fájl (.skill)"** (EN: "Skill file (.skill)").
- **File drop area** — a dashed upload zone with an upload-arrow icon and prompt text (HU) "Kattints vagy húzd ide a .skill fájlt" (EN: "Click or drag the .skill file here"). It accepts a hidden file input restricted to `.skill,.zip`. Clicking the zone opens the OS file picker; dragging a file over it highlights the border; dropping or selecting a file stages it and shows the chosen filename as a hint line beneath the prompt.
- **Primary button "Importálás"** (EN: "Import") with a loading state (spinner + "Importálás…" / "Importing…") and disabled-while-busy behavior.

Closing: the **×**, or clicking the dimmed backdrop, closes the modal. Closing the modal also **resets the scope flag** so a later per-agent open cannot accidentally inherit "global" scope.

### Skill detail modal
- Header title = the skill's display name; an **×** close. Backdrop click and × both close. No edit controls inside (read-only). See section 5.

### Per-agent Skills tab (in agent detail)
- A small section header **"Ügynök skilljei"** (EN: "Agent's skills") with a secondary, compact **"Új skill"** button (same modal, but per-agent scope). Below it a vertical list, and an empty-state line.

---

## 4) LISTS / CARDS / TABLES — exact fields & per-item actions

### Stats strip (global page) — small stat cards, each = a big value + a caption:
1. **Összes** (EN: "Total") — total number of skills found.
2. **User (saját)** (EN: "User (own)") — count of skills sourced from the user/home skills folder. Render its value in the "info" accent color.
3. **Plugin** — count of skills discovered inside the plugin cache. This card is **only shown if that count is > 0**. Render its value in the primary accent color.
4. **Dokumentált** (EN: "Documented") — count of skills that actually have a non-empty description parsed from their manifest. Render its value in the "success" color.

### Skill card (global grid) — each card shows:
- **Icon tile.** A category emoji/glyph chosen heuristically from the skill's name (e.g. a factory glyph if the name suggests "factory/creator," a writing glyph for "blog/post," a palette glyph for "image/thumbnail," a clapperboard for "video/youtube/seo," a document glyph for "doc," a puzzle-piece for generic "skill," a gear as the final fallback). You may design your own mapping; the point is a recognizable per-skill icon with a sensible default.
- **Name line:** the skill's display label (for a plugin skill this is a short `pluginId:skillName` form; for a user skill it is the folder name). Immediately after the name, a small **source badge** showing the origin: `user` or `plugin`.
- **Description line:** the parsed description, or the fallback **"Nincs leírás"** (EN: "No description") when none exists.
- **Per-item action:** clicking anywhere on the card **opens the Skill detail modal** for that skill (passing its identifier and display label). There is no per-card menu, delete, or assign button on the global grid — global skills are managed via detail/create/import flows.

Cards are sorted: user-source skills first, then plugin skills, each group alphabetical by display label.

### Per-agent skill list items — each row shows:
- **Name** (the skill folder name).
- A **"globális" badge** (EN: "global"), tooltip (HU) "Globális skill, minden agent örökli" (EN: "Global skill, inherited by every agent"), shown only on inherited global skills.
- **Description** line if present.
- **Per-item action:** a **trash/delete icon button** (tooltip "Törlés" / "Delete"), shown **only** for items the agent actually owns locally (deletable). Inherited global skills render **no delete button** — they are shared and cannot be removed from a single agent's view.

The agent detail panel also shows a **skill count badge** for the tab, set to the number of skills returned (local + inherited). On load error it shows `0` and reveals the empty state.

Per-agent empty state line: **"Nincsenek skillek hozzáadva"** (EN: "No skills added").

---

## 5) OPENED CARDS / MODALS / DETAIL PANES — full contents

### A) Skill detail modal (read-only)
Opened by clicking a global skill card. Contents top to bottom:
- **Title** = the skill's display name.
- **Description block** = the full parsed description, or **"Nincs leírás"** if empty. (On load error this area shows **"Hiba a betöltés során"** / "Error while loading".)
- **Meta block** (two lines):
  - **Source line** (HU) "Forrás: **<source>**" (EN: "Source: <source>"), where `<source>` is one of:
    - `user (saját fájl)` (EN: "user (own file)") for a user/home skill,
    - `plugin` — optionally suffixed with the plugin package path in parentheses — for a plugin skill,
    - `ismeretlen` (EN: "unknown") otherwise.
  - **Availability note** (HU) "Automatikusan elérhető minden sub-agent számára (közös HOME)." (EN: "Automatically available to every sub-agent (shared HOME)."). This note deliberately replaces any per-agent "copy to agent" UI — global skills need no assignment.
- **Manifest content section.** A small label **"SKILL.md tartalom"** (EN: "SKILL.md content") above a monospace, read-only rendering of the raw manifest text. If the manifest is missing, show the placeholder **"(SKILL.md nem található)"** (EN: "(SKILL.md not found)").
- Close via × or backdrop. No buttons to edit/delete/assign in this modal.

(The detail payload also carries the skill's resolved path and a list of files in the skill folder; the path is shown only conceptually via the source line — you may optionally surface a file list, but the reference shows source + note + manifest body as the primary content.)

### B) Create/Import modal — see section 3 for fields. Behavior in section 6.

---

## 6) FLOWS & BEHAVIOR — step by step, the API contract, and effects

> All endpoints below are concept-level contracts. Implement equivalent routes; do not copy any original route file. The dashboard is already behind a bearer token + network access gate (see section 8), so these routes assume an authenticated operator.

### F1 — Load the global skills list
- On navigating to the page: show a loading line in the grid (spinner + "Skillek betöltése…" / "Loading skills…"), clear the stats.
- **GET the skills list** (e.g. `GET /api/skills`). Server returns an array of skill entries. Each entry: identifier name, display label, parsed description, source (`user` | `plugin`), resolved path, and (for plugins) a package path. The server enumerates two locations:
  1. The **user/home skills folder** — each immediate sub-directory that contains a manifest becomes a `user` skill. Hidden dot-folders and a set of reserved/utility folder names (a nested `skills`, temp folders, and the per-scope index file `.skill-index.md`) are **skipped**.
  2. The **plugin cache tree** — walked to a bounded depth (~4 levels) looking for any `skills/` sub-folder; each manifest-bearing folder under it becomes a `plugin` skill. The plugin id and version are inferred from the path segments (a version-looking segment is treated as the version, the segment before it as the plugin id), producing a friendly `pluginId:skillName` label and a fully-qualified `packagePath:skillName` identifier.
- The server **sorts** user-first then plugin, alphabetical within group.
- Render stats + cards. If the array is empty, reveal the empty state. On fetch failure, replace the grid with an error line "Hiba a betöltés során" / "Error while loading."

### F2 — Open a skill's detail
- Clicking a card: set the modal title, then **GET the single skill** (e.g. `GET /api/skills/:name`, name URL-encoded). For a plugin skill the identifier contains a colon; the server splits on the **last** colon into a plugin path + skill basename and resolves under the plugin cache. For a user skill it resolves under the user skills folder.
- **Security in resolution:** the resolved skill directory must be confirmed to stay inside its expected base folder (a containment check); any path that escapes returns **404 "Skill not found"** rather than reading outside. Non-existent skills → 404.
- Server returns: name, description, raw manifest content, source, path, package (plugins), and a file list. Populate the detail modal (section 5). On any error, show the error text in the description area and clear the rest.

### F3 — Create (generate) a skill from a description
- In the Create tab, operator types a **name** and a free-form **description**, clicks "Skill generálás."
- Client validation: name must be non-empty (else focus the name field and stop).
- Branch on scope:
  - **Global scope:** `POST /api/skills` with `{ name, description }`.
  - **Per-agent scope:** `POST /api/agents/:agentId/skills` with `{ name, description }`.
- **Server behavior (both):**
  1. **Sanitize the name** into a safe slug (lowercase; Unicode-decompose then strip combining marks so accented Hungarian input degrades to ASCII rather than vanishing; keep only `[a-z0-9-]`; collapse and trim dashes; cap length ~50). Reject empty result → 400 "Skill name is required" (HU surfaced as a toast). Reject empty description → 400 "Skill description is required."
  2. Compute the destination folder under the correct scope root and **re-verify containment** (must stay inside the scope root) → 400 "Invalid skill name" on escape.
  3. If the folder already exists → 409 "Skill already exists."
  4. Create the folder, then **generate the manifest** by calling the model: a prompt instructs it to produce a well-structured manifest with YAML front-matter (name + a "pushy," trigger-rich description) and a body of fixed sections (Purpose / When to use / Instructions / Output format / Examples / Language rules / What to avoid), capped ~200 lines, owner referenced by the configured owner name or neutrally if none is set. Strip any stray code fences from the model output and write the manifest **atomically**.
  5. On generation failure, **roll back** (remove the just-created folder) and return 500 "Failed to generate skill."
  6. On success return `{ ok: true, name }`.
- **Client effect:** close the modal, show toast **"Skill hozzáadva"** (EN: "Skill added"), and reload the relevant list (global list or the agent's list). On any non-OK response, show a toast with the server error message.

### F4 — Import a packaged skill archive
- In the Import tab, operator stages a `.skill`/`.zip` file and clicks "Importálás."
- Client validation: a file must be staged (else toast "Válassz egy .skill fájlt" / "Choose a .skill file"); for per-agent scope an agent must be selected.
- Branch on scope:
  - **Global:** `POST /api/skills/import` (multipart, the archive as `file`).
  - **Per-agent:** `POST /api/agents/:agentId/skills/import` (multipart).
- **Server behavior (security-critical — reproduce all of these checks):**
  1. Require a file; else 400 "No file uploaded."
  2. Write the upload to a temp file in the target skills folder; snapshot the set of pre-existing entries.
  3. **List the archive entries without extracting** and scan each path. **Reject path traversal:** any entry containing `..`, starting with `/`, or matching a Windows drive prefix (e.g. `C:\`) → delete temp, 400 **"Invalid skill file: path traversal detected."**
  4. (Global import additionally) compute the archive's top-level folder names; if any **collides with an existing skill**, refuse → 409 with a message like "Skill already exists: <name>. Delete it first if you want to overwrite." (Per-agent import overwrites in place rather than refusing — implement per your scope policy; the safer default is to refuse on collision.)
  5. Extract into the skills folder, then delete the temp archive.
  6. **Reject symlinks:** recursively inspect every newly-extracted entry; if any extracted file or any file within an extracted directory is a **symbolic link**, **delete all newly-extracted entries** and return 400 **"Invalid skill file: symlink entries rejected."** (This blocks symlink-escape attacks.)
  7. **Validate skill shape:** among the newly-extracted top-level directories, keep only those that contain a manifest. If none qualifies, **remove all newly-extracted entries** and return 400 "No valid skill (SKILL.md) found in archive."
  8. Log and return `{ ok: true, imported: [<folder names>] }`.
  9. On any thrown error mid-flow, best-effort clean up the temp file and any leftover newly-extracted entries, then 500 "Failed to extract .skill file."
- **Client effect:** close modal, toast **"Skill importálva: <names>"** (EN: "Skill imported: <names>"), clear the staged file, reload the list. On error, toast the server message.

### F5 — Assign / detach a global skill to specific agents (concept-level; reproduce as a contract)
- Endpoint concept: `POST /api/skills/:name/assign` with `{ agents: [<agentId>…] }`. (In the current reference UI this is largely superseded by the shared-HOME inheritance model — the detail modal explicitly tells the operator a global skill is already available to all agents — but the contract exists and you should implement it for explicit per-agent materialization.)
- **Server behavior:** verify the global skill exists and resolves inside the global root (else 404). For each named, *known* agent, copy the skill folder into that agent's private skills location (replacing any same-named local copy first). For every known agent **not** in the target list, **remove** that skill from its private location. Net effect: the agent's local materialized copy set is reconciled to exactly the target list. Return `{ ok: true }`.
- **Confirmation:** none required for assign (additive/reconciling), but the UI should make clear which agents are being toggled.

### F6 — Delete a skill
- **Per-agent delete:** the trash button on a per-agent skill row. **Confirm first** (HU) "Skill törlése: <name>?" (EN: "Delete skill: <name>?"). On confirm `DELETE /api/agents/:agentId/skills/:skillName`.
  - **Server:** sanitize both names; verify the agent exists; resolve the skill path via a containment-checked join (escape → 400 "Invalid skill path"); 404 if missing; otherwise recursively remove the folder; `{ ok: true }`.
  - **Client effect:** toast **"Skill törölve"** (EN: "Skill deleted") and reload the agent's list; on failure toast "Hiba a törlés során" / "Error while deleting."
- **Inherited global skills are NOT deletable from a single agent's view** — no delete button is rendered for them. Global skills are deleted/managed only at the global scope (e.g. via the assign-reconcile flow or out-of-band).

### Live-update / polling
- Lists are loaded on demand (page open / after a mutating action). There is no continuous polling for the skills grid; refresh happens after create/import/delete/assign. Implement explicit reloads after each mutation as described above.

---

## 7) STATES — empty / loading / error / permission

- **Loading (global grid):** grid replaced by a centered spinner + "Skillek betöltése…" / "Loading skills…"; stats cleared.
- **Empty (global):** the empty-state block (key/skill glyph + "Nincsenek skillek" / "No skills") is revealed; stats still render (all zeros).
- **Empty (per-agent):** "Nincsenek skillek hozzáadva" / "No skills added" line; count badge shows `0`.
- **Error (list load):** grid shows "Hiba a betöltés során" / "Error while loading."
- **Error (detail load):** description area shows "Hiba a betöltés során"; content cleared; meta cleared.
- **Busy (create/import):** the action button is disabled and shows its spinner+label until the request resolves.
- **Server validation/conflict errors** are surfaced as toasts carrying the server's message (e.g. name required, already exists, path traversal detected, symlink rejected, no valid skill found).
- **Info box (always shown on the global page).** Soft callout, HU text conveying: every skill listed here is automatically available to every sub-agent because they share the same HOME as the main session; the runtime's built-in slash-commands (init, review, security-review, loop, schedule, etc.) are always available but are **not** listed here because they live inside the CLI binary, not as filesystem sources; create or import a new skill via the top-right "Új skill" button. EN equivalent should preserve all three points.

---

## 8) PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- This is an **operator-only control surface.** The entire dashboard sits behind a bearer token plus a network access gate; there is no in-page role switch between "operator" and "agent." Agents do not browse this UI — they *consume* skills at runtime.
- Because all global skills are shared via the common HOME, there is **no autonomy-level gate on visibility** of skills themselves — the gating is on *who can reach the dashboard*, not on which skills render.
- Destructive/privileged effects (delete, import-that-writes-to-disk, assign-that-copies-into-agent-dirs) are operator actions performed through the authenticated dashboard. Keep the destructive delete behind the confirm dialog (F6).
- An imported or generated skill becomes immediately available to the whole fleet — treat import/generate as a trusted-operator action and never expose these write endpoints to an untrusted/agent-facing surface.

---

## 9) DATA CONCEPTS read / written (concept-level — design your own storage)

- **Skill (folder bundle):** identity = sanitized slug name; carries a **manifest** (markdown with YAML front-matter) and optional sibling asset files. Front-matter fields read by the UI: `name` and `description` (single-line, quotes trimmed, length-capped when parsed for display).
- **Source classification:** `user` (lives in the shared/home skills folder) vs `plugin` (discovered in the plugin cache; carries a derived plugin id + version + package path).
- **Per-scope index (concept).** Each skills scope may contain a reserved index file (conventionally `.skill-index.md`) that is treated as **metadata, not a skill** — the enumerator explicitly skips it (alongside hidden dot-entries and reserved nested folders like a literal `skills` sub-folder and temp folders). Implement skills discovery so that this index file and reserved names never appear as skill cards. (You may use such an index to accelerate listing or to store ordering/labels, but enumeration must remain correct if it is absent.)
- **Scope roots (two):** a global/home skills root, and per-agent private skills roots (under each agent's own config area). The main/orchestrator agent's "private" root IS the global root (its skills physically live in the shared location and are deletable from its own view).
- **Inheritance/shadowing rule:** an agent's effective skill set = its local skills + all global skills not shadowed by a same-named local skill; inherited global entries are flagged non-deletable in the per-agent view.
- **Written on mutations:** create → new folder + generated manifest (atomic write); import → extracted folder(s) after security validation; assign → copied/removed folders across agent roots; delete → folder removal. Every path operation must pass a containment check against its scope root.

---

## 10) i18n — all strings ship HU (default) + EN

Provide both; HU is the shipped default. Minimum string set:

| Key (concept) | HU | EN |
|---|---|---|
| Nav item | Skillek | Skills |
| Page title | Skillek | Skills |
| Subtitle | A Claude Code által látott skillek (user mappa + plugin cache) | The skills visible to the runtime (user folder + plugin cache) |
| New-skill button | Új skill | New skill |
| Stat: total | Összes | Total |
| Stat: user | User (saját) | User (own) |
| Stat: plugin | Plugin | Plugin |
| Stat: documented | Dokumentált | Documented |
| Card no-description | Nincs leírás | No description |
| Empty (global) | Nincsenek skillek | No skills |
| Loading list | Skillek betöltése… | Loading skills… |
| List load error | Hiba a betöltés során | Error while loading |
| Modal title | Új skill | New skill |
| Tab: create | Létrehozás | Create |
| Tab: import | Importálás | Import |
| Field: name | Skill neve | Skill name |
| Name placeholder | pl. piackutato, riport-keszito | e.g. market-research, report-builder |
| Field: description | Írd le szabadon, mit csináljon ez a skill | Describe in your own words what this skill should do |
| Generate button | Skill generálás | Generate skill |
| Generating state | Generálás… | Generating… |
| File label | Skill fájl (.skill) | Skill file (.skill) |
| Upload prompt | Kattints vagy húzd ide a .skill fájlt | Click or drag the .skill file here |
| Import button | Importálás | Import |
| Importing state | Importálás… | Importing… |
| Choose-file warning | Válassz egy .skill fájlt | Choose a .skill file |
| Toast: created | Skill hozzáadva | Skill added |
| Toast: imported | Skill importálva: {names} | Skill imported: {names} |
| Detail: SKILL.md label | SKILL.md tartalom | SKILL.md content |
| Detail: missing manifest | (SKILL.md nem található) | (SKILL.md not found) |
| Detail: source prefix | Forrás: | Source: |
| Detail: source user | user (saját fájl) | user (own file) |
| Detail: source unknown | ismeretlen | unknown |
| Detail: availability note | Automatikusan elérhető minden sub-agent számára (közös HOME). | Automatically available to every sub-agent (shared HOME). |
| Detail title fallback | Skill részletek | Skill details |
| Per-agent header | Ügynök skilljei | Agent's skills |
| Per-agent empty | Nincsenek skillek hozzáadva | No skills added |
| Per-agent global badge | globális | global |
| Per-agent global badge tooltip | Globális skill, minden agent örökli | Global skill, inherited by every agent |
| Delete tooltip | Törlés | Delete |
| Delete confirm | Skill törlése: {name}? | Delete skill: {name}? |
| Toast: deleted | Skill törölve | Skill deleted |
| Toast: delete error | Hiba a törlés során | Error while deleting |
| Error: traversal | Érvénytelen skill fájl: path traversal észlelve | Invalid skill file: path traversal detected |
| Error: symlink | Érvénytelen skill fájl: symlink bejegyzések elutasítva | Invalid skill file: symlink entries rejected |
| Error: no valid skill | Nincs érvényes skill (SKILL.md) az archívumban | No valid skill (SKILL.md) found in archive |
| Error: already exists | A skill már létezik | Skill already exists |
| Info box | (lásd a 7. szakasz info-box leírását — három pont) | (see section 7 info-box — three points) |

Implementable from scratch. For all visual treatment (card grid, badges, stat cards, drop-zone styling, modal chrome, spinner), follow `01-design.md`.
