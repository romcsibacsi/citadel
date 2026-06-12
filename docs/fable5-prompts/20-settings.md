# Build Prompt — Settings / "Beállítások" surface

> CLEAN-ROOM NOTICE (read first): This is an original behavioral + visual specification written for an engineer ("Fable 5") who has never seen the reference product. Implement it from scratch in whatever stack you choose. Nothing here is transcribed from source code — it describes *what the screen looks like, what the controls are, and what happens when they are used*. Do not attempt to recover original code, identifiers, file names, routes, or database schema; design your own. For all visual/look-and-feel decisions (colors, spacing, typography, glow, density tokens) defer to `01-design.md` — this document specifies structure and behavior only.

---

## 0. ORIENTATION — important architectural note for the implementer

Unlike most apps, this product **does not have a single dedicated "Settings page."** The configuration surface is **deliberately split across three distinct places**, and you must build all three:

1. **Appearance panel ("Megjelenés" / Appearance)** — a small slide-in dialog opened by a **gear button in the left sidebar footer**. This is the closest thing to a classic "Settings" entry point. It controls only client-side look-and-feel (theme, density, glow, accent) and persists to the browser only.
2. **System Integrations card ("Rendszer-integrációk" / System Integrations)** — a card that lives **on the Vault page** (the secrets/credentials page), not on its own page. It manages server-side integration keys (update source, image-generation backend, etc.).
3. **Per-entity configuration**, opened from each agent's **detail dialog**, which has two relevant tabs: **"Beállítások" / Settings** (model, restart policy, auth, security profile, identity docs) and **"Csatorna" / Channel** (binding a chat bot — Telegram/Discord/Slack — operator pre-allow, pairing, access).

There is **no separate "Channels" nav item.** Channel/bot binding lives entirely inside each agent's detail dialog on the Channel tab. There is **no in-app control to change the product name or the default locale** — those are fixed at install time (see §9). Build exactly these surfaces; do not invent a unified settings page.

The sections below spec each surface in full.

---

## 1. PURPOSE & WHERE IT LIVES

### 1a. Appearance panel ("Megjelenés" / "Appearance")
- **Purpose:** Let any viewer customize the dashboard's visual look instantly, with no server round-trip. Personal, per-browser, non-destructive.
- **Where:** A **gear / cog icon button** sits in the **left sidebar footer**, next to a separate light/dark **theme-cycle toggle button** (a sun/moon icon that cycles themes on click). Clicking the gear opens a right-side **slide-in panel** (a non-modal dialog) over a dimming backdrop.
- **Icon idea:** a settings gear (cog with center hub). The neighbor toggle uses a sun/moon glyph.
- **Subtitle / tooltip:** HU `Megjelenés (Tweaks)` · EN `Appearance (Tweaks)`. Panel header title: HU `Megjelenés` · EN `Appearance`.

### 1b. System Integrations card ("Rendszer-integrációk" / "System Integrations")
- **Purpose:** Operator-facing form to set server-side integration values (a self-hosted update source + token, and an image-generation backend address/options). Secrets are stored encrypted; non-secrets in plain config. Saving takes effect live (no restart).
- **Where:** A bordered card rendered near the bottom of the **Vault page** (the encrypted-secrets page), below the vault stats. It is not in the sidebar nav.
- **Icon idea:** a plug / connector or a sliders glyph in the card header.
- **Card subtitle:** HU `Webről megadott kulcsok — a titkok titkosítva tárolódnak, és azonnal alkalmazódnak (újraindítás nélkül).` · EN `Keys entered from the web — secrets are stored encrypted and applied immediately (no restart).`

### 1c. Per-agent Settings & Channel tabs
- **Purpose:** Configure a single agent: which model it runs, automatic-restart policy, how it authenticates, its security/permission profile, its identity documents, and which messaging channel/bot it is bound to.
- **Where:** Inside the **Agent Detail dialog** (opened by clicking an agent card on the Agents page). The dialog has a tab bar: Overview / Settings / Channel / Skills / Team. This spec covers **Settings** (HU `Beállítások`) and **Channel** (HU `Csatorna`).
- **Subtitle concept:** Settings tab = "an agent's brain and identity"; Channel tab = "who can talk to this agent."

---

## 2. PAGE LAYOUT & APPEARANCE (structure only; styling → 01-design.md)

### 2a. Appearance panel
- Right-anchored vertical panel, ~320–360px wide, full height, sliding in from the right edge. A semi-transparent backdrop covers the rest of the app and closes the panel on click.
- **Header row:** bold title `Megjelenés`/`Appearance` on the left, a close "✕" button on the right.
- **Body:** a vertical stack of labeled control groups, each: a small section heading, then the control row. Order: Theme → Density → Glow → Accent color.

### 2b. System Integrations card
- One card with: header (title + subtitle), a dynamically rendered list of field rows, an action row (Save + "Check now" + inline status text), and a small live status strip for the image-generation backend.
- Each field row: a label (with an inline "set / not set" pill), an input, and a one-line description underneath.

### 2c. Agent Detail → Settings tab
- A single scrollable column of stacked "form group" blocks, each with its own label and its own **Save** button (settings are saved section-by-section, not by one global save). Order seen top to bottom: (optional read-only banner for the main agent) → Model → Automatic restart → Authentication mode → Security profile → CLAUDE-style identity doc → SOUL-style persona doc → MCP config doc.

### 2d. Agent Detail → Channel tab
- Top: a **provider dropdown**. Then the view is one of two states stacked (only one visible):
  - **Not-connected state:** setup instructions + token field(s) + Connect button.
  - **Connected state:** status badge, run-state notices, bound-chats list, invite-links section, add-person/pairing section, (provider-specific) channel-requests section, and a footer action row (Test / Reconnect / Smoke-test / Disconnect).

---

## 3. CONTROLS — every button/field/dropdown/toggle, with HU + EN labels

### 3a. Appearance panel controls
| Control | Type | HU label | EN label | Behavior |
|---|---|---|---|---|
| Theme | dropdown | `Téma` | `Theme` | Selects one of three named visual themes (ship at least: a dark "command/obsidian" default, a bright "HUD" theme, an "arcane/forge" theme). Applies live; persists per-browser. |
| Density | segmented 2-button | `Sűrűség` | `Density` | Two options: `Kényelmes`/`Comfortable` (default) and `Kompakt`/`Compact`. Toggles overall spacing density live; the active button is highlighted. |
| Glow | range slider (0 → 1.5, step 0.1) | `Ragyogás` | `Glow` | Adjusts a global glow/bloom intensity. A numeric readout next to the slider shows the current value. Default ≈ 0.6. Empty/cleared falls back to the theme's own glow. |
| Accent color | row of color swatch buttons | `Kiemelő szín` | `Accent color` | First swatch = "theme default" (clears any override). The rest are fixed accent presets (cyan, amber, violet, green, blue, gold, etc.). Clicking one overrides the global accent live; the active swatch is highlighted. |
| Close | "✕" button | `Bezárás` | `Close` | Closes the panel. |

- The neighbor **theme-cycle toggle** (sun/moon icon, sidebar footer) cycles through the theme list on each click — same effect as the dropdown but as a quick toggle. Tooltip HU `Témaváltás` · EN `Switch theme`.

### 3b. System Integrations card controls
The field list is **schema-driven** (render whatever the backend reports). Ship these fields:

| Field | Type | HU label | EN label | Placeholder | Secret? |
|---|---|---|---|---|---|
| Update source repo | text | `Frissítés-forrás (repó)` | `Update source (repo)` | `owner/repo` | no |
| Update source token | password | `Frissítés-token (privát repóhoz)` | `Update token (private repo)` | `••• token •••` | yes |
| Image-gen backend URL | text | `Kép-generáló backend URL` | `Image-gen backend URL` | `http://host:port` | no |
| Image-gen default model | text | `Kép-generáló alapmodell (opcionális)` | `Image-gen default model (optional)` | `model-file-name` | no |
| Image-gen wake target | text | `Kép-generáló auto-ébresztés (SSH cél)` | `Image-gen auto-wake (SSH target)` | `user@host` | no |

| Action | HU label | EN label | Behavior |
|---|---|---|---|
| Save | `Mentés` | `Save` | Persists all changed fields (see §6). |
| Check now | `Frissítés-ellenőrzés most` | `Check for updates now` | Runs an immediate update check against the configured update source; result shown in the inline status text. |
| Status text | — | — | Inline message: `Mentve (N mező).` / `Saved (N fields).`, `Nincs változás.` / `No changes.`, or an error. |
| Image-gen status strip | — | — | A colored dot + text showing whether the image-gen backend is reachable; an optional `Ébresztés`/`Wake` button appears when a wake target is configured and the backend is asleep. |

**Per-field "set / not set" pill:** HU `beállítva` / `nincs beállítva` · EN `set` / `not set`. For secrets, when set, show a masked hint (e.g. last 4 chars only) — never the full value. For non-secrets, the current value may be shown.

### 3c. Agent Detail → Settings tab controls
| Control | Type | HU label | EN label | Behavior |
|---|---|---|---|---|
| Model | grouped dropdown | `Modell` | `Model` | Choose the LLM the agent runs. Groups: cloud models (the primary provider's lineup, with one marked as default and one as "fastest"), an optional alternative-cloud-provider group (only if its key is configured — otherwise hidden with a hint linking to the Vault page to add a key), and a local-models group (populated from the local runtime if present). + per-section **Mentés**/**Save**. |
| Automatic restart — enabled | checkbox | `Bekapcsolva` | `Enabled` | Master on/off for periodic auto-restart. |
| — Mode | dropdown | `Mód` | `Mode` | `Folytatás`/`Continue` (keep context, refresh tier/limits) or `Friss`/`Fresh` (drop context — the faster option). |
| — Schedule kind | dropdown | `Ütemezés` | `Schedule` | `Napi időpont`/`Daily time` or `Óránként`/`Every N hours`. |
| — Daily time | time input | `Időpont` | `Time` | Shown only for daily; default e.g. 03:00. |
| — Interval hours | number (1–168) | `Óránként` | `Every (hours)` | Shown only for interval; default e.g. 12. |
| Save (auto-restart) | button | `Mentés` | `Save` | Persists the restart policy. |
| Authentication mode | 3 selectable cards (radio) | `Hitelesítési mód` | `Authentication mode` | Pick how the agent authenticates: **Shared / `Megosztott`** (uses the host's login — default), **Own team login / `Saját Team login`** (separate provider login via an in-session login flow), **API key / `API kulcs`** (uses a stored key). Selecting a card reveals its sub-panel (see §5). + **Mentés**/**Save**. |
| Security profile | dropdown + description | `Biztonsági profil` | `Security profile` | Choose a permission/autonomy profile; the chosen profile's description shows below. Saving may flag "restart required." + **Mentés**/**Save**. |
| Identity doc (operating doc) | large code textarea | `Operatív dokumentum` (CLAUDE-style) | `Operating doc` | Editable instructions document for the agent. + **Mentés**/**Save**. |
| Persona doc | large code textarea | `Személyiség` (SOUL-style) | `Persona` | Editable personality document. + **Mentés**/**Save**. |
| Tool/MCP config | code textarea | `MCP konfiguráció` | `MCP config` | Editable tool-server config (JSON). + **Mentés**/**Save**. |

> **Main/orchestrator agent exception:** when the detail dialog is for the main orchestrator agent, the three identity textareas (operating doc / persona / tool config) and the model save are **read-only**, and a banner explains why (see §5e and §8).

### 3d. Agent Detail → Channel tab controls
| Control | Type | HU label | EN label | Behavior |
|---|---|---|---|---|
| Provider | dropdown | `Csatorna provider` | `Channel provider` | At least `Telegram` and `Discord` (optionally `Slack`). Switching re-renders the whole tab for that provider. |
| Bot token | text | `Bot API Token` (Telegram) / `Bot Token` (Discord/Slack) | same | Paste the bot credential. Placeholder is provider-shaped. |
| App-level token (Slack only) | text | `App-Level Token` | `App-Level Token` | Second Slack credential; shown only for Slack. |
| Channel/server channel id (Discord only) | text | `Discord Channel ID` | `Discord Channel ID` | The default server channel the bot posts to; Discord only. |
| Create Slack app (manifest) | button (Slack only) | `Slack App létrehozása (manifest)` | `Create Slack App (manifest)` | Helper to bootstrap a Slack app via manifest. |
| Connect | primary button | `Összekapcsolás` | `Connect` | Binds the token (see §6). Shows a spinner + `Csatlakozás...`/`Connecting...`. |
| Refresh bound list | button | `Lista frissítése` | `Refresh list` | Re-pulls the bound chats list. |
| New invite link | button | `Új meghívó link` | `New invite link` | Mints a one-time deep-link invite (Telegram only). |
| Refresh invites | button | `Frissítés` | `Refresh` | Re-pulls invite links. |
| Pairing code | text | `Párosítási kód` | `Pairing code` | Enter a 6-char code someone got from the bot. Placeholder `pl. a1b2c3`/`e.g. a1b2c3`. |
| Approve (pairing) | button | `Jóváhagyás` | `Approve` | Approves the entered/pending code. |
| Refresh pending | button | `Várakozók frissítése` | `Refresh pending` | Re-pulls pending pairings. |
| Test connection | button | `Kapcsolat tesztelése` | `Test connection` | Pings the bot API; toast OK/fail. |
| Reconnect | button (when degraded) | `Channel-MCP reconnect` | `Reconnect channel` | Forces a channel reconnect. |
| Smoke-test (Slack only) | button | `Slack csatorna smoke-test` | `Slack channel smoke-test` | Runs a Slack smoke test; result shown in a modal. |
| Disconnect | danger button | `Leválasztás` | `Disconnect` | Removes the binding (confirmation required). |

---

## 4. LISTS / CARDS / TABLES — items + fields + per-item actions

### 4a. System Integrations field list
Each row shows: label + set/not-set pill, the input (masked placeholder for already-set secrets, e.g. `(változatlanul hagyhatod)` / `(leave blank to keep)`), and a description line. No per-row actions beyond editing the input; the card-level Save persists all.

### 4b. Channel — "Bound chats & groups" list (`Bekötött chat-ek és csoportok` / `Bound chats & groups`)
- Section intro text: HU `Az ügynök ide tud üzenetet küldeni és innen fogad üzenetet. Egy ügynök tetszőleges számú emberhez (DM) és csoporthoz köthető.` · EN `The agent can send to and receive from these. An agent can bind to any number of people (DMs) and groups.`
- Each item shows: a **kind tag** — `DM` for a direct chat or `CSOPORT`/`GROUP` for a group — and the **chat id**. Per-item action: a **remove "✕"** button (tooltip `Eltávolítás`/`Remove`) → asks confirmation, then unbinds.
- Empty state text: HU `Még nincs bekötött chat. Lent add hozzá az elsőt.` · EN `No bound chats yet. Add the first one below.`

### 4c. Channel — "Invite links" list (Telegram only) (`Meghívó link` / `Invite link`)
- Section intro: HU `Generálj egy egyedi linket. Aki rákattint, automatikusan elindítja a botot, és a UI-n azonnal jóváhagyhatod. Egy link csak egyszer használható.` · EN `Generate a unique link. Whoever clicks it auto-starts the bot, and you can approve them in the UI immediately. Each link is single-use.`
- Each item shows: a **status tag** — `AKTÍV (Np)`/`ACTIVE (N min)` with minutes-to-expiry, or `FELHASZNÁLT`/`USED` — and the **deep-link URL** (clickable). Per-item actions: **Copy** (`Másol`/`Copy`, only while active+unused) and **Revoke "✕"** (`Visszavonás`/`Revoke`, with confirmation).
- Empty state: HU `Nincs aktív meghívó link.` · EN `No active invite links.`

### 4d. Channel — "Pending pairings" list (`Várakozó párosítások` / `Pending pairings`)
- Each item shows: the **pairing code**, the **sender id**, and (where available) a created-at timestamp. Per-item action: **Approve** (`Jóváhagyás`/`Approve`).
- Empty state: HU `Nincs várakozó párosítás` · EN `No pending pairings`.

### 4e. Channel — "Channel requests" list (Slack only) (`Csatorna-kérések` / `Channel requests`)
- Header has a **count badge**. Section intro: HU `Csatornák, amelyekben megemlítették a botot, de még nincsenek engedélyezve.` · EN `Channels where the bot was mentioned but is not yet allowed.`
- Each item shows: the **channel name** (prefixed `#`), the **requesting user id** (if any), and a **timestamp**. Per-item actions: **Approve** (`Jóváhagyás`/`Approve` → opens the approve modal, §5d) and **Deny "✕"** (`Elutasítás`/`Deny`, removes immediately).

---

## 5. OPENED CARDS / MODALS / DETAIL PANES — full contents

### 5a. Appearance slide-in panel
Already fully described in §2a/§3a. It is a non-modal dialog: opening it does not block the rest of the app; clicking the backdrop or ✕ closes it. State is reflected into the controls each time it opens (so the visible values always match what is currently applied).

### 5b. Channel "Not connected" setup block
Contents in order:
- **Setup instructions** — a titled ordered list, provider-specific:
  - Telegram title `Telegram bot bekötése`/`Connect a Telegram bot`; steps: open the bot-creation helper in Telegram → create a new bot → paste the API token here.
  - Discord title `Discord bot bekötése`/`Connect a Discord bot`; steps: go to the developer portal → create an application + bot → paste the bot token → paste the target server-channel id below.
  - Slack title `Slack app bekötése`/`Connect a Slack app`; steps: create a Slack app (or use the manifest button) → paste both tokens.
- **Token field** (label/placeholder provider-shaped), plus the Slack app-token field / Discord channel-id field as applicable, plus the Slack manifest helper button.
- **Connect** primary button.

### 5c. Channel "Connected" block
Contents in order:
- **Bot badge:** a connected dot + the bot's @username + a pill `Token beállítva`/`Token set`.
- **Run-state notice (two variants, one shown):**
  - Agent not running: HU `A bot csak akkor fogad üzeneteket, ha az ügynök fut. Indítsd el az Áttekintés tabon az "Indítás" gombbal.` · EN `The bot only receives messages while the agent is running. Start it on the Overview tab.`
  - Agent running: HU `Az ügynök fut, a bot aktívan figyel. A chat ID-d előre engedélyezve van, nem kell pairing kód.` · EN `The agent is running and the bot is actively listening. Your operator chat id is pre-allowed — no pairing code needed.`
- **Bound chats & groups list** (§4b) + refresh button.
- **Invite links section** (§4c, Telegram only) + generate/refresh buttons.
- **Add-person / pairing section:** a collapsible "how to add more people or groups?" help block (provider-specific multi-step instructions for adding a DM person and adding a group/server channel), an info line about codes, the **pending pairings list** (§4d), a **pairing-code field + Approve** row, and a refresh-pending button.
- **Channel requests section** (§4e, Slack only).
- **Degraded notice (conditional):** HU `Csatorna leszakadt. Automatikus újracsatlakozás folyamatban, vagy használd a gombot lent.` · EN `Channel dropped. Auto-reconnect in progress, or use the button below.`
- **Footer action row:** Test / Reconnect (conditional) / Smoke-test (Slack) / Disconnect.

### 5d. "Approve channel request" modal (Slack)
- Title: HU `Csatorna engedélyezése` · EN `Allow channel`.
- A description line naming the channel (and requesting user if present).
- **Toggle 1 — "Only respond when @-mentioned"** (default ON): HU `Csak @-tageléskor figyeljen` / sub `Az ügynök csak @-tagelt üzenetekre reagál` · EN `Only when @-mentioned` / `The agent reacts only to @-mentions`.
- **Toggle 2 — "Accept from anyone"** (default OFF): HU `Bárkitől fogadjon` / sub `Ha ki van kapcsolva, csak a kérést indító felhasználótól fogad` · EN `Accept from anyone` / `If off, only from the user who triggered the request`.
- Footer: `Mégse`/`Cancel` + `Jóváhagyás`/`Approve` (with spinner). Closes on ✕, Cancel, backdrop click, or Esc.

### 5e. Main-agent read-only banner (Settings tab)
- Shown only for the orchestrator agent. Title: HU `Főagent konfiguráció — csak olvasható` · EN `Main-agent config — read-only`. Body explains the identity docs can't be edited from the dashboard for security (a leaked dashboard token must not allow remote identity rewrite of the live agent), and that edits should be done from the file system or by asking the agent directly via its channel.

### 5f. Auth-mode sub-panels (revealed under the auth cards)
- **Shared:** a row "Apply host login" / `Host OAuth alkalmazása` with an **Apply**/`Alkalmazás` button that restarts the agent on the host login; inline error area.
- **Own team login:** a row "Start login flow" / `Auth-flow indítása` with a **Login**/`Bejelentkezés` button that kicks a login in the agent's session and returns an **auth URL** (rendered as an open-in-new-tab link + a **Copy**/`Másolás` button); inline error area.
- **API key:** a password field (`API kulcs`/`API key`) + a status line saying whether a key is configured. Save via the section Save button.

### 5g. Sudo / pre-flight modal (Slack binding only)
- If a Slack connect attempt is blocked because a system-level plugin allowlist file is missing, a modal appears explaining the requirement, shows the exact shell command to run (in a copyable code block with a **Copy** button), and a close button. Telegram/Discord do not hit this.

### 5h. Smoke-test result modal (Slack only)
- A modal showing the smoke-test output in a monospace, scrollable block, with a **Bezárás**/`Close` button.

---

## 6. FLOWS & BEHAVIOR (behavior/contract, not code)

> Design your own API; the contract below is what each action must achieve.

### Appearance
1. On load, read saved theme/density/glow/accent from browser storage and apply them before first paint (default theme = the dark "command" theme; no OS-preference fallback).
2. Each control applies its change **live** (set a root attribute / CSS variable) and **persists to browser storage** immediately. No server call. No confirmation.
3. Selecting "theme default" accent or clearing glow removes the override and reverts to the theme's own value.

### System Integrations
1. **Load:** GET the schema + redacted current state; render fields. Never return secret values to the client — only a masked hint + a set/not-set flag.
2. **Save:** for each field, POST `{key, value}`. **A secret left blank means "keep existing" (skip it); a non-secret left blank means "clear it."** Secrets are stored encrypted (and mirrored to wherever the runtime reads them); non-secrets stored in plain config. **Saving applies live — no restart.** Show a count of saved fields, clear the inputs, and reload the redacted state.
3. **Check now:** POST a one-shot update check; report "up to date" vs "N new commits on <repo>@<branch>" or an error inline.
4. **Image-gen status strip:** poll the backend reachability while the page is open (e.g. every ~20s); show configured/unreachable/asleep; offer Wake when a wake target is set.

### Agent Settings
- **Model:** PUT the new model → optimistically show "restarting" → POST a restart → poll the agent record (e.g. every ~2s up to ~60s) for a fresh session timestamp newer than the trigger; on success show the active model and clear the "restarting" badge; on timeout warn that the restart state couldn't be read back. (Model save is disabled/hidden for the main agent.)
- **Auto-restart:** PUT the policy `{enabled, mode, dailyTime|null, intervalHours|null}`. Applies to sub-agents and the main session alike. Toast on success. Note in helper text that it never interrupts active work — it only restarts when idle, otherwise defers.
- **Auth mode:** Save PUTs `{authMode}`. Shared = restart agent with host login. Own-team = init a login flow and surface the auth URL. API = store the key. Toast on success; restart where required.
- **Security profile:** PUT `{profile}`; toast, possibly "restart required."
- **Identity / persona / tool docs:** each Save PUTs that document's text. (All three + model are read-only for the main agent — server also refuses writes defensively.)

### Channel binding
1. **Connect:** validate the token against the provider's API; on success persist the binding under this agent and **pre-allow the operator's own chat id** (so the operator never needs a pairing code), refresh the detail, and (for new agents on Telegram) optionally send a welcome message from the bot. On a Slack pre-flight failure, open the sudo modal (§5g) instead. Toast success/fail.
2. **Test:** ping the bot API; toast OK/fail.
3. **Pairing approve:** when a stranger messages the bot, the bot replies with a 6-char code; the operator enters/accepts it here to add that person/group to the allowlist. Refresh pending + bound lists.
4. **Invite link (Telegram):** mint a single-use deep link (with TTL); whoever clicks it auto-starts the bot and appears for one-click approval; the operator can copy or revoke links.
5. **Channel request (Slack):** when the bot is mentioned in a channel, it appears as a request; approving opens the modal (§5d) to choose mention-only vs accept-from-anyone, then allows the channel; deny removes it.
6. **Remove bound chat / revoke invite / disconnect:** all **destructive → require a confirmation prompt.** Disconnect removes the whole binding for that provider.
7. **Reconnect / Smoke-test:** force a channel reconnect / run a Slack smoke test; show result.

### Destructive-action confirmations (must prompt)
- Remove a bound chat/group, revoke an invite link, disconnect a channel, and (elsewhere in the dialog) the main-channels hard restart. Each asks an explicit yes/no first.

---

## 7. STATES — empty / loading / error / permission-denied / live-update

- **Empty:** each list has its own empty text (§4). System-integration fields render even when unset (with "not set" pills).
- **Loading:** buttons that call the server swap their label for a spinner + a "...-ing" caption (Connecting…, Generating…, Checking…). Model-change shows a transient "restarting" badge while polling.
- **Error:** failures surface as toasts (`Hiba: <message>` / `Error: <message>`) or inline error areas (auth sub-panels, system-integration status). Network blips during polling are tolerated (keep polling, don't crash the view).
- **Permission-denied / read-only:** the main agent shows the read-only banner and disables/ hides identity edits and model save; the server also rejects those writes. Channel binding messages adapt to whether the agent is running (the bot only works while the agent runs).
- **Live-update / poll:** the Channel tab auto-refreshes its pending/allowed/invites/requests lists on an interval while that tab is open, and stops polling when you leave it. The image-gen status strip polls while the Vault page is open. The Appearance panel has no polling. Other pages (e.g. activity) poll independently and are out of scope here.

---

## 8. PERMISSIONS / VISIBILITY (operator vs agent; autonomy gating)

- This entire surface is **operator-only** — it lives in the operator dashboard, behind the dashboard's bearer credential. Agents do not see or use these screens.
- **Main/orchestrator agent is special:** its identity docs and tool config are **read-only from the dashboard** (security: prevent remote identity rewrite if the dashboard credential leaks); editing must be done on the host filesystem or by messaging the agent. Sub-agents are fully editable.
- **Channel binding** is per-agent. The operator's own chat id is auto-allowed on connect; everyone else must be explicitly approved (pairing code, invite link, or channel-request approval). The approve modal lets the operator scope access (mention-only / anyone) per channel.
- **Autonomy gating:** keep settings writes immediate for the operator. (Autonomy levels gate *agent-initiated* escalation elsewhere in the product, not these operator-only forms.)
- **Appearance** is purely client-side and visible to any viewer of the dashboard; it changes nothing server-side and is per-browser.

---

## 9. DATA CONCEPTS read / written (concept level)

- **Appearance:** browser-local preferences — selected theme, density mode, glow intensity, accent override. No server state.
- **Product identity / branding:** the **product/bot display name** and **the owner name** are fixed configuration set at install time (env/config), surfaced read-only as the sidebar brand name and as the default agent description. The **brand mark** is an operator-uploaded main-agent avatar if present, else a default glyph. **There is no in-app editor for the product name.** The **default locale is fixed to Hungarian** throughout (dates/times render in `hu-HU`); ship a full HU string set as default with EN as the alternate, but there is no runtime locale switcher — treat locale as a build/config concern (see §10).
- **System integrations:** key/value integration settings — an update-source repo + token, an image-gen backend URL + default model + wake target. Secrets stored encrypted (with a masked preview only); non-secrets in plain config; both read live at runtime.
- **Per-agent settings:** the agent's model, auto-restart policy (enabled/mode/schedule), authentication mode (+ optional stored API key), security/permission profile, and three identity documents (operating doc, persona, tool/MCP config).
- **Channel binding:** per agent + per provider — the bot token (and provider-specific extras: Slack app token, Discord channel id), the bot's resolved @username, the allowlist of bound DM users and groups, pending pairing codes, single-use invite links (token + expiry + used flag), and Slack channel requests with per-channel access flags (mention-only / from-anyone). The **operator chat id** is a config value used to pre-allow the operator on connect.

---

## 10. i18n — every string ships HU (default) + EN

Default UI language is **Hungarian**; provide an English translation for every string. Keep all labels in a translation table. Key strings (HU → EN), beyond those already inlined above:

- `Megjelenés` → `Appearance`; `Téma` → `Theme`; `Sűrűség` → `Density`; `Kényelmes` → `Comfortable`; `Kompakt` → `Compact`; `Ragyogás` → `Glow`; `Kiemelő szín` → `Accent color`; `Bezárás` → `Close`; `Témaváltás` → `Switch theme`.
- `Rendszer-integrációk` → `System integrations`; `Mentés` → `Save`; `Frissítés-ellenőrzés most` → `Check for updates now`; `beállítva` → `set`; `nincs beállítva` → `not set`; `Mentve` → `Saved`; `Nincs változás.` → `No changes.`; `Hiba:` → `Error:`.
- `Beállítások` → `Settings`; `Csatorna` → `Channel`; `Modell` → `Model`; `Automatikus újraindítás` → `Automatic restart`; `Bekapcsolva` → `Enabled`; `Mód` → `Mode`; `Folytatás` → `Continue`; `Friss` → `Fresh`; `Ütemezés` → `Schedule`; `Napi időpont` → `Daily time`; `Óránként` → `Every N hours`; `Időpont` → `Time`; `Hitelesítési mód` → `Authentication mode`; `Megosztott` → `Shared`; `Saját Team login` → `Own team login`; `API kulcs` → `API key`; `Biztonsági profil` → `Security profile`; `Főagent konfiguráció — csak olvasható` → `Main-agent config — read-only`.
- `Csatorna provider` → `Channel provider`; `Összekapcsolás` → `Connect`; `Csatlakozás...` → `Connecting...`; `Bot API Token` → `Bot API token`; `Token beállítva` → `Token set`; `Bekötött chat-ek és csoportok` → `Bound chats & groups`; `Meghívó link` → `Invite link`; `Új meghívó link` → `New invite link`; `Visszavonás` → `Revoke`; `Másol` → `Copy`; `AKTÍV` → `ACTIVE`; `FELHASZNÁLT` → `USED`; `Párosítási kód` → `Pairing code`; `Jóváhagyás` → `Approve`; `Várakozó párosítás` → `Pending pairing`; `Csatorna-kérések` → `Channel requests`; `Csak @-tageléskor figyeljen` → `Only when @-mentioned`; `Bárkitől fogadjon` → `Accept from anyone`; `Kapcsolat tesztelése` → `Test connection`; `Leválasztás` → `Disconnect`; `Eltávolítás` → `Remove`; `Mégse` → `Cancel`.
- Confirmations (HU → EN): `Biztosan eltávolítod ezt a chatet?` → `Remove this chat?`; `Biztosan visszavonod ezt a meghívó linket?` → `Revoke this invite link?`; `Biztosan leválasztod a csatornát?` → `Disconnect this channel?`.

Implementable from scratch. For all visual styling, theme tokens, density/glow behavior, and accent application, see `01-design.md`.
