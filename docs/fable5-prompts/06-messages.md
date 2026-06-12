# Fable 5 Build Prompt — Messages (Üzenetek) View

> CLEAN-ROOM NOTICE: This is an original behavioral and visual specification written from observation of an existing product's *behavior*. It contains no source code, identifiers, file names, or database schema from any prior implementation. Implement it from scratch in whatever stack you choose. For all visual styling (colors, spacing scale, typography, radii, shadows, badge palettes, avatar discs) defer entirely to the design system document `01-design.md` — this document specifies STRUCTURE and BEHAVIOR, not pixels.

---

## 1) PURPOSE & WHERE IT LIVES

The Messages view is the operator's chat console for the multi-agent system. It is a single-pane messaging client (think of a desktop messaging app: a contact list on the left, an open conversation on the right) through which the human operator reads the message traffic that flows between agents, and composes and sends messages directly to any agent. It surfaces the system's internal "agent-to-agent message queue" as human-readable conversation threads, one per peer.

- **Navigation item.** Lives in the primary left navigation rail as a top-level entry, positioned near the team/roster area (it sits adjacent to the team page in the nav order).
- **Nav label:** HU `Üzenetek` / EN `Messages`.
- **Nav icon idea:** a speech-bubble / chat-balloon outline (a rounded rectangle with a small tail at the bottom-left) — the universal "conversation" glyph, drawn as a thin-stroke line icon consistent with the other nav icons.
- **Page title (H1):** HU `Üzenetek` / EN `Messages`.
- **One-line subtitle under the title:** HU `Inter-agent kommunikáció` / EN `Inter-agent communication`.

---

## 2) PAGE LAYOUT & APPEARANCE

Structure only — see `01-design.md` for all styling.

The page is composed top-to-bottom of:

1. **Page header row** spanning the full width:
   - Left: the H1 title and the subtitle line (stacked).
   - Right (pushed to the far edge): a single compact secondary button labeled **Frissítés / Refresh** with a circular-arrow (reload) icon.
   - The header has minimal bottom margin so the chat area sits close beneath it.

2. **A two-column chat layout** filling the remaining height:
   - **Left column — Peer/thread sidebar** (a fixed, narrower column). It is a vertically scrolling list of conversation peers (one row per agent/peer). At the very top, before any data loads, it shows a small "loading" placeholder line.
   - **Right column — Conversation panel** (the wider column, the main reading area). Before any peer is selected it shows an empty-state placeholder (a large faint speech-bubble icon centered with a prompt to pick a peer). Once a peer is selected, this panel is internally divided into three stacked regions:
     - **(a) Thread header** (top bar): the selected peer's avatar, the peer's display name, and a far-right compact reload button (re-fetches just this thread).
     - **(b) Bubbles region** (the large middle area, vertically scrollable): the conversation rendered as chat bubbles, oldest at top, newest at bottom; auto-scrolled to the bottom on open. A thin "loading older…" indicator can appear pinned at the very top of this region during upward pagination.
     - **(c) Compose box** (bottom, fixed within the panel): a multi-line text input and a send button side by side.

The left sidebar and the right panel are independent scroll regions. The compose box never scrolls away — it is anchored to the bottom of the conversation panel.

---

## 3) CONTROLS

Every interactive control, with HU + EN labels.

| Control | HU label | EN label | Type | What it does |
|---|---|---|---|---|
| Refresh page | `Frissítés` | `Refresh` | Secondary compact button, top-right of page header, reload icon | Re-fetches the peer/thread sidebar AND, if a thread is currently open, re-fetches that thread's messages. |
| Thread reload | (icon only) | (icon only) | Compact secondary icon button, far-right of the thread header | Re-loads only the currently open conversation (re-runs the same open-thread fetch). Reload/circular-arrow icon, no text label. |
| Compose input | placeholder: `Üzenet {peer}-nek...` | placeholder: `Message {peer}...` | Multi-line text area, 2 rows tall, in the compose box | Where the operator types the outgoing message. The placeholder interpolates the selected peer's name (e.g. "Üzenet FORGE-nek…"). |
| Send | `Küldés` | `Send` | Primary compact button, right of the compose input | Sends the typed message to the selected peer (see Flows §6). Disabled while a send is in flight. |
| Peer row | (each peer's name) | (each peer's name) | Clickable list row in the sidebar | Selecting it opens that peer's conversation in the right panel and marks the row visually selected. |

**Keyboard shortcut on the compose input:** pressing Ctrl+Enter (or Cmd+Enter on macOS) submits the message — identical to clicking Send. Plain Enter inserts a newline (it does NOT send).

There are no other dropdowns, tabs, filters, or search fields in this view. (Server-side the message API supports filtering by status — e.g. only pending — and by agent, but the operator UI does not expose a status filter or a free-text search; the sidebar is the only navigation mechanism.)

---

## 4) LISTS / CARDS / TABLES

### 4.1 Peer/thread sidebar (left column)

A vertical list. Each entry represents one conversation peer. The list is assembled from two sources merged together:
- The full agent roster (every agent in the fleet, plus the main/orchestrator agent), **minus** a fixed set of internal "system" participants that are never shown as peers (the heartbeat job and the channel/relay coordinators — see §8).
- Plus any peer that appears in actual message traffic but isn't in the roster (e.g. the operator's own pinned thread, or an external/ad-hoc sender).

Each peer row shows, left to right:
- **Avatar** (a round avatar disc; see §4.3 for avatar resolution).
- **Display name** — the peer's agent name. The operator's own self-thread is relabeled to HU `Te` / EN `You` (it is not shown by its internal id).
- **Last-message preview** — the most recent message's text in this thread, collapsed to a single line (newlines flattened to spaces) and truncated to roughly 60 characters. If the peer has no messages at all, the preview reads HU `Nincs üzenet` / EN `No messages`.
- **Time** (right-aligned) — the time of the last message, formatted as a short clock time (hours:minutes); empty if there are no messages.

Per-row states:
- **Selected** — the currently open thread is visually marked as the active row.
- **Dimmed** — a roster peer that has never exchanged any message is rendered at reduced opacity (it's selectable, just visually de-emphasized as "no history").
- **Unread** — a peer with a last message newer than what the operator has previously seen is marked unread: the row carries an unread treatment, a small unread dot sits next to the name, and the preview line is emphasized. (Unread tracking applies specifically to the operator's own pinned thread — see §6.5 and §9.)

Per-row action: clicking the row opens the thread (the only per-row action; there is no context menu).

**Ordering of the sidebar:**
1. The operator's own thread (HU `Te` / EN `You`) is pinned to the very top, always.
2. Then all peers that *have* message history, sorted by most-recent-message time, newest first.
3. Then all remaining peers (no history) in alphabetical order.

### 4.2 Conversation bubbles (right panel, middle region)

The thread is a list of chat bubbles, sorted oldest→newest (top→bottom). Each message is one bubble row. Bubble rows have two layouts driven by direction:

- **Outgoing** (sent BY the operator/main agent perspective — i.e. the message's sender equals the local "self" identity): bubble is aligned to one side (the "mine" side), with the self avatar shown on that outer edge. No sender-name label is shown on outgoing bubbles.
- **Incoming** (sent by the peer): bubble aligned to the opposite side, with the peer's avatar on its outer edge, and the **sender's name** shown as a small label at the top of the bubble.

Each bubble contains, in order:
- **Meta line** (small, at the top of the bubble):
  - Sender name label (incoming bubbles only).
  - A message-id chip rendered as `#<number>` (the message's numeric id, useful for the operator to reference a specific message).
  - A small **status badge** (see status meta below).
- **Body text** — the message content (plain text, HTML-escaped; user content is never rendered as markup).
- **Timestamp** — a short localized date+time (e.g. "Jun 7, 14:32" style: abbreviated month, day, 2-digit hour, 2-digit minute).

**Status badge values** (the per-message lifecycle state), each a colored pill — exact colors per `01-design.md`'s badge palette:
| State | HU label | EN label | Badge tone |
|---|---|---|---|
| pending | `függőben` | `pending` | warm / amber ("waiting to be delivered") |
| delivered | `kézbesítve` | `delivered` | active / positive ("handed to the agent") |
| done | `kész` | `done` | active / positive ("completed / acknowledged") |
| failed | `hibás` | `failed` | muted-negative / paused tone ("delivery failed") |

If a message somehow carries an unrecognized status string, render that raw string in a neutral default badge.

### 4.3 Avatar resolution (applies to sidebar rows, thread header, and bubbles)

Avatars resolve in this priority order, for both the main agent and sub-agents:
1. If the agent has an uploaded custom avatar image, use it (fetched from that agent's avatar endpoint, cache-busted per load).
2. Otherwise, for known base/seed agents (and the main orchestrator), use that agent's brand "glyph" image.
3. Otherwise, fall back to a **monogram disc**: a colored circle showing the first letter of the name, the background color chosen deterministically from the name (so a given name always gets the same color from a small fixed palette).
- If an avatar image fails to load at runtime, it is replaced on the fly with the monogram disc fallback.

---

## 5) OPENED CARDS / MODALS / DETAIL PANES

This view has **no modal dialogs**. The "opened" object is the **conversation panel** itself (the right column), which replaces its empty-state when a peer is selected. Its full contents:

### 5.1 Open conversation panel

- **Thread header bar** (top):
  - Peer avatar (resolved per §4.3).
  - Peer **display name/title** (operator's self-thread shows HU `Te` / EN `You`).
  - **Thread reload** icon button pushed to the far right (re-fetches this conversation; circular-arrow icon, no text).
- **Bubbles region** (middle, scrollable): the list of message bubbles described in §4.2. On open it is scrolled to the bottom (newest). A hidden "loading older…" indicator (HU `Betöltés...` / EN `Loading…`) lives pinned at the top of this region and becomes visible only during upward (older-messages) pagination.
- **Compose box** (bottom):
  - **Compose text area** — multi-line, 2 rows, placeholder HU `Üzenet {peer}-nek...` / EN `Message {peer}...`.
  - **Send button** — HU `Küldés` / EN `Send`, primary style, to the right of the text area.

There are no other panes, no per-message detail popovers, no edit/delete affordances on individual messages — messages are immutable in this UI (the only mutation is composing a new one, plus the server lifecycle transitions reflected in the status badge).

---

## 6) FLOWS & BEHAVIOR

Each flow described as a contract (what happens + which conceptual API + the effect), not as code.

### 6.1 Opening the Messages view
- On navigating to the page, the app loads the **threads/peers** for the sidebar.
- Behind the scenes it fetches, in parallel: (a) the **agent roster** (names + whether each has a custom avatar) and (b) the **conversation-thread index** (one entry per peer with that peer's total message count and most-recent message).
- It builds and renders the sidebar (merge + filter + sort per §4.1).
- If no thread is currently selected, it **auto-selects and opens the first row** (which, given the pin rule, is the operator's own `Te`/`You` thread).

### 6.2 Selecting a peer / opening a thread
- Clicking a peer row marks it selected (and clears selection from the others), then opens that conversation.
- Opening a thread:
  1. Resets that thread's pagination cursor state (no oldest-id known yet, "more available" assumed true).
  2. Renders the panel scaffold (header + empty bubbles region + compose box) with the correct peer name interpolated into the placeholder.
  3. Fetches the **first/newest page** of that peer's conversation: a request for "this agent's messages" with a small page size (about 10 messages), returning the *most recent* batch. The view sorts the batch oldest→newest and renders the bubbles, then scrolls to the bottom.
  4. If the returned batch is smaller than the requested page size, the view concludes there are no older messages (pagination end reached).
  5. Marks the thread as "seen" for unread tracking (see §6.5).

The conversation query is **scoped to the single peer in the data layer** (it returns messages where that peer is either sender or recipient). This is deliberate: a naïve "fetch the global last N then filter client-side" approach would starve rarely-active threads — so the contract is "give me the last N for *this* peer specifically," with cursor support for older pages.

### 6.3 Pagination / cursor behavior (scroll-up to load older)
- The bubbles region has a scroll listener. When the operator scrolls near the **top** (within a small threshold), and the view believes more older messages exist, and no fetch is already in flight, it fetches the **next-older batch**.
- The cursor is the **oldest message id currently loaded**: the request asks for messages *before* that id, for this peer, with a larger page size (about 20). This is a strict "before this id" cursor, newest-first from the server, re-sorted oldest→newest for display.
- During this fetch the "loading older…" indicator at the top becomes visible.
- New older bubbles are **prepended** above the existing ones, and the scroll position is **preserved** (the view computes the height delta and restores scroll so the content the operator was reading does not jump).
- When a returned older batch is smaller than the requested size (or empty), the view marks "no more older messages" and stops paginating upward.
- The newest end does NOT auto-paginate forward; the operator gets newer messages by refreshing the thread or re-opening it. Updates appear via the refresh controls (see §7 for live behavior).

### 6.4 Composing & sending (operator → agent)
- The operator types into the compose text area and clicks **Send** (or presses Ctrl/Cmd+Enter).
- Empty/whitespace-only content is rejected client-side (the input simply refocuses; nothing is sent).
- On send, the Send button disables (prevents double-send), and the view calls the **dedicated operator-send API** with the target peer and the trimmed content. The operator-send path is distinct from the generic message-create path on purpose (see §8): the server stamps the sender identity as the **operator** server-side, so the receiving agent gets proper "operator / reply-expected" framing.
- On success: the compose input is cleared, a toast confirms HU `Üzenet elküldve` / EN `Message sent`, then the view **reloads the open thread** (so the new message appears as an outgoing bubble) and **reloads the sidebar** (so the thread's last-message preview/time/order update).
- On failure: a toast shows HU `Hiba: {message}` / EN `Error: {message}` with the server's error text.
- Finally the Send button is re-enabled regardless of outcome.

### 6.5 Marking a thread as read (unread tracking)
- After a thread's first page loads, the view records the highest message id it has seen for that peer as the "last seen" marker (persisted locally in the browser, per peer).
- It then visually clears the unread treatment from that peer's sidebar row (removes the unread class, the unread dot, and the preview emphasis).
- A peer is considered **unread** when its last-message id exceeds the locally stored "last seen" id for that peer. (As implemented, this unread logic is applied specifically to the operator's own pinned thread; treat it as the canonical pattern and you may extend it to all peers if your design system calls for it — but match the pinned-thread behavior at minimum.)

### 6.6 Refresh controls
- The page-level **Frissítés/Refresh** button re-fetches the sidebar and, if a thread is open, re-fetches that open thread.
- The thread-header reload icon re-fetches only the open thread.

### 6.7 Server-side message lifecycle reflected in badges (read-only to the operator)
The operator does not change message status from this view, but the status badges reflect a server lifecycle the operator should understand:
- A new message starts **pending**.
- When the system delivers it to the target agent's running session, it becomes **delivered**.
- The receiving agent (or the system) can later mark it **done** (with an optional result/acknowledgement) or **failed** (with an optional error). These transitions are visible the next time the thread is refreshed.
- A message addressed to the operator is treated as terminal on delivery (the operator reads it in this dashboard; there is no separate operator session to inject into), so operator-bound messages settle as delivered rather than getting stuck pending.

**Confirmations:** There are **no destructive or irreversible actions** in this view, so no confirmation dialogs are required. Sending a message is the only write, and it is non-destructive (it appends). Do not add delete/clear-thread actions unless separately specified.

---

## 7) STATES

- **Loading (sidebar):** before threads load, the sidebar shows a small loading line (HU `Betöltés...` / EN `Loading…`).
- **Loading (thread, initial):** the bubbles region is briefly empty/scaffolded while the first page fetches.
- **Loading (older pages):** the pinned top "loading older…" indicator (HU `Betöltés...` / EN `Loading…`) shows during upward pagination.
- **Empty (no peer selected):** the right panel shows a centered faint speech-bubble icon plus a prompt: HU `Válassz ügynököt` / EN `Pick an agent`.
- **Empty (thread has no messages):** the bubbles region shows HU `Nincs üzenet ebben a szálban.` / EN `No messages in this thread.`
- **Empty (peer with no history in sidebar):** that row's preview reads HU `Nincs üzenet` / EN `No messages` and the row renders dimmed.
- **Error (sidebar load failed):** the sidebar shows HU `Hiba: {message}` / EN `Error: {message}`.
- **Error (thread load failed):** the bubbles region shows HU `Hiba: {message}` / EN `Error: {message}`.
- **Error (send failed):** a transient toast HU `Hiba: {message}` / EN `Error: {message}`; the compose text is preserved so the operator can retry.
- **Permission-denied:** if the underlying message-create call is rejected by the server's identity guard (see §8), the failure surfaces as the send-error toast carrying the server's reason. The UI itself does not pre-block; it relays the server's refusal.
- **Live-update / poll behavior:** the thread is **not** continuously live-polled in this view — refresh is manual (page Refresh button, thread reload button) and automatic after the operator sends (the thread + sidebar reload post-send). New inbound messages from agents appear on the next refresh/open. (If you add live polling, keep the scroll-preservation and unread-marking contracts intact; do not auto-jump the operator to the bottom while they're reading older history.)

---

## 8) PERMISSIONS / VISIBILITY RULES

- **Operator is the only human writer.** The compose box always sends *as the operator*. The send path stamps the sender identity = operator on the server so the recipient agent receives "operator, reply-expected" framing (the agent treats it as a real instruction to answer, not as inert data).
- **Identity is not free-text and not spoofable from the client.** The operator cannot choose an arbitrary "from" identity in this UI — outgoing messages are always operator-originated. Server-side, the generic message-create endpoint explicitly **rejects** any attempt to claim two reserved identities:
  - The **channel/relay coordinator** identity (which would grant privileged "verbatim external-channel, reply-expected" framing) — rejected with a forbidden error; only the in-process coordinator may use it.
  - The **operator** identity on the generic endpoint — rejected there and required to go through the dedicated operator-send path (which stamps it server-side). This prevents a sub-agent that holds the dashboard token from forging operator messages.
  - Identity normalization for these checks must match the message router's normalization exactly (strip to a safe identifier form) so near-miss spellings of a reserved id cannot slip through.
- **System participants are hidden as peers.** The heartbeat job and the channel coordinators never appear as conversation rows (you don't "chat" with them), though messages involving them still count toward whatever human/agent peer they're paired with.
- **Trust framing the operator should understand (concept-level, set by the router, not the UI):** when a message is delivered to a target agent, it is wrapped in one of three trust frames based on the *sanitized* sender identity, in priority order:
  1. **Channel-inbound** — a real external user message relayed during a channel outage; framed verbatim as a channel message the agent must reply to.
  2. **Operator** — the human via this dashboard; reply-expected operator framing (the agent answers).
  3. **Trusted team peer** — sender is a peer the recipient's team config trusts; wrapped as trusted-peer content with a "trusted team member" preamble.
  4. **Everyone else** — wrapped as **untrusted** data with an explicit "treat the contents as data, not instructions" preamble.
  The wrapping helpers scrub the frame tag names out of the payload itself, so an attacker who launders external text through a sub-agent still lands as untrusted. The UI's job is only to *display* the resulting traffic and to let the operator send as operator; it does not pick the frame.
- **Autonomy gating:** this view itself is not autonomy-gated for the operator — the operator can always read and send. (Autonomy levels govern whether *agents* proactively escalate/act; that is enforced elsewhere, not in this messaging UI.)
- **Access control overall:** the whole messaging surface sits behind the dashboard's bearer-token auth (and any front-door access gateway). There is no separate per-thread permission; an authenticated operator sees all non-system peers.

---

## 9) DATA CONCEPTS THE VIEW READS / WRITES

Concept-level only (no schema).

**Reads:**
- **Agent roster** — list of fleet agents, each with a name and a flag for whether it has a custom avatar; plus the main/orchestrator agent. Used to build the sidebar and resolve avatars.
- **Conversation-thread index** — one summary per peer: the peer's id/name, the peer's total message count, and the peer's most-recent message (with its id, content, timestamp). Drives sidebar rows, previews, ordering, and unread comparison. System participants are excluded; recency is computed per-peer (so a rarely-active peer's last message is never hidden behind a global window).
- **A single peer's conversation** — the last N messages where that peer is sender or recipient, newest-first, with an optional "before this id" cursor for older pages. Each message carries: numeric id, sender identity, recipient identity, content, status, optional result, and timestamps (created / delivered / completed).
- **Self identity** — the local "main/self" agent id, used to decide outgoing vs incoming direction for each bubble.

**Writes:**
- **Send operator message** — creates a new message addressed to the selected peer, with sender = operator (stamped server-side). Effect: a new pending message enters the queue and is delivered to the target agent's session with operator framing.
- **Local "last seen" markers** — per-peer, stored in the browser only (not server state); drives unread indicators. This is the only client-persisted state.

**Message object fields the view relies on (concept names, not schema):** id (numeric, shown as `#id`), from/sender, to/recipient, content, status (pending | delivered | done | failed), optional result text, created timestamp (shown as bubble time), delivered timestamp, completed timestamp.

---

## 10) i18n

- All user-facing strings ship in **Hungarian (default)** and **English**.
- Strings to localize (HU default / EN): nav label `Üzenetek` / `Messages`; H1 `Üzenetek` / `Messages`; subtitle `Inter-agent kommunikáció` / `Inter-agent communication`; refresh button `Frissítés` / `Refresh`; send button `Küldés` / `Send`; compose placeholder `Üzenet {peer}-nek...` / `Message {peer}...`; self-thread label `Te` / `You`; loading `Betöltés...` / `Loading…`; empty-no-selection `Válassz ügynököt` / `Pick an agent`; empty-thread `Nincs üzenet ebben a szálban.` / `No messages in this thread.`; sidebar no-history preview `Nincs üzenet` / `No messages`; send-success toast `Üzenet elküldve` / `Message sent`; error prefix `Hiba:` / `Error:`; status badges `függőben`/`pending`, `kézbesítve`/`delivered`, `kész`/`done`, `hibás`/`failed`.
- Timestamps and times are locale-formatted (default Hungarian locale): short clock (HH:MM) for sidebar last-message time; abbreviated date+time for bubble timestamps. Keep the formatting locale-driven so EN renders its conventional forms.
- The placeholder string interpolates a runtime peer name; ensure the interpolation token placement works grammatically in both languages (HU uses a `-nek/-nak` suffix you'll need to handle; for EN prefer "Message {peer}…").

---

### Implementation checklist (build-from-scratch)
- [ ] Nav entry + speech-bubble icon, title + subtitle (HU default, EN).
- [ ] Two-column layout: peer sidebar + conversation panel, independent scroll, anchored compose box.
- [ ] Sidebar: roster ∪ traffic-peers, minus system participants; operator self-thread pinned top; sort by recency then alpha; per-row avatar/name/preview/time; selected/dimmed/unread states; auto-open first row.
- [ ] Conversation: oldest→newest bubbles, direction-based alignment + avatar side, incoming sender label, `#id` chip, status badge, escaped body, localized timestamp; auto-scroll to bottom on open.
- [ ] Scroll-up cursor pagination (before-oldest-id), prepend with scroll-position preservation, end-of-history detection, top loading indicator.
- [ ] Compose: multi-line input + Send, Ctrl/Cmd+Enter to send, empty-guard, disable-during-send, clear+toast+reload on success, error toast on failure.
- [ ] Send always as operator via the dedicated operator path (never free-text identity).
- [ ] Unread last-seen markers in local storage, cleared on open.
- [ ] All states (loading / empty / error / permission-denied relay) and the manual+post-send refresh model.
- [ ] Read-only status-badge reflection of the server message lifecycle; no destructive actions, no confirmations needed.
- [ ] Full HU/EN i18n; defer all visual styling to `01-design.md`.
