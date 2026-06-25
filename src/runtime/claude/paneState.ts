// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 romcsibacsi
// This file is part of citadel (public open-core). See LICENSE.
// A commercial license without AGPL obligations is available — see COMMERCIAL-LICENSE.md (dual-license).
/**
 * PURE Claude Code TUI pane-state heuristics (SPEC §3a readiness classifier).
 *
 * Classification is scoped to the LIVE FOOTER REGION only — never scrollback. A
 * busy/error phrase merely QUOTED in history (an agent talking about "esc to
 * interrupt") must never classify the agent as busy; this was a real source of
 * "permanently stuck" incidents (SPEC §19/§19a). Callers use
 * classifyPaneState(footerRegion(fullCapture), turnActive).
 *
 * The discrete state set (SPEC §3a) is idle / busy / typing / error / unknown.
 * "busy" is TURN-SCOPED: a spinner verb alone is not busy — it is busy only when
 * paired with an active-turn signal on the same line, OR while a submitted turn
 * is still in flight (the adapter's turn counter, passed in as `turnActive`).
 * The safe default is 'busy': an unrecognized footer is never injected into.
 */

import type { AgentBusyState } from '../types.js';

/** Discrete agent pane state (SPEC §3a). */
export type PaneState = 'idle' | 'busy' | 'typing' | 'error' | 'unknown';

const DEFAULT_FOOTER_LINES = 15;

/**
 * An "input affordance" line: the live input box / prompt / status separators
 * that mark the bottom of the TUI. The live footer begins at the LAST such line
 * — everything above it is conversation/scrollback and must not be matched
 * (SPEC §19a: never read a busy/error phrase quoted in history as live state).
 */
const INPUT_AFFORDANCE =
  /(?:╭|╰|│\s*>|^\s*❯|[─]{6,})/u;

/**
 * Extract the LIVE footer region. Within the last `lines` lines, scope from the
 * last input-affordance line (the live input box / status) to the end, so a
 * spinner/error phrase quoted earlier in the visible window is excluded. When
 * no affordance is present (e.g. a pane mid-turn showing only a spinner line),
 * fall back to the whole window. Trailing pane padding is stripped first.
 */
export function footerRegion(paneText: string, lines: number = DEFAULT_FOOTER_LINES): string {
  const all = paneText.replace(/\r/g, '').split('\n');
  let end = all.length;
  while (end > 0 && all[end - 1]!.trim() === '') end--;
  const window = all.slice(Math.max(0, end - lines), end);
  let anchor = -1;
  for (let i = 0; i < window.length; i++) {
    if (INPUT_AFFORDANCE.test(window[i]!)) anchor = i;
  }
  // include one line above the anchor (the box may span a couple of lines)
  const start = anchor >= 0 ? Math.max(0, anchor - 1) : 0;
  return window.slice(start).join('\n');
}

/**
 * An ACTIVE-turn signal on a live line: the interrupt hint, or a spinner glyph
 * whose line carries the live ellipsis "…" (a completed action keeps the glyph
 * but drops the ellipsis: "Brewed for 3s" is NOT active).
 */
const ACTIVE_TURN_MARKERS: RegExp[] = [/esc to interrupt/i, /^\s*[✻✽✶✢✳·∗][^\n]*…/m];

/**
 * Auth/login failure — the agent process is alive but non-functional (escalate).
 * Checked BEFORE the transient class (#86/#87 two-stage): the 'API Error: <status>'
 * banner is identical for every failure, so auth must win first (a 401/auth banner
 * must route to token-refresh, never to a transient retry). Status codes are anchored
 * to the 'API Error:' prefix so a bare number in content can't false-trip them.
 */
const AUTH_ERROR_MARKERS: RegExp[] = [
  /select login method/i,
  /please run \/login/i,
  /invalid x?-?api[ -]?key/i, // "invalid api key" AND "invalid x-api-key" (header form)
  /authentication[ _](failed|error|expired)/i, // covers "authentication_error" (API error type)
  /\/login\b/i,
  /\boauth\b[^\n]{0,40}\b(revoked|expired|failed)\b/i, // oauth revoked/expired/failed (word-anchored, bounded; 'error' dropped — 'no errors' must not match, #86 PROBE)
  /\bAPI Error\b[:\s(]*40[13]\b/i, // 'API Error: 401/403' (code anchored to the banner, not free text) — auth, not transient
];

/**
 * A TRANSIENT API/network error banner (overloaded / 5xx / rate-limit / timeout)
 * shown in the live footer (#86). Distinct from AUTH_ERROR (which needs /login):
 * a transient error usually clears on its own (Claude Code retries in-pane) or via
 * a resume-restart, NOT a re-auth. Deliberately CONSERVATIVE (clear banner phrases
 * only): a missed marker simply falls through to the hub-recovery hard-wedge net
 * (no-progress catch-all), whereas a false positive would mis-classify, so we bias
 * to false-negatives. STARTING set — refineable (ORACLE taxonomy / PROBE adversarial).
 * Matched on the footer region only (never scrollback/user content).
 */
const TRANSIENT_API_MARKERS: RegExp[] = [
  // NB: the bare "API Error" phrase is deliberately NOT here (#87) — that banner is
  // identical for auth failures too, so matching it would mis-route a 401 as transient.
  // Only RETRYABLE signals (Anthropic: 408/409/429/5xx + connection; never 4xx-terminal).
  /\boverload(ed)?\b/i,
  /\brate.?limit(ed|ing)?\b/i,
  /\btry again\b/i,
  /\brequest timed out\b/i,
  /\bconnection (error|reset|refused)\b/i,
  /\bAPI Error\b[:\s(]*(408|409|429|5\d\d)\b/i, // status-coded (code anchored to the banner), retryable codes only
];

/** A modal/choice/permission/trust prompt that blocks until answered. */
const MODAL_MARKERS: RegExp[] = [
  /do you want/i,
  /^\s*❯?\s*1[.)]\s+\S/m, // a numbered choice list
  /\(y\/n\)/i,
  /trust (this )?folder/i,
  /enter to confirm/i,
  /press enter to continue/i,
];

/**
 * The Claude Code end-of-session feedback survey ("How is Claude doing this
 * session?" with a 1/2/3/0 chooser). It is non-actionable for an unattended
 * sub-agent and would wedge it waiting for input, so it is recognized separately
 * and auto-dismissed (FIX-agent-permissions-permissive §4). DISABLE_TELEMETRY in
 * the launch env suppresses it at source; this marker is the runtime safety net.
 */
const SURVEY_MARKERS: RegExp[] = [
  /how is claude doing/i,
  /how is claude working/i,
  /rate (this|your) session/i,
  /how was this session/i,
];

/**
 * The one-time "Bypass Permissions mode" acceptance prompt (FIX-agent-permissions-
 * permissive). A fresh bypass session shows it on launch — current Claude Code does
 * NOT auto-accept it via --dangerously-skip-permissions or bypassPermissionsModeAccepted.
 * It must be ACCEPTED (select "Yes, I accept" → Enter), NEVER Escaped: Esc = "cancel"
 * = exit the agent. Matched on the distinctive option line (not the idle "bypass
 * permissions on" status), so it never confuses the live footer.
 */
const BYPASS_PROMPT_MARKERS: RegExp[] = [/\d[.)]\s*Yes, I accept/i];

/**
 * The interactive question/choice PICKER specifically — Claude Code's AskUserQuestion
 * chooser. Keyed off the chooser-SPECIFIC footer hint ("Enter to select", "… to
 * navigate") which survives footerRegion's last-affordance trim even when the long
 * option list above it does not. Deliberately does NOT include "Esc to cancel": that
 * hint is SHARED with tool-permission prompts ("Enter to confirm · Esc to cancel"),
 * the trust-folder modal, and the bypass prompt — matching it would conflate a
 * benign-to-decline picker with a real permission/trust prompt that must stay
 * alert-only and must NOT be auto-Escaped (Esc there can DENY a tool or EXIT the
 * session). "to navigate" / "Enter to select" appear only on the AskUserQuestion
 * chooser. This is the picker the hub can wedge on with no TTY operator to answer it
 * (FIX-telegram-hub-reply).
 */
const PICKER_MARKERS: RegExp[] = [/\bto navigate\b/i, /\benter to select\b/i];

/**
 * The CONFIRM/TRUST/ACCEPT affordances of a REAL permission gate, where Esc is DANGEROUS (it can DENY a tool
 * or EXIT the session). #361 defense-in-depth: the picker-vs-permission split rests on the boundary assumption
 * that a real permission prompt renders a CONFIRM affordance ("Enter to confirm", a "don't ask again" option,
 * or a trust-folder gate), distinct from the picker's "Enter to select"/"to navigate". A poisoned footer could
 * inject picker hints into a permission prompt to trip the watchdog into auto-Escaping a security gate; these
 * markers establish PERMISSION-PRECEDENCE: when one is present, `picker` is forced false regardless of any
 * picker hint. The attacker can only ADD text to the real Claude UI, never REMOVE the genuine confirm affordance
 * it renders, so the precedence holds against poisoning.
 *
 * These are deliberately the CONFIRM-affordance markers ONLY — NOT the prompt's question text. A bare
 * "Do you want …?" is NOT here (PROBE #361 finding): a legitimate AskUserQuestion picker also asks
 * "Do you want to …?" (e.g. "Do you want to enable telemetry?"), so matching it would force picker=false on a
 * real picker and wedge a sub-agent the #233 watchdog should have recovered. The reliable discriminator is the
 * confirm affordance, not the question — so a picker-nav hint WITHOUT a confirm marker stays picker=true.
 */
const PERMISSION_GATE_MARKERS: RegExp[] = [
  /\btrust\b[^\n]{0,30}\bfolder\b/i, // trust-folder gate, incl. "Do you trust the files in this folder?" (#361 F2)
  /enter to confirm/i, //             the confirm affordance (a real picker uses "Enter to select", not "confirm")
  /don'?t ask again/i, //             the persistent-allow option of a tool-permission prompt
];

/**
 * An idle input prompt. The status line of an idle session shows
 * "? for shortcuts" and/or "← for agents"; in bypass-permissions mode the
 * shortcuts hint is replaced by "⏵⏵ bypass permissions on …". Also the bare
 * input-box '>' prompt.
 */
const IDLE_MARKERS: RegExp[] = [
  /\?\s*for shortcuts/i,
  /for agents\b/i,
  /bypass permissions on/i,
  /^[│|\s]*>\s*$/m,
];

export interface FooterSignals {
  activeTurn: boolean;
  authError: boolean;
  modal: boolean;
  idlePrompt: boolean;
  /** The end-of-session feedback survey (a non-actionable prompt to auto-dismiss). */
  survey: boolean;
  /** The "Bypass Permissions mode" acceptance prompt (auto-ACCEPT, never Escape). */
  bypassPrompt: boolean;
  /**
   * The AskUserQuestion chooser specifically (its "Enter to select … to navigate"
   * hint — NOT the shared "Esc to cancel"). Used by the hub-picker watchdog; does
   * NOT feed classifyPaneState, so pane classification is unchanged
   * (FIX-telegram-hub-reply).
   */
  picker: boolean;
  /**
   * A real permission / trust / persistent-allow gate is present (#361). When true, `picker` is forced
   * false (permission-precedence): a gate must stay alert-only and must NEVER be auto-Escaped, even if the
   * footer also carries a picker hint (poisoned-footer defense-in-depth).
   */
  permission: boolean;
  /**
   * A transient API/network error banner (#86). Like `picker`, it does NOT feed
   * classifyPaneState (the pane stays busy/unknown); it is a SEPARATE signal the
   * supervisor-side hub-recovery watchdog reads to classify a wedge as transient
   * (resume-restart after a grace) vs auth (token refresh) vs hard (catch-all).
   */
  apiTransientError: boolean;
}

/**
 * Extra transient-API markers supplied via config (#86/#87), OR'd with the built-in
 * conservative defaults. Set ONCE at boot from config.hubRecovery.transientMarkers so
 * ORACLE's refined error-banner taxonomy folds in WITHOUT a code change. Empty by default.
 */
let extraTransientMarkers: readonly RegExp[] = [];
export function configureTransientMarkers(sources: readonly string[]): void {
  const compiled: RegExp[] = [];
  for (const s of sources) {
    try {
      compiled.push(new RegExp(s, 'i'));
    } catch {
      /* skip a malformed pattern rather than crash boot */
    }
  }
  extraTransientMarkers = compiled;
}

/** Stateless read of the live footer into raw signals. */
export function readFooterSignals(footer: string): FooterSignals {
  const survey = SURVEY_MARKERS.some((re) => re.test(footer));
  const bypassPrompt = BYPASS_PROMPT_MARKERS.some((re) => re.test(footer));
  // #361 permission-precedence: a real permission/trust/accept gate is present when a CONFIRM affordance
  // (Enter to confirm / don't ask again / trust-folder) or the bypass-accept prompt shows — the unremovable
  // signature of a gate. When present it forces `picker` false below (even under a poisoned picker hint). A
  // bare "Do you want …?" is intentionally NOT a gate marker: a legit picker also asks it (PROBE #361).
  const permission = bypassPrompt || PERMISSION_GATE_MARKERS.some((re) => re.test(footer));
  return {
    activeTurn: ACTIVE_TURN_MARKERS.some((re) => re.test(footer)),
    authError: AUTH_ERROR_MARKERS.some((re) => re.test(footer)),
    // the survey + bypass prompt ARE (numbered) modals — fold them in so they
    // classify as dismissible/answerable prompts rather than 'unknown'.
    modal: survey || bypassPrompt || MODAL_MARKERS.some((re) => re.test(footer)),
    idlePrompt: IDLE_MARKERS.some((re) => re.test(footer)),
    survey,
    bypassPrompt,
    // permission-precedence (#361): picker only when no permission/trust/accept gate co-occurs.
    picker: !permission && PICKER_MARKERS.some((re) => re.test(footer)),
    permission,
    apiTransientError:
      TRANSIENT_API_MARKERS.some((re) => re.test(footer)) || extraTransientMarkers.some((re) => re.test(footer)),
  };
}

/**
 * Combine the stateless footer read with the adapter's turn counter into the
 * discrete state (SPEC §3a). Precedence:
 *   1. auth error  — alive but non-functional (must beat the modal check, since
 *      "Select login method" is itself a numbered chooser);
 *   2. active turn — a spinner+ellipsis or interrupt hint => busy;
 *   3. turn in flight — input was submitted and idle is not yet confirmed =>
 *      typing (turn-scoped busy via the counter, not spinner-word matching);
 *   4. modal       — a choice/permission/trust prompt waits for input => error;
 *   5. idle prompt — the empty input box => idle;
 *   6. nothing recognized => unknown (treated as not-injectable).
 */
export function classifyPaneState(footer: string, turnActive: boolean): PaneState {
  const s = readFooterSignals(footer);
  if (s.authError) return 'error';
  if (s.activeTurn) return 'busy';
  if (turnActive && !s.idlePrompt) return 'typing';
  if (s.modal) return 'error';
  if (s.idlePrompt) return 'idle';
  return 'unknown';
}

/** Whether a footer shows an auth failure specifically (drives reauth escalation). */
export function isAuthError(footer: string): boolean {
  return readFooterSignals(footer).authError;
}

/** Map the discrete pane state onto the delivery-facing AgentBusyState. */
export function paneStateToBusyState(state: PaneState, authError: boolean): AgentBusyState {
  switch (state) {
    case 'idle':
      return 'ready';
    case 'busy':
    case 'typing':
    case 'unknown':
      return 'busy';
    case 'error':
      return authError ? 'reauth-needed' : 'needs-input';
  }
}
