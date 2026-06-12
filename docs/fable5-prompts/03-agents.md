# Build Prompt — Agents (Ügynökök) View

> **Clean-room notice (Fable 5):** You have never seen the original product. This document is a *behavioral and visual specification* written from observed behavior. Implement it originally — invent your own code, identifiers, file/route names, data structures and storage. Nothing here is source code; treat it as a product requirements document. For all look-and-feel (colors, spacing, typography, radii, shadows, motion, component styling), defer to **01-design.md** — this file describes *structure and behavior*, never restate colors or pixel values.

The product is a single-operator, self-hosted control panel for a fleet of AI "agents." This view is where the operator sees the whole roster, creates new agents, and opens a deep per-agent configuration panel. All UI strings ship in **Hungarian (default)** and **English** (see §10). HU labels are authoritative; the EN translations are given alongside each control.

---

## 1) PURPOSE & WHERE IT LIVES

**Purpose.** A roster + management surface for the operator's AI agents. From here the operator:
- sees every agent as a card with live status (running / channel-connected),
- creates a brand-new agent via a guided 3-step wizard,
- opens any agent's detail panel to start/stop/restart it, edit its identity & model, set its security profile, wire it into the team graph, configure auto-restart, connect a chat channel (Telegram/Discord), manage skills, change its avatar, and delete it,
- pops a live, interactive terminal for any agent.

**Nav item.** A left-sidebar link.
- **Label:** `Ügynökök` / `Agents`.
- **Icon idea:** a "group of people" glyph (two or three overlapping person silhouettes) — connoting a team/roster. (A separate `Csapat`/`Team` nav item shows the hierarchy graph; do not conflate. This view is the roster of cards.)

**Page header.**
- **Title:** `Csapat` / `Team`.
- **One-line subtitle:** `AI csapattagok kezelése` / `Manage your AI teammates`.

(Note: the page title text reads "Csapat/Team" even though the nav item reads "Ügynökök/Agents"; keep both as specified.)

---

## 2) PAGE LAYOUT & APPEARANCE

Single scrollable page. Top region is the page header (title + subtitle). Below it, the **agent grid** — a responsive multi-column grid of equal-height cards that wraps. Defer all card sizing/spacing to 01-design.md.

Card ordering within the grid:
1. **Orchestrator card first** (the hub agent; see §4) — always rendered at the front when present.
2. **All other agent cards**, in roster order as returned by the backend.
3. **"New agent" tile last** — a dashed/ghost "add" tile that opens the creation wizard.

All heavy interactions happen in **modal overlays** layered above the page (creation wizard, agent detail, skill editor, terminal, plus small confirm/sub-modals). Modals: centered, dimmed backdrop, close via an `×` button, click-on-backdrop, or `Esc`. Opening a modal locks background scroll.

---

## 3) CONTROLS (every interactive element)

### Page / grid
- **"New agent" tile** — `Új ügynök` / `New agent`. A large `+` tile at the end of the grid. Click → opens the Creation Wizard at step 1, focuses the name field.
- **Per-card "Terminal" button** — `Terminal` / `Terminal` (small, with a terminal/prompt icon). Click → opens the Terminal modal for that agent. Click must not also open the detail panel (stop propagation).
- **Per-card body click** (anywhere except the buttons) → opens that agent's Detail panel.
- **Per-card "Login" button** (conditional) — `Bejelentkezés` / `Log in` (danger-styled). Appears only inside a re-auth banner on a card whose running session shows an auth failure. Drives a 2-phase login flow (see §6).

### Creation Wizard
**Step 1 — identity:**
- **Avatar gallery** — header `Válassz avatart` / `Choose an avatar`: a grid of selectable preset avatar thumbnails (single-select; selecting one highlights it and clears any uploaded file).
- **Divider** — `vagy` / `or`.
- **Avatar upload drop-zone** — `Kép feltöltése (max 1 MB)` / `Upload image (max 1 MB)`. Click or drag-drop. Accepts png/jpg/jpeg/webp, ≤ 1 MB. Shows a thumbnail preview with a clear (`×`) button. Choosing a file clears any gallery selection (mutually exclusive).
- **Text field "Name"** — `Név` / `Name`. Placeholder: `pl. kutató, copywriter, fejlesztő` / `e.g. researcher, copywriter, developer`. Required.
- **Textarea "Free-form description"** — label `Írd le szabadon, mit szeretnél hogy csináljon ez az ügynök` / `Describe freely what you want this agent to do`. Placeholder example: `pl. Piackutatást végez, versenytársakat elemez, táblázatos összefoglalókat készít magyarul.` / `e.g. Does market research, analyzes competitors, produces tabular summaries in Hungarian.` Required.
- **Dropdown "Model"** — `Modell` / `Model`. Options grouped:
  - First option: `Öröklött (alapértelmezett)` / `Inherited (default)` (value = inherit).
  - Group "☁️ Claude (cloud)" — `☁️ Claude (felhő)`: model entries with HU descriptive labels (e.g. an Opus "1M context" entry, two further Opus tiers, a default Sonnet labeled "fast & smart" / `gyors és okos`, and a Haiku labeled "fastest" / `leggyorsabb`). The exact model ids come from the model-list API (§9); render label text from there.
  - Group "🌊 DeepSeek (alternatív)" / `🌊 DeepSeek (alternative)`: populated from the model-list API; **hidden when no DeepSeek key is configured.**
- **Dropdown "Security profile"** — `Biztonsági profil` / `Security profile`. Populated from the profiles API (§9). Each option text = profile label; if a profile is a "strict" permission mode, append ` (szigorú)` / ` (strict)` to its option text. Below the dropdown, a small live **description line** showing the selected profile's description text (updates on change).
- **Button "Next"** — `Tovább` / `Next`. Validates name + description non-empty (focuses the first empty one), then advances to step 2 and kicks off generation.

**Step 2 — generation (no inputs):** a spinner with a status line that updates through phases (e.g. "Generating CLAUDE.md…", "Generating SOUL.md…", "Done!") and a sub-line `Ez néhány másodpercig tarthat` / `This may take a few seconds`. Auto-advances to step 3.

**Step 3 — review/edit generated identity:**
- **Textarea — primary instruction doc** label `CLAUDE.md`, monospace, prefilled with generated content, editable.
- **Textarea — persona doc** label `SOUL.md`, monospace, prefilled with generated content, editable.
- **Button "Back"** — `Vissza` / `Back` → returns to step 1.
- **Button "Create"** — `Létrehozás` / `Create` (shows an inline loading state `Létrehozás...` / `Creating…`). Saves the edited docs and finishes (see §6).
- **Step indicator** across the top: three pips reflecting current/done steps.

### Agent Detail panel
**Header:** agent display name as title; `×` close button.

**Tab bar** (5 tabs):
- `Áttekintés` / `Overview`
- `Beállítások` / `Settings`
- `Csatorna` / `Channel`
- `Skillek` / `Skills`
- `Csapat` / `Team`

**Overview tab controls:**
- **Avatar with an edit button** — small pencil button `Avatar változtatás` / `Change avatar`. Toggles an avatar-picker drawer (gallery grid + upload zone, identical pattern to the wizard's).
- **Process control row:** a status dot + label, an optional uptime/session hint, and action buttons:
  - **Start** — `Indítás` / `Start` (primary; shown when stopped; has inline spinner).
  - **Stop** — `Leállítás` / `Stop` (danger; shown when running).
  - **Channels restart** — `Channels restart` (danger; orchestrator-only; hidden for normal agents).

**Settings tab controls** (each section has its own **Save** button = `Mentés` / `Save`):
- **Dropdown "Model"** — `Modell` / `Model`. Same Claude group + DeepSeek group + an **Ollama (local)** group `🏠 Ollama (lokális)` / `🏠 Ollama (local)` populated from a local-model API (each option text = `name (size)`); group hidden/empty when unavailable. Save here triggers a model change + agent restart (see §6). A small hint under it (hidden unless DeepSeek unconfigured): `DeepSeek-V4-Pro nincs konfigurálva.` + an inline link `API kulcs hozzáadása` / `Add API key` that navigates to the secrets/Vault page.
- **Auto-restart block** — `Automatikus újraindítás` / `Automatic restart`. Contains:
  - An explanatory paragraph (long sessions slow down; periodic restart keeps the session fresh; default runs after the nightly consolidation).
  - **Toggle "Enabled"** — `Bekapcsolva` / `Enabled` (checkbox).
  - **Dropdown "Mode"** — `Mód` / `Mode`: `Folytatás — kontextus megmarad, tier/limit frissül` / `Continue — keep context, refresh tier/limit` and `Friss — kontextus eldobása (ez gyorsít)` / `Fresh — drop context (this speeds it up)`.
  - **Dropdown "Schedule kind"** — `Ütemezés` / `Schedule`: `Napi időpont` / `Daily time` or `Óránként` / `Hourly`.
  - **Time field** — `Időpont` / `Time` (HH:MM; shown when "daily").
  - **Number field** — `Óránként` / `Every N hours` (1–168; shown when "hourly").
  - A small note: the main channels-session always restarts fresh; restart never interrupts running work (only restarts when idle, else defers).
- **Auth-mode block** — `Hitelesítési mód` / `Authentication mode`. Three selectable cards (radio):
  - `Megosztott` / `Shared` — desc `A host OAuth hitelesítését használja (alapértelmezett)` / `Uses the host's OAuth (default)`. Expands a sub-panel with an **Apply** button `Alkalmazás` / `Apply` ("Apply host OAuth" — restarts the agent with host auth).
  - `Saját Team login` / `Own Team login` — desc `Külön Anthropic Team login saját OAuth-tal` / `Separate Team login with its own OAuth`. Expands a sub-panel with a **Log in** button `Bejelentkezés` / `Log in` that starts an interactive login flow and returns an auth URL the operator opens in a browser, with a **Copy** button `Másolás` / `Copy`.
  - `API kulcs` / `API key` — desc names an API-key env from the secret store. Expands a **password field** (placeholder `sk-ant-...`) and a status line ("key configured" / "no key set").
  - **Save** button under the block.
- **Dropdown "Security profile"** — `Biztonsági profil` / `Security profile` (same options as wizard) + live description line + its **Save** (saving may report "restart required" `Profil mentve (újraindítás szükséges)`).
- **Textarea `CLAUDE.md`** (monospace) + Save.
- **Textarea `SOUL.md`** (monospace) + Save.
- **Textarea `.mcp.json`** (monospace; tool/MCP config) + Save.

**Channel tab controls:**
- **Dropdown "Channel provider"** — `Csatorna provider` / `Channel provider`: `Telegram`, `Discord` (a Slack variant exists in copy but the live picker offers Telegram + Discord). Switching re-renders the whole tab's copy and fields for that provider.
- **Not-connected state:**
  - Provider setup instructions (numbered, provider-specific).
  - **Text field "Bot token"** — label is provider-specific (`Bot API Token` for TG, `Bot Token` for Discord) with a provider-specific placeholder.
  - **(Discord only) Text field "Channel ID"** — `Discord Channel ID`, placeholder a long numeric id, with a help note on how to copy a channel id.
  - **(Slack-only, normally hidden) App token field** + a **"Create Slack App (manifest)"** helper button.
  - **Button "Connect"** — `Összekapcsolás` / `Connect` (inline loading `Csatlakozás...`).
- **Connected state:**
  - A bot badge showing the bot username + a chip `Token beállítva` / `Token set`.
  - Run notice: warns the bot only receives messages while the agent runs (`...Indítsd el az Áttekintés tab-on...`), or an OK notice when running.
  - **Linked chats list** section `Bekötött chat-ek és csoportok` / `Linked chats and groups` (see §4) + **Refresh** button `Lista frissítése` / `Refresh list`.
  - **Invite-link** section `Meghívó link (egy kattintásos hozzáadás)` / `Invite link (one-click add)` (Telegram only): a list of active invites + **New invite link** `Új meghívó link` / `New invite link` + **Refresh** `Frissítés` / `Refresh`.
  - **Pairing** section `Új ember vagy csoport hozzáadása` / `Add a new person or group`: a collapsible how-to (`Hogyan adj hozzá több embert vagy csoportot?` / `How to add more people or groups?`), a pending list, a **text field "Pairing code"** `Párosítási kód` / `Pairing code` (placeholder `pl. a1b2c3`) + **Approve** `Jóváhagyás` / `Approve`, and **Refresh pending** `Várakozók frissítése` / `Refresh pending`.
  - **(Slack-only) Channel-requests** section `Csatorna-kérések` / `Channel requests` with a count badge.
  - **Disconnected notice** + provider action buttons: **Test connection** `Kapcsolat tesztelése` / `Test connection`, **Channel-MCP reconnect** (conditional), **(Slack) smoke-test** (conditional), **Disconnect** `Leválasztás` / `Disconnect` (danger).

**Skills tab controls:**
- Header `Ügynök skilljei` / `Agent skills` + **New skill** button `Új skill` / `New skill` (`+` icon).
- Per-skill **Delete** icon button `Törlés` / `Delete` (only on the agent's own/local skills; inherited/global skills show a `globális`/`global` badge and no delete).

**Team tab controls:**
- **Dropdown "Role"** — `Szerep` / `Role`: `Beosztott (member)` / `Member` and `Csapatvezető (leader)` / `Leader`.
- **Dropdown "Reports to"** — `Kinek jelent` / `Reports to`: first option `(főügynök)` / `(orchestrator)`, then every other agent; note `Üresen hagyva automatikusan a főügynöknek.` / `If left empty, defaults to the orchestrator.`
- **Checkbox list "Can delegate to"** — `Kiknek delegálhat (csak leaderhez)` / `Can delegate to (leaders only)` (one checkbox per other agent; shown only when role = leader).
- **Toggle "Auto-delegation"** — `Autodelegálás: a vezető maga szétbontja és kiosztja a feladatot` / `Auto-delegation: the leader splits and assigns the task itself` + note that, unchecked, the leader only proposes and the operator approves (leaders only).
- **Checkbox list "Explicit trusted relationships (optional)"** — `Explicit megbízható kapcsolatok (opcionális)` / `Explicit trusted relationships (optional)` (one checkbox per other agent) + an explanatory note about cross-team trust.
- **Save** button `Mentés` / `Save`.

**Bottom of detail panel:**
- **Delete agent** button `Törlés` / `Delete` (danger). Hidden for the orchestrator.

### Skill editor modal
- Two tabs: `Létrehozás` / `Create` and `Importálás` / `Import`.
- Create tab: **Skill name** `Skill neve` / `Skill name` (placeholder `pl. piackutato, riport-keszito`); **free-form description** `Írd le szabadon, mit csináljon ez a skill` / `Describe freely what this skill should do` (placeholder gives an example); **Generate** button `Skill generálás` / `Generate skill` (inline `Generálás...`).
- Import tab: a drag/drop file area accepting a skill archive (`.skill`/`.zip`) — `Kattints vagy húzd ide a .skill fájlt` / `Click or drag the .skill file here`; **Import** button `Importálás` / `Import`.

### Terminal modal
- Title `<agent> — Terminal`. A live, full-color terminal viewport. The operator can type into it (keystrokes go to the live session). Close button.

---

## 4) LISTS / CARDS / TABLES

### Agent card (each roster card)
Shows:
- **Avatar** — operator-uploaded image if present, else a base-agent portrait if this is a known base agent, else a colored monogram disc (first letter of name). A subtle accent ring is applied (per-agent accent color; defer to 01-design.md).
- **Display name** — the original cased/accented name the operator typed.
- **Description** — one short line (auto-derived from the agent's instruction doc).
- **Footer row of three indicators:**
  - **Model badge** — the agent's active/configured model id (or `inherit`).
  - **Process indicator** — a dot + `Fut` / `Running` or `Leállva` / `Stopped`. Tooltip explains it reflects a live process/session check.
  - **Channel indicator** — a dot + `Online` / `Online` or `Offline` / `Offline`. Tooltip clarifies "online" means a channel token is configured (not a live socket).
- **(Conditional) Re-auth banner** — a reason line `Újrabejelentkezés szükséges` / `Re-login required` + a **Login** button (danger). Only when the running session shows an auth failure.
- **Per-card action:** a **Terminal** button.
- **Whole-card click** → opens the detail panel.

### Orchestrator card (hub agent, first)
Same shape, but:
- A badge next to the name: `fő asszisztens` / `main assistant`.
- A fixed model badge (its tier) and **fixed "Running"/"Online"** indicators (it always runs in the main channels session; no per-agent process check).
- Only a **Terminal** action; clicking the body opens its (mostly read-only) detail panel.

### Linked-chats list (Channel tab, connected)
Each row:
- A kind chip: `DM` for a direct user, or `CSOPORT` / `GROUP` for a group/channel.
- The chat/user id.
- A remove (`×`) button (danger), with a confirm before removal.
Empty state row: `Még nincs bekötött chat. Lent add hozzá az elsőt.` / `No linked chats yet. Add the first one below.`

### Invite-links list (Telegram only)
Each row: a status chip (`AKTÍV (Np)` / `ACTIVE (N min)` with minutes remaining, or `FELHASZNÁLT` / `USED`), the clickable deep-link (or `(bot username nélkül)` / `(no bot username)` if unresolved), a **Copy** button, and a revoke (`×`) button (confirm before revoke). Empty: `Nincs aktív meghívó link.` / `No active invite link.`

### Pending-pairings list
Each row: the pairing code, a "Sender: <id>" line, and an **Approve** button. Empty: `Nincs várakozó párosítás` / `No pending pairing`.

### Channel-requests list (Slack)
Each row: `#channel-name`, optional requesting user id, a timestamp, an **Approve** button (opens an approve sub-modal) and a **deny** (`×`) button.

### Skills list
Each row: skill name (+ `globális`/`global` badge if inherited), an optional one-line description, and a **Delete** icon (only for deletable/local skills). The Overview tab shows a **skill count**.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES (full contents)

### A) Creation Wizard modal
Title `Új ügynök létrehozása` / `Create a new agent`. Three panels (steps) as enumerated in §3. The wizard *creates the agent on "Next"* (it generates the identity docs server-side, then lets the operator review/edit before finalizing on "Create"). On success it closes, refreshes the roster, opens the new agent's detail panel, and lands the operator on the **Channel** tab so the pairing step is in front of them.

### B) Agent Detail modal
Five tabs as in §3.

**Overview tab contents:** big avatar (+ edit pencil → avatar drawer), display name, description, and a small **metadata grid** of label/value pairs:
- `Modell` / `Model` — active model id; a `újraindítás alatt` / `restarting` chip appears during a model-change restart.
- `Csatorna` / `Channel` — a connected/not-connected status (`Csatlakozva` / `Connected` vs `Nincs bekötve` / `Not linked`).
- `Skillek` / `Skills` — the skill count.
- `Kontextus` / `Context` — the live context size, formatted e.g. `≈700k token` (or `-` when not running / unknown).
- Below the grid: the **process control row** (status dot + `Fut`/`Leállva`, optional session hint, Start/Stop/[Channels restart]).

**Avatar drawer** (toggled by the pencil): header `Válassz új avatart` / `Choose a new avatar`; the preset gallery grid; a `vagy`/`or` divider; the upload drop-zone (≤ 1 MB, png/jpg/webp). Picking a preset or uploading a file updates the avatar immediately and (per current behavior) also sends the new image to the agent's chat channel — surface a toast like `Avatar feltöltve, kép elküldve Telegramon` / `Avatar uploaded, image sent over Telegram`.

**Settings tab contents:** as fully enumerated in §3 (model + auto-restart + auth-mode + security-profile + CLAUDE.md + SOUL.md + .mcp.json, each with its own Save).
- **Orchestrator special case:** when the orchestrator's detail is opened, the Settings tab is **read-only**: a notice block `Főagent konfiguráció -- csak olvasható` / `Main-agent config — read-only` explains the identity files can't be edited from the dashboard (token-leak risk) and must be edited on disk or via chat. The three text areas become read-only; their Save buttons hide; the model select + its Save are visible but disabled; the auth-mode block hides.

**Channel tab contents:** as enumerated in §3 (provider picker → not-connected setup OR connected management with linked-chats / invites / pairing / requests / actions).

**Skills tab contents:** header + New-skill button + the skills list (local + inherited) + an empty state `Nincsenek skillek hozzáadva` / `No skills added`.

**Team tab contents:** role, reports-to, delegates-to (leaders), auto-delegation (leaders), trust-from, + Save. The orchestrator does not expose an editable team form (it is the root of the graph).

**Bottom:** Delete button (hidden for orchestrator).

### C) Skill editor modal — see §3.

### D) Terminal modal
A live terminal viewport that mirrors the agent's running session and accepts keystrokes (typed characters and a set of control/navigation keys: Enter, Esc, arrows, Backspace, Tab, Shift-Tab, Ctrl-C/D/U/L, PageUp/PageDown). The viewport repaints a full snapshot of the session on each refresh tick. Closing the modal tears down the live stream.

### E) Approve-channel sub-modal (Slack)
For approving a Slack channel request: a description line naming the channel (and requester), a checkbox "require mention" (default on), a checkbox "allow from all" (default off), Confirm/Cancel.

### F) Privileged-setup sub-modal (managed-settings)
If connecting a channel fails because a host-level managed setting is missing, show a modal presenting a one-line shell command the operator must run with elevated privileges to enable channel plugins. (Surface the command read-only with a copy affordance.)

---

## 6) FLOWS & BEHAVIOR (step by step; API described as contract, not code)

> Throughout: every write is authenticated by the dashboard token; destructive actions confirm first; results surface as transient toasts. "Refresh roster" = re-fetch the agent list + orchestrator summary and re-render cards.

**Load the view.** On navigating to the page, fetch (a) the agent roster list and (b) the orchestrator summary, then render cards. The roster auto-syncs the active channel provider default from the backend so the Channel tab opens on the right provider.

**Create an agent (wizard).**
1. Step 1 → "Next": POST a create request `{ name, description, model, profile }`. The backend **sanitizes** the name (lowercase ASCII, accents stripped); the response returns the canonical name — use it for all follow-ups. The backend scaffolds the agent and generates the identity docs.
2. Fetch the new agent's detail to retrieve generated `CLAUDE.md` / `SOUL.md`, show them in step 3.
3. If an avatar was chosen, apply it (upload file as multipart, or send the chosen preset name as JSON) to the agent's avatar endpoint.
4. Step 3 → "Create": PUT the (possibly edited) `{ claudeMd, soulMd }`. On success: close, toast `Ügynök létrehozva. Kösd be a csatornát a párosításhoz.` / `Agent created. Connect the channel to pair.`, refresh roster, open detail on the Channel tab.
- **Create errors:** name required (400), description required (400), name already exists (409), generation failure (500 with a detail message) — surface the backend message in a toast. **Spawn gating:** a programmatic (agent-initiated) create may return "pending approval" or "forbidden" (see §8); the dashboard-operator create path proceeds directly.

**Start / Stop / Restart.**
- Start: POST start; on success toast `Ügynök elindítva!` / `Agent started!`, re-fetch detail, update process control, refresh roster. Records operator intent so a supervisor keeps it up across restarts.
- Stop: **confirm** `Biztosan leállítod az ügynököt?` / `Really stop the agent?` → POST stop; toast `Ügynök leállítva` / `Agent stopped`; clears the keep-up intent.
- Model change (Settings → Model → Save): PUT `{ model }`, then POST restart. While restarting, show the "restarting" chip + a "restarting" process state, then **poll** the agent until its session's start-time advances past the trigger time (≈60s budget, ~2s interval). On completion: toast the new active model; if the poll times out, toast that the restart state couldn't be read back and to check the session.
- Orchestrator "Channels restart": **confirm** (warns the in-progress conversation is lost but memory persists) → POST a dedicated channels-restart; toast on success.

**Auth-mode apply.**
- Shared → "Apply": PUT `{ authMode: 'shared' }`; if running, stop, wait ~2s, start; toast `Agent újraindítva host OAuth-tal` / `Agent restarted with host OAuth`; refresh.
- Own-team → "Log in": POST an auth-init that drives `/login` inside the agent's live session and scrapes back the auth URL (waits up to ~12s). Show the URL (with Copy). If no URL appears, show an error.
- API key → Save: PUT `{ authMode:'api', apiKey }`; the key is stored as a secret; switching away from API mode deletes that secret. Toast `Hitelesítési mód mentve (újraindítás szükséges)` / `Auth mode saved (restart required)`.

**Security profile save.** PUT `{ profile }`; response indicates whether a restart is required; toast accordingly; refresh roster.

**Auto-restart save.** PUT the config `{ enabled, mode, dailyTime|intervalHours }` (the backend normalizes/coerces a partial payload). Toast saved.

**Identity-doc saves.** Save CLAUDE.md / SOUL.md / .mcp.json each PUT only that field; toast per-file.

**Team save.** PUT `{ role, reportsTo|null, delegatesTo[], autoDelegation, trustFrom[] }` (delegatesTo + autoDelegation forced empty/false when role≠leader). The backend sanitizes (drops self-references and unknown agent ids) and returns warnings; if any, append them to the toast (e.g. `Csapat mentve (kivett: ismeretlen nevek: x)` / `Team saved (dropped: unknown names: x)`).

**Avatar.** Upload file (multipart) or pick a preset (JSON name). Updates the displayed avatar immediately, refreshes the roster. Validation: type png/jpg/jpeg/webp, ≤ 1 MB (toasts `Csak png/jpg/webp formátum` / `Only png/jpg/webp` and `Max 1 MB méretű kép` / `Max 1 MB image`).

**Channel connect.** POST `{ botToken, [channelId|appToken] }` to the provider endpoint. Discord requires a numeric channel id (validated). The backend validates the token, rejects a token already used by another agent (409 with the owner's name), writes channel state, enables the right plugin, and (if the agent was running) restarts it. On a managed-settings 409, open the privileged-setup sub-modal. On success, toast and reopen detail.

**Channel test / reconnect / disconnect / smoke-test.** Test → POST test (`Kapcsolat rendben!` / `Connection OK!`). Reconnect → POST reconnect. Disconnect → **confirm** then DELETE the provider config; reopen detail. Smoke-test (Slack) → POST, show output in a sub-modal.

**Pairing & allowlist.** Approve a code → POST approve `{ code }` (moves the sender into the allowlist, flips DM policy to allowlist); refresh pending + linked lists. Remove a linked user/group → **confirm** then DELETE; refresh. Generate invite (Telegram) → POST, copies the deep-link to clipboard; revoke → **confirm** then DELETE token.

**Skills.** Create → POST `{ name, description }` (server generates the skill doc; rejects duplicate name 409); reload list. Import → POST a multipart archive (server validates: no path traversal, no symlinks, must contain a skill doc). Delete → **confirm** `Skill törlése: <name>?` / `Delete skill: <name>?` then DELETE; reload. Inherited/global skills are not deletable from a single agent's view.

**Per-card login (re-auth).** Two-phase: first click POSTs `{ phase:'start' }` (drives `/login` in the session), button flips to `Auth kész → Megerősít` / `Auth done → Confirm`; second click POSTs `{ phase:'confirm' }`, button shows `Bejelentkezve` / `Logged in`, then refreshes the roster.

**Terminal.** Opening subscribes to a live pane stream (server pushes full-snapshot frames on a short interval). Typing POSTs keystrokes (plain text or an allow-listed special key) to the live session; rejects when the agent isn't running. Closing stops the stream.

**Delete agent.** **Confirm** `Biztosan törlöd: <name>?` / `Really delete: <name>?` → DELETE; on success close detail, toast `Ügynök törölve` / `Agent deleted`, refresh roster. The backend also cleans up references to this agent in other agents' team configs. The orchestrator cannot be deleted (button hidden).

---

## 7) STATES

- **Empty roster:** only the orchestrator card (if present) and the "New agent" tile. No dedicated empty illustration is required beyond the add tile.
- **Loading:** roster fetch failures are logged and leave the grid as-is (no crash). The wizard's step 2 is a spinner with a phase status line. Save buttons show inline spinners / busy text.
- **Error:** every failed action surfaces a toast with the backend's message where available (token invalid, duplicate token, generation failed, etc.). Channel/managed-settings failures escalate to the privileged-setup sub-modal.
- **Permission-denied / forbidden:** an agent-initiated create can be rejected (forbidden) or deferred (pending operator approval) — see §8.
- **Live-update / polling:**
  - Card status (running/connected/re-auth/context) reflects the last roster fetch; re-fetch after any lifecycle action.
  - Channel tab, while open, **auto-polls** (~every 4s) the pending pairings, linked list, invites, and channel requests.
  - Model-change restart **polls** the agent (~2s, up to ~60s) until restart completes.
  - Channel health is checked when connected+running, surfacing a "disconnected" notice + reconnect button.
  - The Terminal streams the live session continuously while open.

---

## 8) PERMISSIONS / VISIBILITY

- **Operator-only surface.** The entire view is gated behind the dashboard auth token; the terminal stream passes the token via query string (since the streaming transport can't set headers).
- **Orchestrator (hub) is privileged & protected.** Its detail panel is read-only for identity files; it cannot be deleted; it has a unique "Channels restart" action; its process/channel indicators are fixed-on. It is the only agent allowed to spawn other agents programmatically.
- **No self-escalation.** When a non-orchestrator agent programmatically requests creating another agent, a **spawn-privilege gate** runs: the request can be allowed, **deferred to operator approval** (a pending spawn-request the operator approves/denies, with an alert sent), or **forbidden** — and a requested security profile can never exceed the requester's own ceiling. Operator-driven creation from this view is not gated this way.
- **Autonomy gating (team).** Leaders with auto-delegation split and assign work themselves; without it, they only propose and the operator approves. Surface these as the toggles in the Team tab; the actual gating is enforced server-side.
- **Internal/hidden agents.** Some technical/project agents are flagged internal and are intentionally **not** shown in this roster (and skip channel routing). Render only visible agents.

---

## 9) DATA CONCEPTS (read/written, concept-level)

- **Agent summary (per card):** name (sanitized id) + display name; short description; configured model + active model; running flag + session/uptime hint; channel-connected flags per provider + bot username; security-profile id; team config; auth mode; has-avatar flag; accent color; auto-restart config; live context-token count; re-auth-needed flag + reason; status (configured vs draft).
- **Agent detail:** the summary plus the full `CLAUDE.md`, `SOUL.md`, `.mcp.json` text, the skills list, has-API-key flag.
- **Profiles:** id, label, description, permission-mode (strict/permissive), allow/deny counts.
- **Models:** Claude list (id+label), DeepSeek list (gated behind a configured key), local (Ollama) models (name+size).
- **Team config:** role (member/leader), reportsTo, delegatesTo[], autoDelegation, trustFrom[]; plus a global team graph (nodes + reports-to edges) used by the separate Team page.
- **Channel state:** provider, bot token (stored as a secret/env), optional default channel id, an access record (DM policy, allow-from list, groups, pending pairings, invites).
- **Skills:** per-agent local skills (own folder, deletable) + inherited global skills (shared, badged, not per-agent deletable); each has a name, a description (from its doc's frontmatter), and a has-doc flag.
- **Auto-restart store, desired-state (keep-up intent), spawn-requests, task-state** (a compact re-injection record written by session hooks: done-steps, already-delegated, next-action, pending-decision, summary — read/consumed on session start). These are backend concepts the operator doesn't directly edit here, but they back the lifecycle behavior.

---

## 10) i18n

Every user-facing string ships in **Hungarian (default)** and **English**. HU is authoritative; treat the EN strings above as the translation set. Notes:
- Toasts, confirms, tab labels, button labels, placeholders, section headers, helper notes, status words (Fut/Leállva, Online/Offline, Csatlakozva/Nincs bekötve), profile-strict suffix, and warning fragments must all be localized.
- Number/locale formatting (e.g. context-token shorthand `≈700k token`, relative times) should respect the active locale.
- Some technical tokens stay verbatim across locales (`CLAUDE.md`, `SOUL.md`, `.mcp.json`, `tmux`, model ids, `Channel-MCP reconnect`, `Channels restart`).

---

**Reminder:** Implement all visual styling per **01-design.md**. This document defines *what the operator sees and can do*, not how it is coded or colored.
