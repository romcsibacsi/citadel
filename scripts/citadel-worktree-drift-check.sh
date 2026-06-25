#!/usr/bin/env bash
#
# CITADEL #44 per-agent-worktree-isolation — L3 (drift detector backstop).
#
# WHY: L1 catches git-ops, L2 catches tracked-file edits. Neither catches every
# residual (e.g. an UNTRACKED stray a deliberate-override creates, or any drift
# while the flags are still dormant). L3 is a cheap READ-ONLY detector + audit
# signal over the shared deploy-checkout. It does NOT auto-fix (auto-revert is
# risky); it REPORTS, so a human/RELAY cleans deliberately (the recurring manual
# tripwire, formalized). Run on-demand or from a periodic check / pre-deploy gate.
#
# Flags as DRIFT:
#  - any tracked modification (staged or unstaged) in the shared checkout
#  - any UNTRACKED file whose path is TRACKED on origin/main (= FF-pull collision
#    risk: the incoming tracked version would clash with the untracked stray)
# Ignored (known-benign): node_modules, *.png screenshots, *.log.
#
# THREAT-MODEL: accidental drift from trusted same-uid agents. Detector, not lock.
# Per-layer flag: git config citadel.worktree.enforceL3. DORMANT (default/off) =>
# report-only, exit 0 (safe to run anywhere, never gates). enforce=true => exit 1
# when drift found (so a CI / periodic / pre-deploy check FAILS on drift).
#
# usage: citadel-worktree-drift-check.sh   (read-only; prints report)
set -uo pipefail

SHARED="${CITADEL_SHARED_CHECKOUT:-$HOME/fable5-build}"
cd "$SHARED" 2>/dev/null || { echo "L3: no shared checkout at $SHARED"; exit 0; }
enf=$(git config --bool --get citadel.worktree.enforceL3 2>/dev/null)

drift=0
echo "== CITADEL #44 L3 drift-check: $SHARED =="

# (1) tracked modifications (staged + unstaged)
mods=$( { git diff --name-only; git diff --cached --name-only; } 2>/dev/null | sort -u )
if [ -n "$mods" ]; then
  drift=$((drift+1)); echo "  DRIFT: tracked modifications:"; echo "$mods" | sed 's/^/    M /'
fi

# (2) untracked files that COLLIDE with an origin/main-tracked path (FF-pull abort risk)
while IFS= read -r u; do
  [ -z "$u" ] && continue
  case "$u" in */node_modules/*|node_modules/*|*.png|*.log) continue ;; esac
  if git ls-tree -r --name-only origin/main 2>/dev/null | grep -qxF "$u"; then
    drift=$((drift+1)); echo "  DRIFT: untracked stray COLLIDES with origin/main-tracked (FF-pull abort risk): $u"
  fi
done < <(git ls-files --others --exclude-standard 2>/dev/null)

if [ "$drift" = 0 ]; then echo "  CLEAN (no tracked-mods, no colliding untracked strays)."; fi

if [ "$enf" = "true" ] && [ "$drift" != 0 ]; then
  echo "  enforceL3=true + drift -> exit 1 (gate)"; exit 1
fi
echo "  (enforceL3=${enf:-unset}; report-only exit 0)"
exit 0
