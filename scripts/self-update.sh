#!/usr/bin/env bash
# Self-update (PROMPT-18). Spawned detached by the dashboard once the preflight +
# concurrency gate have passed. Re-asserts the guards (defense in depth),
# fast-forward-only pulls the tracked branch, lock-exact installs deps if the
# lockfile changed (+ a loud-but-non-blocking audit), rebuilds, runs additive
# post-update sync, restores any auto-stash, then restarts the service.
# Brand-neutral: the env vars + service name are passed in by the caller.
# The lock marker (update.lock) is removed on exit via the trap.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
LOG="${SELFUPDATE_LOG:-/tmp/self-update.log}"
LOCK="${LOG%/*}/../update.lock"
AUTOSTASH="${SELFUPDATE_AUTOSTASH:-0}"
SERVICE="${SELFUPDATE_SERVICE:-citadel.service}" # deployment unit; override per install
STASHED=0

cleanup() { rm -f "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT
# take ownership of the marker (pid + start epoch ms)
printf '%s %s' "$$" "$(date +%s%3N)" > "$LOCK" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -Iseconds)" "$*" >> "$LOG" 2>&1; }
log "self-update starting (autostash=$AUTOSTASH)"

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$branch" = "HEAD" ]; then log "refuse: detached HEAD"; exit 1; fi
if [ "$branch" != "main" ]; then log "refuse: not on main ($branch)"; exit 1; fi

if [ "$AUTOSTASH" = "1" ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    if git stash push -m "self-update" >> "$LOG" 2>&1; then STASHED=1; log "stashed local changes"; else log "stash failed; aborting"; exit 1; fi
  fi
fi

OLD="$(git rev-parse --short HEAD)"
if ! git pull --ff-only >> "$LOG" 2>&1; then log "ff-only pull failed"; [ "$STASHED" = "1" ] && git stash pop >> "$LOG" 2>&1; exit 1; fi
NEW="$(git rev-parse --short HEAD)"
if [ "$OLD" = "$NEW" ]; then log "already latest ($NEW); no restart"; [ "$STASHED" = "1" ] && git stash pop >> "$LOG" 2>&1; exit 0; fi
log "pulled $OLD -> $NEW"

if ! git diff --quiet "$OLD" "$NEW" -- package.json package-lock.json; then
  log "deps changed; npm ci (lock-exact)"
  npm ci >> "$LOG" 2>&1 || log "npm ci reported errors (continuing)"
  npm audit --omit=dev --audit-level=high >> "$LOG" 2>&1 || log "AUDIT WARNING: high-severity advisories present (review manually)"
fi

log "rebuilding"
npm run build >> "$LOG" 2>&1 || { log "build failed"; [ "$STASHED" = "1" ] && git stash pop >> "$LOG" 2>&1; exit 1; }

if [ "$STASHED" = "1" ]; then
  if ! git stash pop >> "$LOG" 2>&1; then log "WARNING: stash pop conflicted; entry left recoverable (git stash list)"; fi
fi

log "restarting $SERVICE"
sudo -n systemctl restart "$SERVICE" >> "$LOG" 2>&1 || log "service restart failed (restart manually)"
log "self-update done ($NEW)"
