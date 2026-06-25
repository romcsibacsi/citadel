#!/usr/bin/env bash
#
# CITADEL #44 per-agent-worktree-isolation — L2 (read-only tracked-tree toggle).
#
# WHY: L1 (.githooks guard) only catches git-OPERATIONS (commit/push) in the shared
# deploy-checkout. It does NOT catch the actual recurring drift vector: an agent
# EDITING tracked files in the shared checkout (uncommitted working-tree mutation,
# e.g. forge editing scripts/agentctl during a stray npm-test run). L2 blocks that
# by making the shared checkout's TRACKED files read-only (chmod a-w). An accidental
# edit then fails with EACCES -> a clear "wrong checkout, use your own worktree"
# signal. The deploy process RELEASEs (writable) before the FF-pull, then re-APPLYs.
#
# git-INVISIBLE: git tracks only the +x bit, not write perms; `chmod a-w` leaves +x
# untouched -> applying read-only creates NO git-status change (working tree stays
# clean re: git). Untracked-file CREATION (node_modules, stray tests) is NOT blocked
# here (dir-read-only would break git) -> that residual is covered by L3 (detector)
# + the deploy's pre-pull stray-clean.
#
# THREAT-MODEL: accidental drift from trusted same-uid agents (all one OS user),
# NOT a malicious lock. Same-uid: that user can chmod back -> deliberate override,
# not accidental. Defense-in-depth speed-bump + signal, not a removable hard lock.
#
# DORMANT: `apply` is a NO-OP unless  git config citadel.worktree.enforceL2=true
# (default off). Committing this script changes NO live behavior; the flip wires the
# deploy to call release/apply + sets the flag + runs `apply` once. Per-layer flag
# (independent of L1) -> incremental canary flip. `release` always restores writable
# (a deploy must never be wedged read-only).
#
# usage: citadel-worktree-readonly.sh {apply|release|status}
#   apply   - enforce read-only on tracked files (no-op when dormant)
#   release - restore tracked files writable (deploy window; always allowed)
#   status  - report enforceL2 flag + sampled read-only state
set -uo pipefail

SHARED="${CITADEL_SHARED_CHECKOUT:-$HOME/fable5-build}"
mode="${1:-status}"

cd "$SHARED" 2>/dev/null || { echo "L2: no shared checkout at $SHARED -> no-op" >&2; exit 0; }
enf=$(git config --bool --get citadel.worktree.enforceL2 2>/dev/null)

case "$mode" in
  apply)
    if [ "$enf" != "true" ]; then echo "L2 DORMANT (enforceL2!=true) -> apply no-op"; exit 0; fi
    git ls-files -z | xargs -0 -r chmod a-w 2>/dev/null
    echo "L2 APPLIED: tracked files read-only in $SHARED" ;;
  release)
    git ls-files -z | xargs -0 -r chmod u+w 2>/dev/null
    echo "L2 RELEASED: tracked files writable in $SHARED (deploy window)" ;;
  status)
    n=0; ro=0
    while IFS= read -r f; do n=$((n+1)); [ -w "$f" ] || ro=$((ro+1)); [ "$n" -ge 200 ] && break; done < <(git ls-files)
    echo "L2 enforceL2=${enf:-unset} ; read-only tracked files: $ro / $n sampled" ;;
  *) echo "usage: $0 {apply|release|status}" >&2; exit 2 ;;
esac
