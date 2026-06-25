#!/usr/bin/env bash
#
# CITADEL #44 per-agent-worktree-isolation guard — L1 (git-operations).
#
# WHY: the recurring drift-pattern is trusted same-uid agents (all run as
# the same OS user) operating git-ops in the SHARED deploy-checkout
# ($HOME/fable5-build) instead of their OWN worktree
# (agents/<id>/repo). L1 catches the commit/push variant (an agent committing or
# pushing FROM the shared deploy-checkout -> pollutes the deploy history/tree).
# File-edit drift (uncommitted working-tree mutation, npm-test artifacts) is NOT
# caught here -> that is L2 (read-only tracked-tree toggle). L3 = drift detector.
#
# THREAT-MODEL (be honest): this is defense-in-depth against ACCIDENTAL drift from
# TRUSTED same-uid agents, NOT a malicious-bypass lock. Same-uid means the user
# can always override (unset the config, set the marker). It is a speed-bump +
# explicit-override + audit signal, not a removable hard fs-lock. A true fs-uid lock
# would need a separate deploy-uid owning the repo, which breaks git-worktree sharing
# (linked worktrees must write the shared .git/refs to commit) -> rejected cost.
#
# DORMANT by default: enforces ONLY when  git config --bool citadel.worktree.enforceL1
# == true. Until that flip, this is INERT (exit 0, allow-all) -> committing this hook
# changes NO live behavior. Per-layer flag (L1 independent of L2) -> incremental flip.
#
# DEPLOY path: the deploy process (HARBOR) sets CITADEL_DEPLOY=1 -> always allowed,
# even when enforcing. So the legit deploy git-ops in the shared checkout pass.
#
# SAFETY: dormant -> exit 0 (never wedge). Only exits non-zero when ALL of:
# enforce-flag ON + operation IS in the shared deploy-checkout + NO deploy-marker.
# Agent-worktree ops (toplevel != shared) ALWAYS pass (the intended-allow polarity).
set +e

# Shared deploy-checkout path. Env-overridable ONLY for isolated testing
# (the test-harness points it at a throwaway repo); production = the real path.
SHARED_CHECKOUT="${CITADEL_SHARED_CHECKOUT:-$HOME/fable5-build}"

# (1) DORMANT unless explicitly flipped -> allow-all, never wedge.
enf=$(git config --bool --get citadel.worktree.enforceL1 2>/dev/null)
[ "$enf" = "true" ] || exit 0

# (2) DEPLOY path always allowed (HARBOR sets CITADEL_DEPLOY=1).
[ "$CITADEL_DEPLOY" = "1" ] && exit 0

# (3) Only guard the SHARED deploy-checkout; agent-worktrees are the intended-allow.
top=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$top" ] && [ "$top" = "$SHARED_CHECKOUT" ] || exit 0

# (4) Enforcing + shared deploy-checkout + no deploy-marker -> DENY.
hook=$(basename "$0")
{
  echo ""
  echo "  ┌─ CITADEL #44 worktree-isolation (L1) — git-op BLOCKED ─────────────"
  echo "  │ '$hook' in the SHARED deploy-checkout: $SHARED_CHECKOUT"
  echo "  │ Agents MUST work in their OWN worktree (agents/<id>/repo), not here."
  echo "  │ The shared checkout is the deploy-base only."
  echo "  ├─ deploy process: run with CITADEL_DEPLOY=1 to pass."
  echo "  └─ disable enforcement: git config citadel.worktree.enforceL1 false"
  echo ""
} >&2
exit 1
