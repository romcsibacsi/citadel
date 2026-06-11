import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, readAgentDisplayName } from './agent-config.js'
import { isAgentRunning, capturePane } from './agent-process.js'
import { resolveAgentSession } from './channel-mcp-reconnect.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { notifyAlert } from '../notify.js'
import { getInProgressCardForAssignee, updateKanbanCard, getKanbanCard } from '../db.js'
import {
  permissionPromptSignature,
  decidePermissionPromptAlert,
  type PermissionPromptAlertState,
  type PermissionPromptAlertThresholds,
} from '../pane-state.js'

// Permission-prompt WEDGE watcher (kártya #3ef5844e). A delegated agent whose
// tmux session is stuck at a tool-permission confirm dialog ("Do you want to
// create <file>? ❯ 1. Yes / 3. No", or "Allow Bash(...)?") is not working --
// it is parked waiting for a key. None of the existing four monitors catch
// this shape. This watcher captures each running agent's pane on a timer and,
// when the SAME prompt has persisted past the confirm window, ALERT-only:
// raises the needs-approval badge on the agent's in_progress card (#a0011592)
// and fires a one-shot debounced notify. It NEVER presses a key into the
// session -- deciding whether to approve is a trust/scope judgment for
// NEXUS/operator (the agent-stuck-permission-prompt skill).
//
// All decision logic is the pure permissionPromptSignature() +
// decidePermissionPromptAlert() in pane-state.ts (unit-tested); this module is
// only the I/O + per-session state, mirroring stuck-input-watcher.ts.

const THRESHOLDS: PermissionPromptAlertThresholds = {
  // The SAME prompt must persist this long before the first badge + ping, so
  // a prompt the operator/NEXUS resolves quickly never fires. With the 20s
  // poll + "first sighting records only" this is >=5 identical observations.
  confirmMs: 90_000,
  // Minimum gap between repeat pings within one unbroken wedge spell -- an
  // abandoned wedge pings at most ~2x/hour (matches PLUGIN_ALERT_DEDUP_MS).
  dedupMs: 1_800_000,
  // Continuous prompt-free time before a spell ends, so a single flapping
  // null capture does not reset the confirm window or end the episode.
  clearMs: 30_000,
}

// Offset from the other pane-readers (20/35/45s) so capture-pane calls do not
// pile onto one tick.
const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 20_000

const NO_STATE: PermissionPromptAlertState = { sig: null, firstSeenAt: null, lastAlertAt: null, lastSeenAt: null }

const watchState = new Map<string, PermissionPromptAlertState>()
// session -> the card id THIS watcher flagged requires_approval=1 on. The
// membership is the anti-clobber guard: the watcher only ever clears a flag it
// set itself (an operator/kanban-POST-set flag is never in this map).
const wdFlagged = new Map<string, string>()

function clearWatchdogFlag(session: string): void {
  const cardId = wdFlagged.get(session)
  if (cardId === undefined) return
  wdFlagged.delete(session)
  try {
    const card = getKanbanCard(cardId)
    // Only lower it if it is still raised -- if the operator already approved
    // (cleared) it, leave their action alone.
    if (card && card.requires_approval) {
      updateKanbanCard(cardId, { requires_approval: 0 })
      logger.info({ session, card: cardId }, 'stuck-permission-prompt-watcher: wedge resolved, lowered watchdog-set requires_approval')
    }
  } catch (err) {
    logger.debug({ err, session }, 'stuck-permission-prompt-watcher: clear-flag error')
  }
}

function checkSession(label: string, session: string): void {
  const pane = capturePane(session)
  // A failed capture is "no prompt": it does not immediately end a spell
  // (clearMs tolerance absorbs a transient tmux miss).
  const sig = pane == null ? null : permissionPromptSignature(pane)

  const prev = watchState.get(session) ?? NO_STATE
  const { alert, clear, next } = decidePermissionPromptAlert(sig, prev, Date.now(), THRESHOLDS)

  if (next.firstSeenAt === null) watchState.delete(session)
  else watchState.set(session, next)

  if (alert) {
    // The session label is the agent id; a card's assignee may be the id or
    // the display name -- match both. No card (e.g. main session, or an agent
    // with no in_progress card) -> notify only, never fabricate a card.
    const card =
      getInProgressCardForAssignee(label) ?? getInProgressCardForAssignee(readAgentDisplayName(label))
    if (card && !card.requires_approval) {
      updateKanbanCard(card.id, { requires_approval: 1 })
      wdFlagged.set(session, card.id)
    }
    notifyAlert(
      `[CITADEL] ${label} beragadt egy engedély-promptnál${card ? ` ("${card.title}", #${card.id})` : ''} — a tmux session inputra vár, a jóváhagyásodat kéri.`,
    ).catch(() => {})
    logger.warn({ label, session, card: card?.id ?? null }, 'stuck-permission-prompt-watcher: agent wedged at a permission prompt')
  }

  if (clear) clearWatchdogFlag(session)
}

export function startStuckPermissionPromptWatcher(): NodeJS.Timeout {
  function sweep() {
    try {
      checkSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION)
    } catch (err) {
      logger.debug({ err }, 'stuck-permission-prompt-watcher: main agent check error')
    }
    for (const name of listAgentNames()) {
      const session = resolveAgentSession(name)
      if (!isAgentRunning(name)) {
        // Agent went down: end any spell and drop a stale badge we raised.
        watchState.delete(session)
        clearWatchdogFlag(session)
        continue
      }
      try {
        checkSession(name, session)
      } catch (err) {
        logger.debug({ err, agent: name }, 'stuck-permission-prompt-watcher: agent check error')
      }
    }
  }

  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
