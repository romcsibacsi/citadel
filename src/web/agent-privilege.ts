// Agent-spawn privilege gate — the hard security invariant of CITADEL.
//
// Rules (in priority order), enforced by evaluateSpawn():
//   1. Only the orchestrator (the main agent, NEXUS) may request a programmatic
//      spawn. Any other requester is denied outright — a sub-agent can never
//      spawn, and (because from_agent is untrusted and sanitized + trust-checked
//      upstream in the message router) it can never forge itself as the main
//      agent to get here.
//   2. No spawn may EVER create an agent more privileged than the hard ceiling
//      (HARD_CEILING_PRIV). Profiles above it (e.g. homelab-full, or the main
//      orchestrator itself) can only exist as the pre-seeded base roster, never
//      as a spawned child. This is absolute — not even human approval lifts it.
//   3. No self-escalation: a requester may never create a child more privileged
//      than itself.
//   4. Anything above the sandbox cap (AUTO_APPROVE_MAX_PRIV) but at/under the
//      ceiling requires explicit human approval before it is materialized.
//   5. The dashboard path is the human operator acting directly, so it is the
//      approval — it may create up to the hard ceiling without a second step,
//      but rule 2 (the ceiling) still applies even to the operator via the API.
//
// This module is PURE (no I/O, no config import) so the invariant is exhaustively
// unit-testable. Callers pass the main agent id and the profile→privilege map.

export type Privilege = number

// Privilege ranking of security profiles. Higher = more powerful.
//   0 = sandbox (internal sub-agents, junior dev) — auto-spawnable
//   1 = draft/read-only (researcher, marketer, data-analyst)
//   2 = trusted build (developer-senior)            — the hard ceiling for spawns
//   3 = full host control (homelab-full)            — base roster ONLY, never spawned
export const PROFILE_PRIVILEGE: Record<string, Privilege> = {
  internal: 0,
  'developer-junior': 0,
  researcher: 1,
  marketer: 1,
  'data-analyst': 1,
  default: 1,
  'developer-senior': 2,
  'homelab-full': 3,
}

// Highest privilege a spawn may receive WITHOUT human approval.
export const AUTO_APPROVE_MAX_PRIV: Privilege = 0
// Absolute ceiling: nothing more privileged than this can be spawned at all,
// even with human approval. (homelab-full=3 and the main orchestrator are above
// it, so they can never be created via the spawn path.)
export const HARD_CEILING_PRIV: Privilege = 2

export function profilePrivilege(profile: string): Privilege | undefined {
  return PROFILE_PRIVILEGE[profile]
}

export interface SpawnRequest {
  // The agent requesting the spawn (its sanitized id). Ignored when viaDashboard.
  requester: string
  // The security profile the new agent would receive.
  requestedProfile: string
  // True when the request comes from the dashboard UI (the human operator acting
  // directly). False for a programmatic request initiated by an agent (NEXUS).
  viaDashboard: boolean
}

export interface SpawnContext {
  mainAgentId: string
  // The requester's own profile, used to enforce no-self-escalation for
  // programmatic spawns. Optional; when omitted the main agent is treated as
  // having the hard ceiling privilege (it is the orchestrator).
  requesterProfile?: string
}

export interface SpawnDecision {
  allowed: boolean // may it be created right now (no further step)?
  requiresApproval: boolean // must a human approve before creation?
  reason: string
}

const deny = (reason: string): SpawnDecision => ({ allowed: false, requiresApproval: false, reason })

export function evaluateSpawn(req: SpawnRequest, ctx: SpawnContext): SpawnDecision {
  const priv = profilePrivilege(req.requestedProfile)
  if (priv === undefined) return deny(`unknown security profile: ${req.requestedProfile}`)

  // Rule 2 — hard ceiling, absolute (applies to every path, even the operator).
  if (priv > HARD_CEILING_PRIV) {
    return deny(`profile '${req.requestedProfile}' exceeds the hard spawn ceiling and can never be spawned`)
  }

  if (req.viaDashboard) {
    // Rule 5 — the operator is present; this is the approval.
    return { allowed: true, requiresApproval: false, reason: 'operator-initiated (dashboard)' }
  }

  // Programmatic path (agent-initiated).
  // Rule 1 — only the orchestrator may spawn.
  if (req.requester !== ctx.mainAgentId) {
    return deny('only the orchestrator may spawn agents')
  }

  // Rule 3 — no self-escalation: child may not exceed the requester's privilege.
  // The orchestrator is treated as the hard ceiling when its profile is unknown.
  const requesterPriv = ctx.requesterProfile !== undefined
    ? profilePrivilege(ctx.requesterProfile) ?? -1
    : HARD_CEILING_PRIV
  if (priv > requesterPriv) {
    return deny('an agent cannot create a child more privileged than itself')
  }

  // Rule 4 — above the sandbox cap requires human approval.
  if (priv > AUTO_APPROVE_MAX_PRIV) {
    return { allowed: false, requiresApproval: true, reason: 'above sandbox cap — requires human approval' }
  }

  return { allowed: true, requiresApproval: false, reason: 'within sandbox cap' }
}
