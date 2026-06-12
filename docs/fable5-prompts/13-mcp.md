# Fable 5 Build Prompt — MCP / Connectors View

> **CLEAN-ROOM NOTICE.** You have never seen the reference product. This document is a *behavioral and visual specification* written from observed behavior. Implement it originally, in your own architecture, naming, and code. Do not ask for or reproduce any original source code, identifiers, file names, route strings, or database schema. Where this spec names a concrete API path or field, treat it as a *contract you may design freshly* (the wire shape is up to you) unless a section explicitly says "the existing backend expects X." Look-and-feel (colors, spacing, typography, component primitives) is defined centrally in **01-design.md** — reference it; do not invent a parallel design language here.

---

## 1) PURPOSE & WHERE IT LIVES

**What this view is for.** This is the single place an operator manages **MCP connectors** — the external tools, data sources, and capabilities that the AI agents can call. It does two jobs at once:

1. **Discover & install** new connectors from a curated, browseable **gallery/catalog** (a shipped list of well-known MCP servers, each one-click-installable).
2. **Manage what is already configured** — see every connector the agent fleet can currently see, grouped by where it applies, inspect each one, decide which agents may use it, and remove it.

It also hosts a few adjacent "plumbing" tools that connectors depend on: a small **secrets vault** (API keys), **GitHub repo-based MCP installs**, and **extra project paths** to scan for connector configs.

**Nav placement.** A left-sidebar nav item. Label: **HU "MCP" / EN "MCP"** (keep the acronym in both languages — it is the recognized term). Icon idea: two interlocking chain/plug links (suggesting "connector"), single-stroke line style consistent with the other sidebar icons in 01-design.md. Clicking it routes to the MCP page and triggers an initial data load.

**Subtitle under the page title.**
- Page title: **HU "Connectorok" / EN "Connectors"**
- Subtitle: **HU "MCP szerverek kezelése" / EN "Manage MCP servers"**

**Relationship to agents (the mental model the page must convey).** The main orchestrator agent runs in the same home environment as the dashboard, so **every globally-installed connector is automatically available to the main agent** — nothing to assign. Sub-agents do *not* automatically inherit a connector; a connector becomes visible to a sub-agent only when it is explicitly assigned to that agent (or declared in that agent's own config). This page is where that assignment happens. The page must make this asymmetry obvious (main agent = automatic; sub-agents = opt-in).

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — defer all styling to 01-design.md)

Top to bottom:

1. **Page header row.** Left: title + subtitle (above). Right: two buttons side by side — a secondary **Refresh** button and a primary **New connector** button (see Controls).

2. **Info banner (informational, dismissable-by-design-or-persistent).** A muted info box explaining: the listed MCP servers are the ones enabled in the operator's Claude subscription (OAuth connectors, marketplace plugins, local config); every sub-agent sees the global ones automatically because they share the same home; do **not** re-add locally something already enabled upstream (it duplicates and the CLI warns "local wins"); and that the list loads at dashboard start and refreshes only on demand via the Refresh button. This is guidance text, always rendered HTML-escaped.

3. **Cross-promo banner (optional, third-party).** A distinct, brand-colored strip promoting an external aggregator service ("one MCP over all"). It contains an inline **install/configure state machine** (loading → install → token entry → configuring → done/error) and a close button that permanently dismisses it (remembered in local storage). This is a self-contained widget — see §5 (cross-promo banner flow). It is *not* a core connector; it is a guided installer for one specific external CLI + token.

4. **Two top-level tabs:** **Installed** and **Gallery**.
   - **HU "Telepített" / EN "Installed"** — the configured-connectors management surface (default active tab).
   - **HU "Galéria" / EN "Gallery"** — the browseable catalog.

5. **Installed tab content:**
   - A **stats strip** (count cards) summarizing the configured connectors by status.
   - A **connector grid** that is internally *grouped and headed* by scope: a "Claude global" group (including built-in capabilities + global connectors), an "Agents" group (collapsible per-agent sub-lists), a "Projects (internal)" group, and an "External projects" group.
   - A **"Tools" sub-section** (HU "Eszközök") below the connector grid containing three collapsible panels: **GitHub repos**, **Vault (encrypted keys)**, and **Paths**.

6. **Gallery tab content:**
   - A horizontal **category filter bar** (pill buttons).
   - A **catalog card grid**.

7. **Modals (overlays), all centered, dismiss on backdrop click or close button:** Add Connector, Connector Detail, Catalog Install, Built-in Capability Detail, and an Env-var prompt modal (used by the GitHub-repo installer).

Layout density and card styling follow 01-design.md. The grid is responsive card layout; collapsible groups use a disclosure triangle that flips ▶/▼.

---

## 3) CONTROLS (every interactive element, HU + EN)

### Page header
- **Refresh button** (secondary, compact, with a circular-arrow icon). Label **HU "Frissítés" / EN "Refresh"**, tooltip **HU "Claude MCP lista frissítése" / EN "Refresh Claude MCP list"**. Action: triggers a server-side re-scan of the live MCP list (a relatively expensive operation that spawns connectors for a health check), then reloads the configured list; if the Gallery tab is currently visible, it also reloads the catalog. Shows a toast with the resulting global-connector count, or an error toast. Disabled while in flight.
- **New connector button** (primary, compact, "+" icon). Label **HU "Új connector" / EN "New connector"**. Action: opens the Add Connector modal with a blank form.

### Tabs
- **Installed tab** — **HU "Telepített" / EN "Installed"**.
- **Gallery tab** — **HU "Galéria" / EN "Gallery"**.
  Switching to Gallery lazily loads the catalog. Only one tab's content is visible at a time; active tab is visually marked.

### Gallery category filter bar (pill buttons; exactly one active at a time)
Each filters the catalog grid to that category client-side. Buttons (value → HU label → EN label):
- `all` → **"Összes"** / **"All"** (default active)
- `productivity` → **"Produktivitás"** / **"Productivity"**
- `communication` → **"Kommunikáció"** / **"Communication"**
- `search` → **"Keresés"** / **"Search"**
- `development` → **"Fejlesztés"** / **"Development"**
- `ai` → **"AI"** / **"AI"**
- `finance` → **"Pénzügy"** / **"Finance"**
- `system` → **"Rendszer"** / **"System"**

> Note: the catalog may contain additional categories (e.g. automation, custom) that have no dedicated pill; those entries appear only under "All". Build the filter so an unknown category still shows under All.

### Add Connector modal fields/controls (see §5 for full layout)
- **Name** input — label **HU "Név" / EN "Name"** with helper text **HU "(betűk, számok, kötőjel, aláhúzás — szóköz nem!)" / EN "(letters, numbers, hyphen, underscore — no spaces!)"**, placeholder **HU "pl. google-drive" / EN "e.g. google-drive"**.
- **Type** dropdown — label **HU "Típus" / EN "Type"**, options:
  - `stdio` → **HU "stdio (parancs)" / EN "stdio (command)"**
  - `http` → **HU "HTTP (streamable)" / EN "HTTP (streamable)"**
  - `sse` → **HU "SSE (legacy HTTP)" / EN "SSE (legacy HTTP)"**
- **Scope** dropdown — label **HU "Hatókör" / EN "Scope"**, options:
  - `user` → **HU "Globális (minden projekt)" / EN "Global (all projects)"**
  - `project` → **HU "Projekt szintű" / EN "Project-level"**
- **URL** input (shown only for http/sse) — label **HU "URL" / EN "URL"**, placeholder `https://mcp.example.com/mcp`.
- **Command** input (shown only for stdio) — label **HU "Parancs" / EN "Command"**, placeholder **HU "npx -y @my/mcp-server" / EN "npx -y @my/mcp-server"**.
- **Arguments** input (stdio only) — label **HU "Argumentumok (opcionális)" / EN "Arguments (optional)"**, placeholder `--port 3000`.
- **Environment variables** (stdio only) — label **HU "Környezeti változók (opcionális)" / EN "Environment variables (optional)"**, with a dynamic key/value row list and a **"+ Változó hozzáadása" / "+ Add variable"** link button. Each row: a KEY text input (placeholder **HU "KULCS" / EN "KEY"**), an `=` separator, a value text input (placeholder **HU "érték" / EN "value"**), and a row-remove "×" button.
- **Assign to agents** (shown only when scope = project) — label **HU "Hozzárendelés ügynökökhöz (opcionális)" / EN "Assign to agents (optional)"**, a checkbox list of agents.
- **Submit button** (primary) — label **HU "Hozzáadás" / EN "Add"**, with loading state **HU "Hozzáadás..." / EN "Adding..."**.

### Connector Detail modal controls (see §5)
- **Assign-to-agents** checkbox list + a **Save** button (**HU "Mentés" / EN "Save"**).
- **Delete** button (danger) — **HU "Törlés" / EN "Delete"**.

### Catalog Install modal controls (see §5)
- Zero-or-more **env key inputs** (only when auth = apikey), each labeled with the env var name, placeholder **HU "Illeszd be a {KEY} értéket" / EN "Paste the {KEY} value"**.
- **Install button** (primary, full width) — **HU "Telepítés" / EN "Install"**, loading **HU "Telepítés..." / EN "Installing..."**.

### Tools sub-section (under the connector grid) — three collapsible panels
Section heading: **HU "Eszközök" / EN "Tools"**.

1. **GitHub repos panel.** Header (clickable disclosure) **HU "GitHub repok" / EN "GitHub repos"** with a count badge. Body: a list of installed repos + an add row: a URL input (placeholder `https://github.com/user/repo`) and an **Install** button (**HU "Telepítés" / EN "Install"**). Status line below shows progress/errors.
2. **Vault panel.** Header **HU "Vault (titkosított kulcsok)" / EN "Vault (encrypted keys)"** with a count badge. Body: a list of stored secrets + an add row: a key-name input (placeholder **HU "Kulcs név (pl. OPENAI_API_KEY)" / EN "Key name (e.g. OPENAI_API_KEY)"**), a masked value input (placeholder **HU "Érték" / EN "Value"**), and a **Save** button (**HU "Mentés" / EN "Save"**).
3. **Paths panel.** Header **HU "Útvonalak" / EN "Paths"** with a count badge. Body: a list of registered external project paths + an add row: a path input (placeholder `/Users/...` or `/home/...`) and an **Add** button (**HU "Hozzáad" / EN "Add"**).

Each disclosure header toggles its body open/closed and flips the ▶/▼ triangle.

---

## 4) LISTS / CARDS / TABLES

### A) Catalog (Gallery) cards
One card per catalog entry, filtered by the active category pill. Each card shows:
- **Icon** (an emoji or glyph chip).
- **Name** (the connector's display name).
- **Type badge** — `local` or `remote`, styled distinctly. (`local` = runs as a spawned process/command; `remote` = a hosted URL endpoint.)
- **Documentation link** — a small up-right-arrow link (opens the entry's info URL in a new tab) shown only if the entry has a doc URL. Clicking it must not trigger the card's other actions.
- **Description** — one or two lines of plain text.
- **Footer state**, one of:
  - **Not installed:** a primary **Install** button (**HU "Telepítés" / EN "Install"**). If the entry uses OAuth and carries an auth note, a small italic auth hint is shown next to the button.
  - **Installed:** a non-interactive **"Telepítve ✓" / "Installed ✓"** chip. The chip may carry a source suffix in parentheses indicating *how* it was detected — e.g. "(.mcp.json)", "(claude.ai)", or "(plugin)". When the entry was installed under a custom server name (detected via a config file) **or** comes from the upstream account (claude.ai), **no uninstall link is shown** — instead the chip tooltip directs the operator to manage it on the Installed tab (or upstream). Otherwise (a clean catalog-id install), an **"Eltávolítás" / "Remove"** link is shown.

Empty state for the grid: when a category has no matches, show **HU "Nincs találat ebben a kategóriában" / EN "No results in this category"**.

### B) Stats strip (Installed tab)
A row of small count cards, each a big number + a label. Cards shown (only render the conditional ones when count > 0):
- **Total** — **HU "Összes" / EN "Total"** (the full count).
- **Active/Connected** — **HU "Aktív" / EN "Active"** (green) — connectors with a healthy live status.
- **Configured** — **HU "Konfigurálva" / EN "Configured"** (info color) — declared in a config file but not health-checked (treated as known-good, not broken).
- **Needs auth** — **HU "Auth szükséges" / EN "Auth required"** (accent color) — connectors awaiting an auth/login step.
- **Failed** — **HU "Hibás" / EN "Failed"** (danger color).

When the list is empty *and* the cache is still warming, render no stats (avoid a misleading all-zero strip).

### C) Connector grid (Installed tab) — grouped by scope
The grid is split into labeled groups, each with a group heading:

**Group: "Claude global" (HU "Claude globális" / EN "Claude global")** — contains:
- A **built-in capabilities** row (cards rendered from a small fixed list — see §5 Built-in detail). Each built-in card shows: a status dot styled "unknown" (the dashboard cannot auto-detect these), the capability's label + a small description line, and a **"Részletek" / "Details"** link-button that opens the Built-in Capability Detail modal. The two built-ins are conceptually "screen/computer control" and "browser control" — capabilities that live inside the agent runtime rather than as registered MCP servers.
- The **global connector cards** (scope = global or plugin).

**Group: "Agents" (HU "Ügynökök" / EN "Agents")** — one **collapsible sub-section per agent** that has agent-scoped connectors. Each sub-section header shows a robot glyph, the agent name, and a count badge; expanding it reveals that agent's connector cards.

**Group: "Projects" (HU "Projektek" / EN "Projects")** — one collapsible sub-section per internal project scope (folder glyph), each labeled by the project's leaf name, with count.

**Group: "External projects" (HU "Külső projektek" / EN "External projects")** — the **Paths panel is hosted inside this group's header area**, followed by one collapsible sub-section per external project scope (open-folder glyph).

**Each connector card shows:**
- A **status dot** colored by status (connected/configured/needs_auth/failed/unknown).
- **Name** of the connector.
- A small **source badge** indicating origin, mapped to a friendly label: plugin → "plugin", local-user → "local (user)", local-project → "local (project)", local → "local", agent → "agent", agent-project → "project", external-project → "external", upstream account → "claude.ai".
- **Endpoint line** — the URL (remote) or command (local), monospace, truncated.
- A **type badge** — `local` or `remote`/`plugin`.
- **Read-only marker:** connectors sourced from the upstream account are non-clickable and carry a hint **HU "Kezelhető: claude.ai" / EN "Manage at: claude.ai"**. They have no detail modal.

**Per-card action:** clicking a non-read-only card opens the **Connector Detail modal**. Read-only cards do nothing on click.

**Stale-data banner:** if the live cache failed to refresh *and* there are upstream-account entries present, show a warning strip above the grid: **HU "Frissítés sikertelen: {error} -- a claude.ai connectorok elavultak lehetnek." / EN "Refresh failed: {error} -- the claude.ai connectors may be stale."**

### D) GitHub repos list (Tools panel)
Each row: repo name (rendered as `owner/repo`), install date, and two icon buttons:
- **Update** (circular-arrow icon, tooltip **HU "Frissítés" / EN "Update"**) — pulls the latest and re-installs.
- **Delete** (× icon, tooltip **HU "Törlés" / EN "Delete"**) — removes after confirm.

### E) Vault list (Tools panel — inline mini-list)
Each row: the secret's label, a sub-line showing the secret id · last-updated date, and a delete "×" button (danger). (A richer, full-page Vault surface exists elsewhere; here it is a compact inline manager.)

### F) Paths list (Tools panel)
Each row: the path string + a delete "×" button.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

### Modal 1 — Add Connector
Title **HU "Új connector" / EN "New connector"**; close "×". Wide modal. Contents (all fields from §3 Add Connector):
- Name (always visible).
- A two-column row: Type dropdown | Scope dropdown.
- **Conditional fields driven by Type:**
  - Type = http or sse → show **URL** group; hide Command/Args/Env.
  - Type = stdio → show **Command**, **Arguments**, **Env vars** groups; hide URL.
- **Conditional field driven by Scope:**
  - Scope = project → show **Assign to agents** checkbox list (loaded fresh when the modal opens).
  - Scope = user/global → hide it.
- Submit button (primary) with text + loading sub-states.

Opening the modal resets all fields to defaults (Type=stdio, Scope=user, empty name/url/cmd/args, empty env list, assign list hidden) and loads the agent list for the (hidden until needed) assign control.

### Modal 2 — Connector Detail
Title = the connector's name; close "×". Wide modal. On open it fetches per-connector detail and renders:
- **Info block** — a stack of label/value rows:
  - **Status** (**HU "Státusz" / EN "Status"**) — localized: connected → **HU "Csatlakozva" / EN "Connected"**; needs_auth → **HU "Auth szükséges" / EN "Auth required"**; failed → **HU "Hiba" / EN "Error"**; unknown → **HU "Ismeretlen" / EN "Unknown"**; configured → **HU "Konfigurálva" / EN "Configured"**. Value colored by status.
  - **Scope** (**HU "Hatókör" / EN "Scope"**).
  - **Type** (**HU "Típus" / EN "Type"**) — local/remote/plugin.
  - **Command** (**HU "Parancs" / EN "Command"**) — command + args, monospace (shown when present).
  - **Env** (**HU "Env" / EN "Env"**) — env var **names with masked values** (e.g. `KEY=***`), monospace (shown when present). Never reveal secret values here.
  - On fetch failure: **HU "Részletek betöltése sikertelen" / EN "Failed to load details"**.
- **Assign-to-agents section** — label **HU "Hozzárendelés ügynökökhöz" / EN "Assign to agents"**, then a checkbox list:
  - The **main agent** appears as a checked, **disabled** checkbox tagged **HU "automatikus" / EN "automatic"**, with tooltip **HU "Globálisan elérhető a fő agentnek -- nem kell külön hozzárendelni" / EN "Globally available to the main agent -- no separate assignment needed"**.
  - Each **sub-agent** appears as a toggleable checkbox, pre-checked if the connector is already assigned to that agent.
  - If there are no assignable agents: **HU "Nincsenek hozzárendelhető ügynökök" / EN "No assignable agents"**.
  - A **Save** button under the list (**HU "Mentés" / EN "Save"**).
- **Delete** button (danger) at the bottom (**HU "Törlés" / EN "Delete"**).

### Modal 3 — Catalog Install
Title **HU "{icon} {name} telepítése" / EN "Install {icon} {name}"**; close "×". Contents:
- The connector **description** paragraph.
- **Env field block** — populated only when the entry's auth type is **apikey**: one input per required env var, each labeled by the var name, with placeholder **HU "Illeszd be a {KEY} értéket" / EN "Paste the {KEY} value"**. (For auth = oauth or none, no inputs.)
- **Auth note** — shown (when present) for both apikey and oauth entries: a muted line carrying instructions like where to get the API key, or that browser/OAuth login is required on first use.
- **Install button** (full width, primary) with text + loading states.

On submit, every shown env input is **required** — a blank one focuses itself and shows a toast **HU "{KEY} megadása kötelező" / EN "{KEY} is required"**.

### Modal 4 — Built-in Capability Detail
Title = capability label; close "×". Contents: a short muted description line + a rich HTML body explaining that the capability is a native runtime feature (not a manageable MCP server), why the dashboard cannot auto-detect it, and how to enable it (e.g. a launch flag, or following upstream docs), with a safety caveat for screen-control. Static, trusted content only. On open, focus moves to the close button (accessibility).

### Modal 5 — Env-var prompt (used by GitHub-repo installer)
Title **HU "API kulcsok megadása" / EN "Enter API keys"**; close "×". Body: a note **HU "Ez az MCP szerver az alábbi env változókat igényli. Az értékek titkosítva a Vault-ba kerülnek." / EN "This MCP server requires the env vars below. The values are stored encrypted in the Vault."**, then one masked input per required var (placeholder **HU "Érték..." / EN "Value..."**). Footer: a **Skip** button (**HU "Kihagyás" / EN "Skip"**) and a **Save & install** button (**HU "Mentés és telepítés" / EN "Save & install"**). Resolves a promise the install flow awaits: Skip/close → no values; Save → the entered key/value map.

### Widget — Cross-promo banner (inline state machine)
A self-contained installer for one specific external aggregator CLI + token. States, swapped in place:
- **Loading** — spinner while status is fetched.
- **Install** — a **"Telepítés" / "Install"** CTA + a "Mi ez? / What is this?" external link.
- **Installing** — spinner + **HU "Telepítés folyamatban..." / EN "Installing..."**.
- **Token** — a "CLI installed" badge + a masked token input (placeholder **HU "connectors.hu token (dashboardról)" / EN "connectors.hu token (from the dashboard)"**) + a **"Mentés és szinkron" / "Save & sync"** CTA.
- **Configuring** — spinner + **HU "Szinkronizálás..." / EN "Syncing..."**.
- **Done** — a **"connectors.hu CLI telepítve" / "connectors.hu CLI installed"** success badge.
- **Error** — an error message + a **"Újra" / "Retry"** button that re-runs the last step.
- A **close** button permanently dismisses the banner (persisted in local storage).

---

## 6) FLOWS & BEHAVIOR (step-by-step + the API contract + the effect)

> The wire format is yours to design. Contracts below describe *what must happen*. Where it says "the existing backend expects," preserve that shape so the same server can drive your UI.

### Initial page load
1. On nav to MCP, load the configured connector list **and** a lightweight status readout **in parallel**.
2. The status readout tells the UI whether the server-side live cache has *ever* refreshed (a "last refreshed" timestamp) and whether there is a cache error. **Default assumption is "cache warming" until proven otherwise** — only a positive timestamp flips it off. This prevents a cold start from rendering "no connectors" when the truth is "not loaded yet."
3. Render the grouped grid + stats. Also load the three Tools panels (GitHub repos, Vault, Paths) and the cross-promo banner status.
- Contract: `GET /api/connectors` returns the full list of configured connectors with `{name, status, endpoint, type, source, scope}`. `GET /api/connectors/status` returns `{cacheLastRefreshed, cacheError, refreshing}`.

### Refresh (header button)
1. POST a refresh; the server re-runs the live MCP list (spawning connectors for health checks — deliberately manual/expensive).
2. On success show a toast with the count; on failure a toast with the error. Then reload the configured list (and the catalog if Gallery is open).
- Contract: `POST /api/connectors/refresh` → `{ok, count, lastRefreshed, error}`; non-OK returns an error status. (No confirmation needed — it is non-destructive.)

### Browse catalog
1. Switching to Gallery loads the catalog once.
2. The catalog merges a shipped (committed) list with an optional user-local list; user-local entries override shipped ones by id.
3. Each entry is marked **installed** if its id (or name slug, or an `<id>-<variant>` naming convention) matches something the live cache reports **or** something declared in any visible config file. The match also records the source (live cache source, or config-file match).
- Contract: `GET /api/mcp-catalog` → array of catalog items, each annotated with `{installed, installedSource, configMatch}` plus its static fields (`id, name, description, type, category, icon, command/args/url, env, authType, authNote, infoUrl`).
- Category filtering is **client-side** on the already-loaded list.

### Install from catalog
1. Click **Install** on a not-installed card → opens Catalog Install modal pre-filled with description, conditional env inputs (apikey only), and auth note.
2. On confirm: validate that all shown env inputs are filled (else focus + toast). Submit the entered env values.
3. Server installs the MCP under the catalog id (local → registers a command with env flags; remote → registers a hosted URL/transport), scoped globally (user scope). For OAuth entries, the success message appends the auth note (e.g. "log in in the browser on first use").
4. On success: close modal, show success toast, reload **both** the catalog and the configured list (so the card flips to "Installed" and the connector appears on the Installed tab).
- Contract: `POST /api/mcp-catalog/{id}/install` with body `{env: {KEY: value, ...}}` → `{ok, message}`; non-OK → `{error}`. The backend never persists secret values into the local catalog file — only env *names*.

### Uninstall from catalog
1. Click **Remove** on an installed (clean-id) card → **confirm** dialog **HU "Biztosan eltávolítod: {name}?" / EN "Remove {name}?"**.
2. Server removes the MCP (tries user scope, then project scope).
3. On success: toast, reload catalog + configured list.
- Contract: `DELETE /api/mcp-catalog/{id}/uninstall` → `{ok, message}`.
- The Remove link is **hidden** for config-matched (custom-named) and upstream-account installs; the UI instead points the operator to the Installed tab / upstream.

### Add a custom connector
1. **New connector** → Add Connector modal.
2. Operator picks Type (stdio/http/sse) and Scope (user/project). The form reveals only the relevant fields.
3. Validation on submit: Name is required and is sanitized to letters/numbers/hyphen/underscore (a sanitized-name change is acceptable and may be surfaced); for http/sse a URL is required; for stdio a Command is required (Args + Env optional).
4. Server registers the connector at the chosen scope and persists a user-local catalog entry (env names only, blank values — never secrets).
5. On success: close modal, toast, reload configured list. If scope=project and agents were checked, the assignment is applied (see Assign flow).
- Contract: `POST /api/connectors` with `{name, type, url?|command?, args?, scope?, env?}` → `{ok, name, nameChanged}`; validation errors → `{error}` with 4xx.

### Open connector detail & assign to agents
1. Click a (non-read-only) card → Detail modal fetches per-connector detail (`GET /api/connectors/{name}`) and the agent roster + the full connector list (to compute current assignments).
2. The main agent is shown checked+disabled (automatic); sub-agents are toggleable and pre-checked where already assigned.
3. **Save (assign):** sends the set of checked agents *and* the full set of visible agents. The server copies the connector config into each checked sub-agent's config and **removes** it from any visible-but-unchecked sub-agent. Effect: a connector becomes/stops-being visible to each sub-agent accordingly. Plugin connectors are global to all agents — assignment is a no-op for them (server returns a note).
   - Contract: `POST /api/connectors/{name}/assign` with `{agents: [checked], allAgents: [visible]}` → `{ok}`.
   - On success: toast **HU "Ügynök-hozzárendelés frissítve" / EN "Agent assignment updated"**, close modal, reload list.
4. **Delete:** **confirm** **HU "Biztosan törlöd: {name}?" / EN "Delete {name}?"** → removes the connector from every config file it appears in and purges it from the live cache.
   - Contract: `DELETE /api/connectors/{name}` → `{ok, removed}` (or `{ok, purgedFromCache}`); not found → `{error}` 404.
   - On success: toast **HU "Connector törölve" / EN "Connector deleted"**, close modal, reload list.

### GitHub-repo MCP install (Tools panel)
1. Enter a repo URL, click **Install**. Status line shows "cloning & installing."
2. Server clones + installs; if the repo declares required env vars, it returns them. The UI then opens the **Env-var prompt modal**.
3. Operator fills values (or Skip). Filled values are saved into the **Vault** (one secret per var, auto-labeled), and a success status shows.
4. Reload repos list, paths, configured list, and Vault.
- Contract: `GET/POST /api/connectors/github-repos`, `PATCH /api/connectors/github-repos/{name}` (update), `DELETE .../{name}` (remove, with confirm **HU "Törlöd: {owner/repo}?" / EN "Delete {owner/repo}?"**).

### Vault (inline) add/delete
- Add: key-name + value → `POST /api/vault` (also auto-syncs any bindings). Delete: confirm **HU "Törlöd: {label}?" / EN "Delete {label}?"** → `DELETE /api/vault/{id}`.

### Paths add/delete
- Add a path → `POST /api/connectors/external-paths` (rejects bad paths with an alert). Delete → `DELETE` same route. Both reload paths + configured list (a new path can surface that project's connectors).

### Cross-promo banner flow
1. On load, `GET /api/connectors-hu/status` → `{installed, configured, version?}` selects the initial state (Done if both, Token if installed-only, Install otherwise; Error on failure).
2. **Install** → `POST /api/connectors-hu/install` (runs a vendor install script) → on success move to Token state.
3. **Save & sync** → requires a non-empty token → `POST /api/connectors-hu/configure` with `{token}` → saves the token to the Vault and runs a sync → Done; failure → Error with retry to the prior step.
4. Close → hide + remember dismissal.

### Confirmations summary (destructive actions all require explicit confirm)
- Catalog uninstall, connector delete, GitHub repo delete, Vault secret delete, path delete. Refresh, install, and assign do **not** confirm.

---

## 7) STATES (empty / loading / error / permission / live-update)

- **Loading (configured list):** grid shows a centered spinner + **HU "Connectorok betöltése..." / EN "Loading connectors..."**.
- **Loading (catalog):** grid shows spinner + **HU "Katalógus betöltése..." / EN "Loading catalog..."**.
- **Cache warming, list empty (no built-ins):** show **HU "MCP lista még nem töltődött be. Kattints a Frissítés gombra, vagy várj egy percet a dashboard indulása után." / EN "MCP list not loaded yet. Click Refresh, or wait a minute after dashboard startup."**. (In practice the built-in capabilities always render, so the page is never fully blank.)
- **Cache warming + cache error:** **HU "MCP lista nem tölthető be: {error}" / EN "Cannot load MCP list: {error}"**.
- **Truly empty (loaded, nothing configured):** **HU "Nincsenek MCP connectorok" / EN "No MCP connectors"**.
- **Stale upstream data:** the warning strip described in §4-C.
- **Catalog load error:** **HU "Hiba a katalógus betöltésekor" / EN "Error loading catalog"**.
- **Catalog category empty:** **HU "Nincs találat ebben a kategóriában" / EN "No results in this category"**.
- **Detail load error:** **HU "Részletek betöltése sikertelen" / EN "Failed to load details"**.
- **Generic action failures:** toast **HU "Hiba: {üzenet}" / EN "Error: {message}"**; specific install/assign/delete toasts as listed in §6.
- **Live update / polling:** the configured list does **not** auto-poll — refresh is explicit (because a refresh spawns connectors and can race the live messaging bot). Status is fetched alongside each manual load. (The cross-promo banner and, on a separate page, ComfyUI do poll; this MCP grid does not.) Read this as: no background polling on the connector grid; the operator drives refresh.
- **Permission-denied:** see §8.

---

## 8) PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- This is an **operator-only** management surface. The connectors page is part of the operator dashboard, behind the dashboard's auth (a bearer token). Agents do not browse or edit connectors through this UI.
- **Read-only entries:** connectors sourced from the upstream account are intentionally non-editable here (no detail, no delete) — the UI states they are managed upstream. Built-in runtime capabilities are non-detectable and non-toggleable — the UI only explains how to enable them; it never claims to control them.
- **Plugin connectors** are global to every agent; the assign control is a no-op for them and the server says so.
- **Agent-visibility is the core permission lever this page controls:** the main agent has every global connector automatically; each sub-agent gets a connector only via explicit assignment (or its own config). The Detail modal's assign list *is* the per-agent capability gate. Treat granting a connector to a sub-agent as expanding that agent's reach — appropriate for a cautious, autonomy-aware system, but the gating here is per-connector-per-agent, set by the operator. (No separate autonomy-level slider lives on this page; autonomy gating for agent actions lives elsewhere — this page just decides *which tools each agent can see*.)
- If a future build runs this UI for a non-operator, hide write controls (New connector, Install, Remove, Delete, assign Save, Tools add/delete) and render the lists read-only; show a permission-denied notice in place of action buttons.

---

## 9) DATA CONCEPTS (concept-level — design your own storage)

- **Connector (configured):** name, live status (connected / configured / needs_auth / failed / unknown), endpoint (URL or command string), transport type (local / remote / plugin), source/origin label, and scope (global, plugin, per-agent, internal-project, external-project). Connectors are *derived* by scanning multiple config files (a project-level config, a user-level config, each agent's config, each agent's per-project configs, and registered external project paths) plus a cached live-list readout. Your implementation may store them differently, but the *grouping by scope and the source labeling* are part of the UX contract.
- **Catalog entry:** id, display name, description, type (local/remote), category, icon, install recipe (command+args or URL+transport), required env var **names** (values never shipped), auth type (none / apikey / oauth), an optional auth note, an optional info/doc URL. Plus computed `installed/installedSource/configMatch` at read time. The catalog is a shipped list overlaid by an optional user-local list (user entries override by id; user-installed customs are appended with blank env values).
- **Built-in capability:** a small fixed list of name/label/description/enable-instructions — not stored, not health-checked.
- **Vault secret:** id, label, encrypted value, updated-at; optionally bound to env vars in connector configs (a "binding"). On this page the Vault is a compact list; values are write-and-reveal-on-demand, never shown by default, and masked in connector detail.
- **GitHub repo install:** repo name (owner/repo), install date; may carry env var requirements that flow into Vault secrets.
- **External project path:** a filesystem path scanned for connector configs.
- **Live-cache status:** a last-refreshed timestamp, an error string, and a refreshing flag — drives the warming/stale logic.
- **Assignment:** the act of copying a connector's config into (or removing it from) a sub-agent's config — the per-agent visibility record.

**Secrets discipline (must preserve):** secret values are never written into catalog files (only var names), never returned in connector detail (masked as `***`), and live only in the Vault.

---

## 10) i18n

Every user-facing string ships in **Hungarian (default)** and **English**, switchable via the central i18n mechanism in 01-design.md. The complete string set is enumerated inline in §§1–9 above (labels, placeholders, tooltips, empty/loading/error states, toasts, confirm dialogs, status enums, category names, source labels, group headings). Default locale is Hungarian; the acronym "MCP" stays identical in both. Confirm dialogs and toasts must also be localized (they are currently the most likely to be missed). Status enum localization (connected/configured/needs_auth/failed/unknown) and the source-label map are part of the i18n surface, not hard-coded English.

---

### Implementation note
Build this entirely from scratch in your own stack. Reference **01-design.md** for all visual primitives (cards, badges, dots, modals, disclosure groups, stat cards, buttons, inputs, spacing, color tokens for success/info/accent/danger/muted). Nothing in this document should be copied verbatim from any existing implementation — it describes behavior and appearance only.
