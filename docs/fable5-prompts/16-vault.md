# Fable 5 Build Prompt — Vault View

> CLEAN-ROOM NOTICE: This is an original behavioral and visual specification written for an engineer who has never seen any prior implementation. It describes WHAT the screen looks like and HOW it behaves — appearance, controls, fields, flows, states — as product requirements. It contains NO source code, file names, identifiers, or database schema from any existing product. Implement it from scratch in whatever stack you choose. For all visual/styling decisions (colors, spacing, typography, card chrome, modal chrome, dark theme) defer to `01-design.md`; this document defines structure and behavior only.

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** The Vault is the system's encrypted secret store and the control center for getting those secrets safely into the places that need them. It does three jobs:

1. **Store secrets** — API keys, tokens, passwords — encrypted at rest, never displayed in any list, never written to logs.
2. **Bind secrets to configuration** — map one stored secret to a named environment variable inside one or more tool/integration config files, so the real value is injected at runtime instead of being pasted in plaintext.
3. **Find and clean up leaks** — scan all known integration config files for plaintext sensitive values and offer to pull them into the vault (replacing the plaintext with an encrypted reference).

**Where it lives.** It is a top-level destination in the left sidebar navigation, sitting in the lower/admin group of nav items (near "Autonomy" and "Ideas"). 

- **Nav label:** `Vault` (same word in both languages — keep it as a proper noun).
- **Nav icon idea:** a closed padlock (a rounded rectangle body with an arched shackle on top, and a small dot/keyhole in the body). The same padlock motif is reused as the per-secret card icon and the empty-state icon, so the page reads as "the locked place" at a glance.

**Page title & subtitle (under the H1):**
- HU (default): title `Vault` · subtitle `Titkosított kulcsok és API tokenek`
- EN: title `Vault` · subtitle `Encrypted keys and API tokens`

**Top info banner** (a tinted callout directly under the header, always visible):
- HU: `**AES-256-GCM** titkosítás · A kulcsok kizárólag a helyi gépen tárolódnak, soha nem hagyják el a rendszert. Integrációk (MCP szerverek) telepítésekor a szükséges API kulcsokat itt tárolhatod biztonságosan.`
- EN: `**AES-256-GCM** encryption · Keys are stored exclusively on the local machine and never leave the system. When installing integrations (MCP servers) you can store the required API keys here securely.`

---

## 2) PAGE LAYOUT & APPEARANCE (structure only — defer look to 01-design.md)

Top to bottom, single scrolling column:

1. **Page header row.** Left: H1 + subtitle. Right: a horizontal cluster of action buttons (Bind, Scan & Import, Sync) plus a primary "New key" button. On narrow widths the button cluster wraps below the title.
2. **Info banner** (the encryption callout above).
3. **Stat strip** — a row of four small stat cards (big number/value on top, small label under).
4. **System integrations card** — a self-contained card ("guided" settings) with its own heading, a dynamic list of labeled fields, a Save button, a "Check for updates now" button, a status line, and a small live status row for the image-generation backend.
5. **Add-secret panel** — hidden by default; slides/appears inline (not a modal) when "New key" is pressed. Contains three labeled fields and a save button, plus a close (×) control.
6. **Search bar** — a full-width text input with a magnifier icon, filters the grid live.
7. **Secrets grid** — a responsive grid of secret cards (metadata only). When empty, a centered empty-state block with padlock icon + hint replaces the grid.
8. **Three modal overlays** (rendered but hidden until invoked): Bind modal, Scan & Import modal. (Add-secret is the inline panel, not a modal.)

All values shown anywhere in this page that could be a secret are masked or hidden by default. The grid and all lists show metadata only.

---

## 3) CONTROLS (every button / field / dropdown / toggle / filter / search)

### Header action buttons (left-to-right)
- **Bind / Hozzárendelés** (secondary button, link-chain icon). Tooltip HU `Vault kulcs hozzárendelése integrációhoz` / EN `Bind a vault key to an integration`. Opens the Bind modal.
- **Scan & Import / Scan & Import** (secondary button, magnifier icon). Label kept identical in both languages. Tooltip HU `Konfigurációk átvizsgálása érzékeny kulcsokért` / EN `Scan configs for sensitive keys`. Runs the scan and opens the Scan modal. While running, the button is disabled and its text changes to HU `Keresés...` / EN `Scanning...`.
- **Sync / Szinkron** (secondary button, circular-arrows/refresh icon). Tooltip HU `Vault értékek szinkronizálása a konfigurációs fájlokba` / EN `Sync vault values into config files`. While running, disabled with text HU `Szinkron...` / EN `Syncing...`.
- **New key / Új kulcs** (primary button, plus icon). Toggles the inline add-secret panel open/closed; when opening, focus jumps to the first field.

### Stat strip (read-only, no interaction)
- Card 1: value = live count of stored secrets; label HU `Tárolt kulcs` / EN `Stored keys`.
- Card 2: value = `AES-256` (static); label HU `Titkosítás` / EN `Encryption`.
- Card 3: value = live count of bindings; label HU `Kötés` / EN `Bindings`.
- Card 4: value = HU `Helyi` / EN `Local` (static); label HU `Tárolás` / EN `Storage`.

### System integrations card (the "guided" settings card)
- Heading HU `Rendszer-integrációk` / EN `System integrations`.
- Sub-line HU `Webről megadott kulcsok — a titkok titkosítva a Vaultba kerülnek, és azonnal alkalmazódnak (újraindítás nélkül).` / EN `Keys entered from the web — secrets go encrypted into the Vault and apply immediately (no restart).`
- A dynamically-rendered list of fields, one per defined integration setting (see §5 for the card's full contents).
- **Save / Mentés** (primary, compact).
- **Check for updates now / Frissítés-ellenőrzés most** (secondary, compact) tooltip HU `Frissítés-ellenőrzés futtatása a beállított repón` / EN `Run an update check on the configured repo`.
- A status line (initially empty) that shows save result / check result / errors.
- A live status row for the image-generation backend: a colored status dot, a status text (HU prefix `ComfyUI: …`), and a right-aligned **Wake / Ébresztés** button that appears only when the backend is reachable-but-asleep and wakeable.

### Add-secret inline panel
- Panel header HU `Új kulcs hozzáadása` / EN `Add a new key` + a close (×) control.
- Field 1 **Key name / Kulcs neve** — text input, placeholder HU/EN `pl. OPENAI_API_KEY` / `e.g. OPENAI_API_KEY`. This is the secret's id (stable handle).
- Field 2 **Description (optional) / Leírás (opcionális)** — text input, placeholder HU `pl. OpenAI production key` / EN `e.g. OpenAI production key`. Human-friendly label; if left blank it defaults to the key name.
- Field 3 **Value / Érték** — password-type input (masked), placeholder `sk-...`. The actual secret.
- **Save to Vault / Mentés a Vault-ba** (primary, padlock icon). Pressing Enter in the Value field triggers save.

### Search bar
- Full-width text input, magnifier icon, placeholder HU `Keresés a kulcsok között...` / EN `Search keys...`. Filters the grid live as you type, matching against both the key name (id) and the description (label), case-insensitive. Empty query restores the full grid.

### Per-card controls — see §4.

### Bind modal controls — see §5.

### Scan modal controls — see §5.

There are no tabs, no sort dropdowns, and no status filters on this page beyond the single search box.

---

## 4) LISTS / CARDS / TABLES

### The secrets grid (the core list — METADATA ONLY)
Each stored secret renders as one card. **A card NEVER contains the secret value.** The card shows only:

- **Padlock icon** (small, top-left of the card).
- **Key name (id)** — the stable handle, prominent.
- **Binding badge** (only if this secret has ≥1 binding): a small pill next to the id reading HU `{n} kötés` / EN `{n} binding(s)`, with a tooltip stating the same count. Hidden when the secret has no bindings.
- **Description (label)** — shown as a secondary line ONLY when the description differs from the key name (no redundant repetition).
- **Updated date** — a short localized date (day-level granularity, locale-formatted; HU default locale). No time-of-day.

**Per-card action row** (three compact buttons):
1. **Reveal / Mutat** (eye icon). Toggles the single value in/out of view for this one card (see §6 reveal flow). When revealed, the button label flips to HU `Elrejt` / EN `Hide` with a crossed-eye icon, and a value block appears appended to the card (selectable text, monospace). Pressing Reveal again removes the value block and resets the label.
2. **Edit / Módosít** (pencil icon). Opens an inline edit form within the card (see §6). Mutually exclusive with the reveal block — opening edit clears any shown value.
3. **Delete / Törlés** (trash icon). Deletes the secret after a confirmation (see §6).

The grid is the only list of secrets. The values list (`GET /api/vault`) returns metadata only — id, label, createdAt, updatedAt — and the front end stores only that. The plaintext value is fetched lazily, one secret at a time, only on an explicit Reveal/Edit action.

### Inline edit form (appears inside a card when Edit is pressed)
- One masked (password-type) input pre-filled with the current value (fetched on demand), focused and text-selected on open.
- **Save / Mentés** (primary, compact) and **Cancel / Mégse** (secondary, compact). Enter saves, Escape cancels. Toggling Edit again (or Cancel) removes the form.

### Scan results list — see §5 (it is a list of grouped findings inside the Scan modal).

---

## 5) OPENED CARDS / MODALS / DETAIL PANES (full contents of each)

### A) Add-secret inline panel (already detailed in §3)
Three fields (Key name, Description optional, Value masked) + "Save to Vault". Header + × close. It is a toggled inline panel above the grid, not an overlay.

### B) System integrations card (full contents)
This card is a "guided" set of well-known settings, each driven by a definition (key, label, description, whether it is secret, placeholder). For each defined setting it renders:
- A label that includes a small inline state chip:
  - If already set: chip HU `beállítva` / EN `set`, optionally followed by a short non-sensitive preview in monospace (a preview is shown only for non-sensitive previews; secret values show no preview).
  - If not set: chip HU `nincs beállítva` / EN `not set`.
- An input. Type is masked (password) for secret settings, plain text otherwise. Autocomplete off. Placeholder = the setting's placeholder; for a secret that is already set, the placeholder instead reads HU `(változatlanul hagyhatod)` / EN `(leave blank to keep)`.
- A small description line under the input.

Behavior nuance: a **secret** field left blank on Save means "keep the existing value" (do not overwrite). A **non-secret** field left blank means "clear it." Secret settings are written encrypted into the vault (and mirrored to the runtime environment); non-secret settings are written to the runtime environment only.

Footer of this card: Save, "Check for updates now," status line, and the image-backend live status row (dot + text + Wake button) described in §3. The image-backend status polls roughly every 20 seconds while the Vault page is open and stops/refreshes when you leave.

Representative settings this card may render (concept-level, define your own set): a self-hosted update-source repo (non-secret, e.g. `owner/repo`), a personal access token for that repo (secret), an image-generation backend URL (non-secret), a default image model name (non-secret), and an SSH wake target for the image backend (non-secret).

### C) Bind modal — "Bind a key" / "Kulcs hozzárendelése"
Title HU `Kulcs hozzárendelése` / EN `Bind a key`. × close. Body has three controls in a vertical form:
- **Vault key / Vault kulcs** — a dropdown listing every stored secret. Each option shows the key name, and if the description differs, the description in parentheses: `id (label)`. If there are no secrets, a single disabled option HU `-- Nincs vault kulcs --` / EN `-- No vault key --`.
- **Integration server / MCP szerver** — a dropdown of installed integration servers (excluding plugin- and cloud-native connectors that cannot take injected env). Each option shows the server name, and if the server is scoped to a specific agent/project rather than global, the scope in parentheses. If none, a disabled option HU `-- Nincs MCP szerver --` / EN `-- No MCP server --`.
- **Environment variable name / Környezeti változó neve** — text input, placeholder `pl. API_KEY` / `e.g. API_KEY`. The env var name the server config should expose, which will be set to a reference to the chosen secret.
- A status line (hidden until there is something to say): success state shows e.g. HU `Hozzárendelve! {n} fájl frissítve.` / EN `Bound! {n} file(s) updated.`; error state shows the returned error or a generic message.

Footer: **Bind / Hozzárendelés** (primary). While saving, disabled with text HU `Mentés...` / EN `Saving...`. On success the modal auto-closes after a short delay (~1.5s) and the page refreshes its counts and grid. Validation: all three controls required; if any is empty, show the inline error HU `Minden mező kitöltése kötelező` / EN `All fields are required` and do not submit.

### D) Scan & Import modal — "Find secrets in configs" / "MCP titkok keresése"
Title HU `MCP titkok keresése` / EN `Find secrets in configs`. × close. Body:
- A descriptive line HU `A rendszer átvizsgálja az összes konfigurációs fájlt és megkeresi az érzékeny konfigurációs értékeket (API kulcsok, tokenek, jelszó-szerű értékek).` / EN `The system scans all config files and finds sensitive config values (API keys, tokens, password-like values).`
- A **results list** (populated by the scan) — see the finding row below.
- An **empty/clean message** (shown when there is nothing actionable): default HU `Nem találtam érzékeny értéket a konfigurációkban.` / EN `No sensitive values found in the configs.` Special case: if sensitive values were found but every one of them is already in the vault, the message instead reads HU `{n} érzékeny érték található, de mind már a Vault-ban van.` / EN `{n} sensitive values found, but all are already in the Vault.`

**Each finding row** (findings are grouped by server + env-var so the same leaked value across multiple files collapses into one row):
- A **checkbox**, checked by default (selects this finding for import).
- Server name (the integration the leak was found in).
- The env-var name followed by a **masked** preview of the value in monospace (only first few + last few characters; never the full value). E.g. `API_KEY = abc...xyz`.
- A small count line HU `{n} fájlban` / EN `in {n} file(s)` — how many config files contain this same value.
- A **suggested vault id** text input, pre-filled with a sensible default name (e.g. `{server}-{envVar}`), editable — this becomes the secret's key name on import.

Footer (shown only when there is at least one actionable finding): **Import selected / Kiválasztottak importálása** (primary). While running, disabled with text HU `Importálás...` / EN `Importing...`.

---

## 6) FLOWS & BEHAVIOR (step by step; API contract + effect; confirmations)

> All endpoints below are illustrative REST contracts (concept, not code). Every `/api/*` call carries a single bearer token (see §8). Responses are JSON.

### Page load
1. On navigating to Vault, the page fetches the secrets metadata list (`GET /api/vault` → `{ secrets: [{ id, label, createdAt, updatedAt }] }`) and the bindings list (`GET /api/vault/bindings` → `{ bindings: [{ vaultSecretId, envVar, targets:[…] }] }`) in parallel.
2. It updates the "Stored keys" stat to the secrets count and the "Bindings" stat to the bindings count, then renders the grid. The bindings list is used only to compute the per-card binding badge counts — it does NOT fetch any values.
3. It then loads the system-integrations card and starts the image-backend status poll.

### Add a secret
1. Operator presses **New key**, fills Key name + (optional) Description + Value, presses **Save to Vault** (or Enter in Value).
2. Client requires non-empty Key name and non-empty Value (no submit otherwise).
3. `POST /api/vault` with `{ id, label, value }` (label defaults to id). Server encrypts the value (authenticated AES-256-GCM, per-entry random salt+iv) and stores the entry; if the id already exists it overwrites the value/label but preserves the original created timestamp.
4. Server then immediately **syncs** any existing bindings for that id into their config files and returns `{ ok: true, synced: <count> }`.
5. Client clears the fields, closes the panel, and reloads the grid + counts.

### Reveal a single value
1. Operator presses **Reveal** on a card.
2. Client fetches that one secret's plaintext on demand: `GET /api/vault/{id}` → `{ id, value }` (404 → `{ error: 'Not found' }`).
3. The value is shown appended to that card only, as selectable monospace text; the button flips to **Hide**. Pressing again removes it. The value is never stored in the metadata list and never logged. Each card reveals independently.

### Edit a secret value
1. Operator presses **Edit**. The card removes any shown value, fetches the current value on demand (`GET /api/vault/{id}`), and shows a masked input pre-filled with it.
2. Operator changes it, presses **Save** (or Enter). Empty value = no-op.
3. Client calls `POST /api/vault` with `{ id, label, value }` (re-uses the existing label). Same overwrite-preserving-createdAt behavior as Add.
4. Server re-syncs bindings. Client removes the form, shows a toast HU `Kulcs frissítve és szinkronizálva` / EN `Key updated and synced`, reloads grid + counts.

### Delete a secret (DESTRUCTIVE → confirm)
1. Operator presses **Delete**. A confirmation prompt appears: HU `Törlöd: {id}?` / EN `Delete {id}?`. Cancel aborts.
2. On confirm: `DELETE /api/vault/{id}` (404 → not found). Server deletes the encrypted entry AND removes every binding that referenced this secret — and as part of that removal, strips the corresponding env var out of each affected config file (and undoes any command-wrapping that is no longer needed). Returns `{ ok: true }`.
3. Client reloads grid + counts.

### Bind a secret to an env var (the binding flow)
1. Operator opens the Bind modal; it concurrently fetches the secrets list and the integration-servers list to fill the two dropdowns.
2. Operator selects a vault key, an integration server, types an env-var name, presses **Bind**.
3. `POST /api/vault/bindings` with `{ vaultSecretId, envVar, serverName }`. The server resolves which config files contain that named server across all known scopes (project-level, user-level, each agent's config, each agent's sub-projects, and any registered external project paths), and records a binding mapping the secret → env var → those file targets. If no file contains that server, it returns `400 { error: 'No targets found for this server' }`.
4. The server then **syncs**: in each target config file it sets the server's env var to a reference token that points at the vault secret (it does NOT write the plaintext), and wraps the server's launch command with a small env-injecting wrapper so the real value is resolved at runtime. Returns `{ ok: true, synced: <fileCount>, errors: [...] }`.
5. Modal shows the success line with the updated-file count, refreshes the page, auto-closes.

### Sync all bindings
1. Operator presses **Sync** in the header.
2. `POST /api/vault/sync` re-applies every binding to its target config files (idempotent: ensures each bound env var equals its vault reference and the command wrapper is in place). Returns `{ ok: true, updated: <count>, errors: [...] }`.
3. Toast: if `updated > 0` → HU `{n} konfiguráció frissítve` / EN `{n} configs updated`; else HU `Nincs szinkronizálandó kötés` / EN `Nothing to sync`. Any errors are surfaced in a second toast.

### Scan for leaks
1. Operator presses **Scan & Import**.
2. `GET /api/vault/scan` → `{ findings: [{ mcpFilePath, serverName, envVar, maskedValue, suggestedVaultId, alreadyInVault, existingVaultId? }] }`. The server walks every known config file and, for each integration server's env block, flags entries whose **key name looks sensitive** (matches patterns like ends-with `_KEY`/`_TOKEN`/`_SECRET`/`_PASSWORD`/`_PASS`, starts-with `API_`/`AUTH_`/`OAUTH_`, or contains `PASSWORD`/`CREDENTIAL`/`ACCESS_KEY`) AND whose **value looks like a real secret** (long enough, and not an obvious non-secret like a boolean, a URL, a pure number, a path, or an existing vault-reference token). Each finding's value is masked to first-few + last-few characters; the full value is never returned by the scan. If a finding's value already matches a stored secret, it is flagged `alreadyInVault` with the existing id.
3. The Scan modal opens. Findings already in the vault are filtered out of the actionable list; remaining findings are grouped by server+env-var into rows (see §5D). If nothing actionable, the clean/already-in-vault message shows.

### Import selected leaks (writes secrets + bindings)
1. Operator reviews rows, unchecks any they don't want, edits suggested vault ids, presses **Import selected**.
2. The client re-runs the scan to get fresh full data, then for each checked row builds an import request: server, env var, the chosen vault id, a generated label (`{envVar} ({server})`), `createBinding: true`, and the list of file targets. If nothing is checked → toast HU `Nincs kiválasztott elem` / EN `Nothing selected`.
3. `POST /api/vault/import` with `{ imports: [...] }`. For each import the server reads the real plaintext value out of one of the target files, stores it encrypted under the chosen vault id, and (because createBinding is set) records a binding and syncs it — meaning the plaintext in the config files gets replaced by a vault reference and the launch command gets wrapped. Returns `{ ok: true, imported: <count>, bound: <count>, errors: [...] }`.
4. Toast HU `{imported} kulcs importálva, {bound} kötés létrehozva` / EN `{imported} keys imported, {bound} bindings created`; errors in a second toast. Modal closes; grid + counts reload.

### Confirmations
Only **Delete** uses a blocking confirm. Bind, Sync, Scan, and Import are non-destructive to secrets (they only add/move plaintext into the encrypted store and rewrite config files to reference it) and proceed without an extra confirm, but each reports its result via toast/status.

---

## 7) STATES

- **Loading.** On page entry, while the parallel metadata fetches are in flight, the grid is empty and the stat values sit at their initial placeholders (0 / AES-256 / 0 / Local). The page is resilient: if the fetches fail it silently leaves the grid empty rather than blocking. (You may add a subtle skeleton per `01-design.md`.)
- **Empty (no secrets).** The grid is replaced by a centered empty state: padlock icon, HU `Még nincs tárolt kulcs` / EN `No keys stored yet`, and a hint HU `Adj hozzá egyet az "Új kulcs" gombbal` / EN `Add one with the "New key" button`.
- **Empty search result.** Typing a query that matches nothing yields an empty grid (no cards); clearing the query restores all cards. (Optionally reuse the empty-state copy.)
- **Reveal/Edit fetch error or missing value.** If the on-demand value fetch returns nothing/404, the card simply does not show a value/edit form (fail-closed; never show a partial or stale value).
- **Bind modal with no inputs available.** If there are no secrets, the secret dropdown shows a disabled placeholder option; if there are no eligible servers, the server dropdown shows a disabled placeholder option — the operator cannot submit a meaningless binding.
- **Scan: clean vs already-covered.** Two distinct empty messages (nothing found vs all-already-in-vault) as in §5D.
- **Errors.** Network or server errors during Bind surface in the modal's inline status line; during Sync/Import/Scan they surface as toasts. Validation errors (missing required fields) surface inline before any request is made.
- **Live updates / polling.** The secrets grid is NOT auto-polled — it refreshes after each mutation (add/edit/delete/bind/import) and on page entry. The only live poll on the page is the image-backend status row (~20s cadence) inside the system-integrations card, which starts when the page opens and is replaced/cleared when it reloads or you leave.

---

## 8) PERMISSIONS / VISIBILITY

- **Single-gate model.** Every `/api/*` route on this page (and the whole dashboard) is protected by one bearer token. Static assets and an auth-status endpoint are public so the UI can boot; all data and all secret reads/writes require the token. Reveal/Edit therefore both require the token — i.e. revealing a value is "behind the dashboard token." There is no per-field second factor.
- **Operator vs agent.** This page is an **operator** surface, reached through the authenticated web dashboard. Background agents do not browse this UI; when an agent's tooling needs a secret, the value is injected at runtime via the binding/wrapper mechanism (the agent's config holds only a reference token, never the plaintext), so agents get the value without ever seeing the vault list or calling a "reveal." There is no autonomy-level gating on the Vault routes themselves — possession of the dashboard token is the authorization.
- **Security discipline (enforce in implementation):**
  - The list endpoint returns metadata ONLY (id, label, timestamps). Plaintext is returned solely by the single-secret reveal endpoint, one id per call.
  - Never log secret values. Scan/import responses mask values; sync/bind logs record counts and ids, not values.
  - Config files are rewritten to hold a vault **reference**, never the plaintext, once a secret is bound/imported.
  - The encrypted store and the master key file are written with owner-only permissions; the master key never leaves local storage.

---

## 9) DATA CONCEPTS (concept-level, read/written)

- **Secret entry** — concept fields: a stable id (key name), a human label/description, the encrypted value blob (authenticated AES-256-GCM with a per-entry random salt and IV; the value is never stored or transmitted in plaintext at rest), a created timestamp, an updated timestamp. The list view exposes only {id, label, createdAt, updatedAt}.
- **Master key** — a locally stored secret used to derive per-entry encryption keys; owner-only; never sent to the client. (On platforms with an OS keychain it may live there; otherwise an owner-only local file.)
- **Binding** — concept fields: the secret id it injects, the env-var name it sets, and a list of file targets (each = a config file path + the named server within it). Bindings are read to compute card badges and stats, and written by Bind/Import; removed on Delete.
- **Scan finding** (transient, not persisted) — the config file it was found in, the server name, the env-var name, a masked value preview, a suggested vault id, an already-in-vault flag (+ the existing id when matched).
- **System-integration setting** (separate, guided) — a defined {key, label, description, secret-flag, placeholder}; secret ones write to the vault + runtime env, non-secret ones to runtime env only; the UI shows a set/not-set chip and, for non-secrets, a short preview.

---

## 10) i18n

All strings ship in **HU (default)** and **EN**. Consolidated table (HU | EN):

**Page chrome**
- Nav / title: `Vault` | `Vault`
- Subtitle: `Titkosított kulcsok és API tokenek` | `Encrypted keys and API tokens`
- Info banner: `**AES-256-GCM** titkosítás · A kulcsok kizárólag a helyi gépen tárolódnak, soha nem hagyják el a rendszert. Integrációk telepítésekor a szükséges API kulcsokat itt tárolhatod biztonságosan.` | `**AES-256-GCM** encryption · Keys are stored exclusively on the local machine and never leave the system. Store the API keys integrations need here, securely.`

**Stats**
- `Tárolt kulcs` | `Stored keys` · `Titkosítás` | `Encryption` · `Kötés` | `Bindings` · `Tárolás` | `Storage` · `Helyi` | `Local`

**Header buttons + tooltips**
- `Hozzárendelés` | `Bind` (tt `Vault kulcs hozzárendelése integrációhoz` | `Bind a vault key to an integration`)
- `Scan & Import` | `Scan & Import` (tt `Konfigurációk átvizsgálása érzékeny kulcsokért` | `Scan configs for sensitive keys`), busy `Keresés...` | `Scanning...`
- `Szinkron` | `Sync` (tt `Vault értékek szinkronizálása a konfigurációs fájlokba` | `Sync vault values into config files`), busy `Szinkron...` | `Syncing...`
- `Új kulcs` | `New key`

**Add panel**
- `Új kulcs hozzáadása` | `Add a new key`
- `Kulcs neve` | `Key name` (ph `pl. OPENAI_API_KEY` | `e.g. OPENAI_API_KEY`)
- `Leírás (opcionális)` | `Description (optional)` (ph `pl. OpenAI production key` | `e.g. OpenAI production key`)
- `Érték` | `Value` (ph `sk-...`)
- `Mentés a Vault-ba` | `Save to Vault`

**Search**: `Keresés a kulcsok között...` | `Search keys...`

**Card actions / badge**
- `Mutat` | `Reveal` · `Elrejt` | `Hide` · `Módosít` | `Edit` · `Törlés` | `Delete`
- `Mentés` | `Save` · `Mégse` | `Cancel`
- badge `{n} kötés` | `{n} binding(s)`
- delete confirm `Törlöd: {id}?` | `Delete {id}?`
- edit toast `Kulcs frissítve és szinkronizálva` | `Key updated and synced`

**Empty state**: `Még nincs tárolt kulcs` | `No keys stored yet` · hint `Adj hozzá egyet az "Új kulcs" gombbal` | `Add one with the "New key" button`

**Bind modal**
- `Kulcs hozzárendelése` | `Bind a key`
- `Vault kulcs` | `Vault key` · `MCP szerver` | `Integration server` · `Környezeti változó neve` | `Environment variable name` (ph `pl. API_KEY` | `e.g. API_KEY`)
- empty options `-- Nincs vault kulcs --` | `-- No vault key --` · `-- Nincs MCP szerver --` | `-- No MCP server --`
- button `Hozzárendelés` | `Bind`, busy `Mentés...` | `Saving...`
- validation `Minden mező kitöltése kötelező` | `All fields are required`
- success `Hozzárendelve! {n} fájl frissítve.` | `Bound! {n} file(s) updated.`

**Sync toasts**: `{n} konfiguráció frissítve` | `{n} configs updated` · `Nincs szinkronizálandó kötés` | `Nothing to sync` · `Hibák: …` | `Errors: …`

**Scan modal**
- `MCP titkok keresése` | `Find secrets in configs`
- desc `A rendszer átvizsgálja az összes konfigurációs fájlt és megkeresi az érzékeny konfigurációs értékeket (API kulcsok, tokenek, jelszó-szerű értékek).` | `The system scans all config files and finds sensitive config values (API keys, tokens, password-like values).`
- clean `Nem találtam érzékeny értéket a konfigurációkban.` | `No sensitive values found in the configs.`
- already-covered `{n} érzékeny érték található, de mind már a Vault-ban van.` | `{n} sensitive values found, but all are already in the Vault.`
- row count `{n} fájlban` | `in {n} file(s)`
- footer button `Kiválasztottak importálása` | `Import selected`, busy `Importálás...` | `Importing...`
- import toasts `{imported} kulcs importálva, {bound} kötés létrehozva` | `{imported} keys imported, {bound} bindings created` · `Nincs kiválasztott elem` | `Nothing selected`

**System integrations card**
- `Rendszer-integrációk` | `System integrations`
- sub `Webről megadott kulcsok — a titkok titkosítva a Vaultba kerülnek, és azonnal alkalmazódnak (újraindítás nélkül).` | `Keys entered from the web — secrets go encrypted into the Vault and apply immediately (no restart).`
- chips `beállítva` | `set` · `nincs beállítva` | `not set` · ph for set secret `(változatlanul hagyhatod)` | `(leave blank to keep)`
- `Mentés` | `Save` · `Frissítés-ellenőrzés most` | `Check for updates now` (tt `Frissítés-ellenőrzés futtatása a beállított repón` | `Run an update check on the configured repo`)
- save status `Mentve ({n} mező).` | `Saved ({n} fields).` · `Nincs változás.` | `No changes.` · error `Hiba: …` | `Error: …`
- image-backend status prefix `ComfyUI: …`, wake button `Ébresztés` | `Wake`

---

### Implementation notes for Fable 5
- Build the grid and the metadata list strictly value-free. Treat any code path that puts a secret value into the list model, a log line, or a config file (other than as an encrypted blob or a reference token) as a bug.
- Reveal and Edit are the only two places a single plaintext crosses to the client, each one id at a time, each behind the bearer token, and never cached in the list model.
- Delete must cascade: drop the encrypted entry, drop its bindings, and clean the referenced env vars out of the affected config files.
- Bind/Import/Sync all converge on the same "write a reference + wrap the launch command" mechanism so the running tool resolves the real value at runtime.
- Defer every visual decision (card chrome, modal styling, dark theme, stat-card look, badge pill, toast style) to `01-design.md`.
