# Fable 5 Build Prompt — Team (Csapat) View

> **CLEAN-ROOM NOTICE.** This is an original behavioral and visual specification written for an engineer ("Fable 5") who has never seen the reference product and must reimplement this screen from scratch. It describes *what the screen looks like and does* — regions, controls, labels, fields, flows, states — not how any existing code expresses it. Do not seek, transcribe, or reproduce source code, file names, identifiers, or database schemas from any prior implementation. Build it your own way.
>
> **Look & feel lives elsewhere.** All colors, type scale, spacing tokens, card/elevation styling, button variants, badge styling, accent rings, and avatar treatment are defined in `01-design.md`. This document only specifies *structure and behavior*. Wherever it says "primary button," "secondary button," "danger button," "badge," "muted helper text," "accent ring," etc., resolve the actual styling from the design system.

---

## 1) PURPOSE & WHERE IT LIVES

**What it is.** A dedicated top-level page that shows the agent organization as a *constellation / hierarchy chart* — a who-reports-to-whom tree rooted at the single orchestrator (the "main agent" / hub). It is the at-a-glance org map of the fleet. It is read-mostly on this page: you *view* the shape of the team here, and you *edit* the relationships from each agent's own detail panel (a "Team" tab), which this spec also fully describes.

**Navigation.**
- It is one item in the left sidebar nav.
- Nav label: **HU "Csapat"** / **EN "Team"**.
- Icon idea: a small cluster of connected people / nodes — e.g. two-or-three linked figures, or an org-chart node-and-branch glyph. The concept to convey is "group / hierarchy," not a single person. (Exact stroke/style per `01-design.md`.)

**Page header.**
- Title: **HU "Csapat"** / **EN "Team"**.
- One-line subtitle directly under the title:
  - **HU:** "Ki kinek jelent és ki kinek delegál"
  - **EN:** "Who reports to whom, and who delegates to whom"

**Where the data comes from (concept level).** The page reads a single "team graph" resource that returns three things: a list of **nodes** (one per agent, including the hub), a list of **edges** (directed reporting links, parent → child), and an indicator of **which node is the hub** (the main agent). Each node carries: a stable id, a human display label, a role (`main` | `leader` | `member`), who it reports to, who it delegates to, a running/stopped flag, and a flag for whether a custom avatar image exists.

---

## 2) PAGE LAYOUT & APPEARANCE (structure only)

Top to bottom, the page has three regions:

1. **Header row** (title + subtitle on the left; a single action button pinned to the right of the same row):
   - Right-aligned **Refresh** button (see Controls). It is a compact secondary button with a circular-arrows / reload icon and a text label.

2. **The constellation graph** — the main body. It is a vertical, top-down hierarchy:
   - The hub sits alone in the **top row**, centered.
   - Below it, each subsequent **row ("level")** holds all agents that report (directly or transitively) one step further from the hub. Level 1 = everyone reporting to the hub; level 2 = everyone reporting to a level-1 agent; and so on (breadth-first by reporting depth).
   - Each level is a horizontal row of equal-sized **node tiles**, centered.
   - Between every two adjacent levels there is a **connector** element (a vertical link / spine drawn between the rows) to convey the tree branching. Treat it as a visual connector strip; exact rendering (lines, gradient spine, dots) is a design-system choice — the *requirement* is that the parent→child relationship reads visually as a connected tree, not a flat list.
   - If some agent somehow is not reachable from the hub (should not normally happen because the backend defaults any orphan's parent to the hub), those stray nodes are appended as one extra trailing level so nothing is ever hidden.

3. **A footer hint line** under the graph, in muted helper text:
   - **HU:** "A szerep és a beosztott/vezető kapcsolatok az ügynök részletek > Csapat fülén szerkeszthetők."
   - **EN:** "Role and the report-to / delegation relationships are edited on the agent's detail panel, under the Team tab."

This page is **view + entry-point only**. There is no inline editing of edges on the graph itself; editing happens in the per-agent Team tab (Section 5).

**Reuse note.** The exact same graph renderer is also embedded as a card on the Overview/dashboard page (a smaller "team" card). Build the renderer as a reusable component that takes the team-graph data and a target container, so both the full Team page and the Overview card render identically.

---

## 3) CONTROLS (every interactive element, HU + EN)

### On the Team page
- **Refresh button** — HU "Frissítés" / EN "Refresh".
  - Compact secondary button, top-right of the header, with a reload icon.
  - Action: re-fetches the team graph and re-renders the constellation. While loading it shows the loading placeholder (Section 7).

That is the only control on the Team page proper. All other controls live in the per-agent **Team tab** (reached from an agent's detail panel) and in the **Add-agent tile** (on the Agents page). Both are specified below because they are the editing surface for this view.

### In the per-agent Team tab (the editor)
This tab appears inside an agent's detail panel as one of several tabs (alongside the agent's other config tabs). The Team tab contains, top to bottom:

1. **Role dropdown** — label HU "Szerep" / EN "Role". Two options:
   - HU "Beosztott (member)" / EN "Member" → value `member`
   - HU "Csapatvezető (leader)" / EN "Leader" → value `leader`
   - Changing this **immediately** shows/hides the leader-only sections (see below) without saving.

2. **"Reports to" dropdown** — label HU "Kinek jelent" / EN "Reports to".
   - First option is the empty/null choice, labeled HU "(főügynök)" / EN "(main agent)" — meaning "reports directly to the hub."
   - The remaining options are every *other* agent (the current agent is excluded so it can't report to itself), shown by display name.
   - Muted helper text below: HU "Üresen hagyva automatikusan a főügynöknek." / EN "Left empty, it reports to the main agent automatically."

3. **Delegates-to list** (leader-only; hidden when role = member) — label HU "Kiknek delegálhat (csak leaderhez)" / EN "Can delegate to (leaders only)".
   - A vertical list of **checkboxes**, one per other agent (current agent excluded), each labeled with that agent's display name. Multiple may be checked.

4. **Auto-delegation toggle** (leader-only; hidden when role = member) — a checkbox with inline label:
   - HU "Autodelegálás: a vezető maga szétbontja és kiosztja a feladatot"
   - EN "Auto-delegation: the leader splits the task and assigns it itself"
   - Muted helper text below:
     - HU "Ha nincs bepipálva, a vezető csak javaslatot ad, te hagyod jóvá Telegramon."
     - EN "If unchecked, the leader only proposes a plan; you approve it via the channel (Telegram)."

5. **Trusted-peers list** (always shown) — label HU "Explicit megbízható kapcsolatok (opcionális)" / EN "Explicit trusted relationships (optional)".
   - A vertical list of **checkboxes**, one per other agent (current excluded), labeled by display name.
   - Long muted helper text below explaining its purpose:
     - HU: "A router alapból a jelent-kapcsolat és a delegálási lista alapján dönti el, hogy egy üzenet megbízható csapattárstól jön-e. Itt további ügynököket jelölhetsz kézzel — pl. egy cross-team együttműködő partner, akivel nincs hierarchikus kapcsolat, de a levelezése mégis csapattársi."
     - EN: "By default the message router decides whether an incoming message is from a trusted teammate based on the report-to and delegation relationships. Here you can manually mark additional agents as trusted — e.g. a cross-team collaborator with no hierarchical link, whose messages should still count as coming from a teammate."

6. **Save button** — HU "Mentés" / EN "Save". Compact secondary button. Persists the Team tab (Section 6).

### On the Agents page — the Add-agent tile (the "add agent" entry point)
The Team page itself has no create button; new teammates are created from the **Agents roster** page, whose grid includes a special **Add-agent tile** rendered as the last card in the grid:
- Appearance: a card styled as an "add" affordance — a large **plus (+)** icon centered, with a caption beneath.
- Caption: HU "Új ügynök" / EN "New agent".
- Action: clicking it opens the **multi-step create wizard** (Section 5).

---

## 4) LISTS / CARDS / TABLES

### The node tile (one per agent in the constellation)
Each tile is a compact card. It shows, top to bottom:
- **Avatar** (circular/framed): chosen by this precedence —
  1. The hub node always uses the hub's avatar resource.
  2. A non-hub agent with a custom uploaded avatar uses its own avatar resource.
  3. Otherwise a base/default portrait for that agent if one exists.
  4. Otherwise a **monogram** disc: the uppercased first letter of the agent's display name.
  - (Important: only request an agent's avatar URL when the node's "has custom avatar" flag is true, to avoid requesting a non-existent image. If the `<img>` fails to load, hide it / fall back to the monogram.)
- **Name** — the agent's display label (fallback to its id).
- **Role line** — a human label derived from the role:
  - `main` → HU "főügynök" / EN "main agent"
  - `leader` → HU "csapatvezető" / EN "team leader"
  - `member` → HU "beosztott" / EN "member"
- **Status line** — running indicator:
  - running → HU "● Fut" / EN "● Running"
  - stopped → HU "○ Leállva" / EN "○ Stopped"
  - The filled vs. hollow bullet distinguishes the two; color/treatment per `01-design.md`.

**Visual role distinction.** The hub tile and leader tiles get distinct visual emphasis (e.g. a special frame/accent for the hub, a lighter emphasis for leaders) — resolve the exact styling from `01-design.md`. The requirement: a viewer can tell at a glance which tile is the hub and which are leaders vs. plain members.

**Per-tile action.** Clicking any **non-hub** tile opens that agent's **detail panel / view** (the same agent detail used elsewhere, where the Team tab lives). The **hub tile is not clickable** (it has no editable team config — it is the fixed root).

### Empty-state node note
If the fleet contains only the hub (no sub-agents at all), the graph area additionally shows a small inline message under the single tile: HU "Nincs sub-agent létrehozva." / EN "No sub-agents created yet." (See also Section 7.)

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

### 5a) The per-agent detail panel → **Team tab** (the team editor)
Opened by clicking a node tile (or from the Agents roster). The detail panel hosts several tabs; one of them is **HU "Csapat" / EN "Team"**. Its full contents are exactly the controls in Section 3 ("In the per-agent Team tab"):
- Role dropdown
- Reports-to dropdown (with the "(main agent)" null option + helper text)
- Delegates-to checkbox list (leader-only, with its group label)
- Auto-delegation checkbox + helper text (leader-only)
- Trusted-peers checkbox list + long helper text (always shown)
- **Save** button at the bottom of the tab.

**Pre-population on open.** When the tab opens for an agent, it loads that agent's current team config and reflects it: role dropdown set to the saved role; reports-to set to the saved parent (or the "(main agent)" empty option if none); the delegates-to and trusted-peers checkboxes pre-checked to match the saved sets; the auto-delegation checkbox pre-checked if enabled. The leader-only sections are shown only if the saved role is `leader`.

**Reactive visibility.** Toggling the role dropdown to `leader` reveals the delegates-to list and auto-delegation toggle; switching back to `member` hides them again (no save needed for the show/hide).

**Hub special case.** The hub/main agent is not editable here — its team relationships are fixed (root, reports to nobody, delegates to all). The editor's save action does nothing for the hub; in practice the hub tile is not clickable so this tab is reached only for sub-agents.

**Bottom of the detail panel.** Below the tabs, the agent detail panel has a bottom action area containing a **Delete** button (HU "Törlés" / EN "Delete") for the whole agent. (Deleting the agent also tears down its team relationships — see Section 6 / Section 9.)

### 5b) The create wizard (reached from the Add-agent tile)
A modal titled **HU "Új ügynök létrehozása" / EN "Create new agent"**, with a close (×) control and a **3-step** progress indicator (three step dots).

**Step 1 — Identity & config.** Contains:
- **Avatar gallery** — label HU "Válassz avatart" / EN "Choose an avatar": a grid of selectable preset avatars; below them an **"or" divider** (HU/EN "vagy" / "or") and an **upload zone** to upload a custom image (accepts PNG/JPG/JPEG/WEBP; caption HU "Kép feltöltése (max 1 MB)" / EN "Upload image (max 1 MB)"), with a small preview + clear (×) once a file is chosen.
- **Name field** — label HU "Név" / EN "Name", placeholder HU "pl. kutató, copywriter, fejlesztő" / EN e.g. "researcher, copywriter, developer".
- **Description field** (textarea) — label HU "Írd le szabadon, mit szeretnél hogy csináljon ez az ügynök" / EN "Describe in your own words what you want this agent to do", with an example placeholder.
- **Model dropdown** — label HU "Modell" / EN "Model": an "inherit/default" option plus grouped cloud and alternative model choices (the list is provided by the backend's available-models resource and should be rendered from it, not hardcoded).
- **Security profile dropdown** — label HU "Biztonsági profil" / EN "Security profile", with a muted description line that updates to describe the selected profile.
- **Next button** — HU "Tovább" / EN "Next".

**Step 2 — Generation (loading).** A spinner + status text while the agent's config docs are generated (HU "CLAUDE.md generálás..." / EN "Generating config..."), with a "this may take a few seconds" sub-line.

**Step 3 — Review & create.** Two large editable text areas showing the generated identity/config docs for review/edit, with **Back** (HU "Vissza" / EN "Back") and **Create** (HU primary "Létrehozás"-style / EN "Create") buttons.

> The wizard is the team's "add a teammate" flow. A newly created agent appears in the constellation on the next graph load, by default reporting directly to the hub until its Team tab assigns a different parent. (Full wizard detail belongs to the Agents-view spec; included here only as the entry point this view references.)

---

## 6) FLOWS & BEHAVIOR (step by step + the contract each action fulfills)

### Load / refresh the constellation
1. On entering the page (and on Refresh), request the team-graph resource.
2. On success: build a node lookup, derive each node's children from the edges, then compute levels by breadth-first traversal starting at the hub. Render the hub on top, then each level as a centered row, with a connector between rows. Append any unreachable nodes as a trailing level. If only the hub exists, show the "no sub-agents" inline note.
3. On failure: replace the graph area with an inline error line (Section 7).

*Contract:* read-only GET of `{ nodes, edges, mainAgentId }`. The backend guarantees every node's parent resolves to a known agent or defaults to the hub, so the tree is always connected.

### Open an agent from a tile
- Click a non-hub tile → open that agent's detail view (where the Team tab can be edited). The hub tile is inert.

### Save the Team tab
1. Operator adjusts role / reports-to / delegates / auto-delegation / trusted-peers, then clicks **Save**.
2. The button shows a saving state (HU "Mentés..." / EN "Saving...") and disables.
3. Submit a team-update for that agent containing: the chosen role; reports-to (null when the empty option is selected); the delegates-to set **only if role = leader** (empty otherwise); the trusted-peers set; and auto-delegation **only if role = leader** (false otherwise).
4. The backend **sanitizes** the config: it strips self-references (an agent cannot report to / delegate to / trust itself) and unknown agent names, and returns a `warnings` summary of what it removed.
5. On success: show a confirmation toast. If warnings came back, the toast names what was dropped — HU pattern "Csapat mentve (kivett: …)" / EN "Team saved (removed: …)", listing self-references (HU "önreferenciák" / EN "self-references") and/or unknown names (HU "ismeretlen nevek" / EN "unknown names"). The button briefly shows a success check (HU "✓ Mentve" / EN "✓ Saved") then returns to "Save." The agent roster/graph is reloaded so the constellation reflects the new edges.
6. On error: show a failure toast (HU "Hiba a csapat mentésekor" / EN "Error saving team") and restore the button.

*Contract:* a per-agent team-config write that is authoritative for role, reportsTo, delegatesTo, autoDelegation, and trustFrom. Saving is **not** destructive and needs no confirmation.

### Create a teammate (Add-agent tile → wizard)
- Submitting the wizard creates a new agent. A new sub-agent created via the dashboard is, by default, **visible** in the roster and constellation and **reports to the hub** until reassigned. (A programmatically requested agent may instead require operator approval before it is created — see Permissions.) New teammates trigger a system "new teammate arrived" announcement to the hub and any running agents.

### Delete an agent (from its detail panel)
- The **Delete** button removes the agent entirely.
- This is **destructive and irreversible** → require an explicit confirmation before proceeding (e.g. a confirm dialog naming the agent).
- On delete, the backend also **cleans up dangling team references** to that agent across the fleet (it is removed from others' reports-to / delegates-to / trusted-peers). After deletion the constellation no longer shows the node.

---

## 7) STATES

- **Loading:** the graph area is replaced with a centered placeholder reading HU "Betöltés..." / EN "Loading...". Shown on first load and on Refresh.
- **Empty (only the hub exists):** the hub tile renders alone, and an inline note appears: HU "Nincs sub-agent létrehozva." / EN "No sub-agents created yet."
- **Error (graph fetch failed):** the graph area shows an inline error line, e.g. HU "Hiba: <message>" / EN "Error: <message>".
- **Team tab save states:** button cycles **Save → Saving… → ✓ Saved → Save**; on failure it reverts and a failure toast appears.
- **Per-node status:** each tile shows live running/stopped. (The constellation does not self-poll on a timer here; it refreshes on page entry and on the Refresh button. The Overview card that reuses the same renderer refreshes with the Overview's own load cycle.)
- **Permission-denied (create):** if a programmatic spawn is not allowed at the requested privilege, creation is refused or queued for operator approval rather than silently created (Section 8).

---

## 8) PERMISSIONS / VISIBILITY

- This is an **operator-facing** dashboard screen (single-user, behind the dashboard's bearer-token auth + access gateway). The operator sees the whole fleet and can edit any sub-agent's team config and create/delete agents.
- The **hub / main agent** is the fixed root: it reports to nobody, conceptually delegates to all, and its team config is not editable from this UI (its tile is not clickable).
- **Autonomy / privilege gating on creation:** only the orchestrator is permitted to spawn new agents programmatically, and no agent may ever create an agent more privileged than a fixed ceiling. When an agent (not the operator) requests a spawn above the allowed bar, the request is **not** auto-created — it becomes a pending approval the operator must approve or deny, and the operator is alerted. Operator-initiated creation via the dashboard wizard is direct (subject to the same privilege ceiling).
- **Internal/hidden agents:** technical/worker agents can be flagged internal — they are kept out of the visible roster and channel routing. Such agents are not expected to clutter the constellation as ordinary teammates.

---

## 9) DATA CONCEPTS (read/written, concept level)

The view reads/writes these concepts (names are conceptual, not a schema):
- **Team graph** (read): `nodes[]`, `edges[]` (parent→child), and the hub's id. Each node: id, display label, role (`main`/`leader`/`member`), reportsTo, delegatesTo[], running flag, has-custom-avatar flag.
- **Per-agent team config** (read/write via the Team tab):
  - `role`: `leader` | `member`
  - `reportsTo`: another agent's id, or null (= reports to hub)
  - `delegatesTo`: list of agent ids the agent may hand work to (meaningful only for leaders)
  - `autoDelegation`: boolean — whether a leader may split and assign work itself vs. only propose a plan for operator approval
  - `trustFrom`: optional manual list of agents whose messages count as "trusted teammate" even without a hierarchical link
  - Server-side sanitization strips self-references and unknown ids and reports them as warnings.
- **Avatar resources** (read): hub avatar, per-agent custom avatar, base portraits, monogram fallback.
- **Agent lifecycle** (write): create (wizard), delete (cleans up team references fleet-wide).
- **Running status** (read): per-agent running/stopped, surfaced on each tile.

> Note: the team/hierarchy is a *routing + visualization convenience* — it shapes how work is delegated and how the message router judges "is this from a teammate." It is not, by itself, a privilege-escalation surface; privilege is governed separately by the security profile and the spawn gate.

---

## 10) i18n

- All user-facing strings ship in **Hungarian (default)** and **English**, switchable, including: the nav label, page title + subtitle, footer hint, Refresh button, every Team-tab label/option/helper-text, the role/status labels on node tiles, the empty/loading/error strings, all toasts (saved / saved-with-removed-items / error), and the Add-agent tile caption + wizard labels.
- HU is the source-of-truth default; EN is the secondary locale. Keep the two in sync; never hardcode a visible string in only one language.
- Role/status display strings must be derived from the locale (e.g. `member` → "beosztott"/"member"), not from the raw enum value.
