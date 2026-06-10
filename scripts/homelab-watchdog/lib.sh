#!/bin/bash
# Shared helpers for the homelab-watchdog (recovery + test-gated update).
# Deterministic, no AI. Sourced by recovery-watchdog.sh and update-pipeline.sh.
#
# Conventions:
#  - DRY_RUN=1 (or --dry-run) => never mutate docker, never send a real alert /
#    create a card; just log "[DRY-RUN] would: ...". This is the default-safe mode
#    the operator reviews BEFORE the timer is enabled live.
#  - All secrets come from the install .env (TELEGRAM/NTFY/dashboard token). Never
#    hardcode a token in a script or the config.

set -u

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$INSTALL_DIR/.env"
DASH_TOKEN_FILE="$INSTALL_DIR/store/.dashboard-token"

# DRY_RUN: 1 unless explicitly disabled. Callers flip it off only for a real run.
DRY_RUN="${DRY_RUN:-1}"

_envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [${LOG_TAG:-homelab-watchdog}] $*"; }

# run CMD...  -- execute, or in DRY_RUN just log it. Returns the command exit code
# (0 in dry-run so the caller's control flow proceeds as if it had succeeded).
run() {
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY-RUN] would run: $*"
    return 0
  fi
  "$@"
}

# notify "TITLE" "BODY" [priority]  -- one-way push to ntfy (self-hosted) + Telegram.
# In DRY_RUN it only logs. Failure to notify never aborts the caller.
notify() {
  local title="$1" body="$2" prio="${3:-default}"
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY-RUN] would notify: [$title] $body"
    return 0
  fi
  local ntfy_url ntfy_topic ntfy_token
  ntfy_url="$(_envval NTFY_URL)"; ntfy_topic="$(_envval NTFY_TOPIC)"; ntfy_token="$(_envval NTFY_TOKEN)"
  if [ -n "$ntfy_url" ] && [ -n "$ntfy_topic" ]; then
    curl -fsS -X POST "${ntfy_url%/}/${ntfy_topic}" \
      ${ntfy_token:+-H "Authorization: Bearer ${ntfy_token}"} \
      -H "Title: ${title}" -H "Priority: ${prio}" \
      -d "${body}" >/dev/null 2>&1 || log "WARN: ntfy notify failed"
  fi
  # Best-effort Telegram too (reuses the existing notify.sh path).
  if [ -x "$INSTALL_DIR/scripts/notify.sh" ]; then
    "$INSTALL_DIR/scripts/notify.sh" "🛠️ ${title}: ${body}" >/dev/null 2>&1 || true
  fi
}

# create_kanban_card "TITLE" "DESCRIPTION" [assignee] [priority]
# Posts to the local dashboard API. In DRY_RUN only logs. Best-effort.
create_kanban_card() {
  local title="$1" desc="$2" assignee="${3:-relay}" prio="${4:-high}"
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY-RUN] would create kanban card: '$title' (assignee=$assignee, prio=$prio)"
    return 0
  fi
  [ -f "$DASH_TOKEN_FILE" ] || { log "WARN: no dashboard token, skipping card"; return 0; }
  curl -fsS -X POST "http://localhost:3420/api/kanban" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $(cat "$DASH_TOKEN_FILE")" \
    -d "$(printf '{"title":%s,"description":%s,"status":"planned","assignee":%s,"priority":%s,"project":"Homelab"}' \
         "$(json_str "$title")" "$(json_str "$desc")" "$(json_str "$assignee")" "$(json_str "$prio")")" \
    >/dev/null 2>&1 || log "WARN: kanban card create failed"
}

# Minimal JSON string escaper (quotes + backslashes + newlines).
json_str() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

# Docker state helpers (read-only).
container_exists() { docker inspect "$1" >/dev/null 2>&1; }
container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }
# health: "healthy" | "unhealthy" | "starting" | "none" (no healthcheck defined)
container_health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null; }
