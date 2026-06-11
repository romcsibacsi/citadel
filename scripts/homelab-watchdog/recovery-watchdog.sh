#!/bin/bash
# Homelab recovery-watchdog — DETERMINISTIC, no AI (operator's design).
#
# Layer 2 of the 3-layer design (docs/homelab-watchdog-proposal.md):
#   1. Docker's own restart-policy + healthcheck handles most crashes (no AI).
#   2. THIS script (systemd --user timer, every few min): if a MANAGED container
#      is PERSISTENTLY down/unhealthy, deterministically start/up it.
#   3. After N failed recovery attempts it STOPS trying and ESCALATES (ntfy +
#      kanban card) — the AI/RELAY/operator only steps in here, not before.
#
# HARD SAFETY:
#   - Only acts on the MANAGED allowlist (homelab-watchdog.conf). It NEVER starts
#     an intentionally-stopped/.disabled container (just don't list it).
#   - Only `start`/`up` — never a data-losing recreate.
#   - DRY_RUN=1 by default: logs intended actions, mutates nothing, sends no alert.
#     The operator reviews a dry-run BEFORE the live timer is enabled.
#
# Usage:
#   DRY_RUN=1 recovery-watchdog.sh            # default: dry-run (safe)
#   DRY_RUN=0 recovery-watchdog.sh            # live (only after operator GO)
#   recovery-watchdog.sh --dry-run            # force dry-run

LOG_TAG="homelab-recovery"
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

CONF="${HOMELAB_WD_CONF:-$HERE/homelab-watchdog.conf}"
if [ ! -f "$CONF" ]; then
  log "ERROR: config not found: $CONF (copy homelab-watchdog.conf.example and let RELAY fill it)"
  exit 1
fi
# Config provides: MANAGED=(...), declare -A RECOVERY=([name]="cmd"...) (optional overrides),
# CONFIRM_CHECKS, MAX_ATTEMPTS. See homelab-watchdog.conf.example.
declare -A RECOVERY=()
CONFIRM_CHECKS=2
MAX_ATTEMPTS=3
# shellcheck disable=SC1090
source "$CONF"

STATE_DIR="$INSTALL_DIR/store/homelab-watchdog"
mkdir -p "$STATE_DIR"

read_state() { # -> sets DOWN ATTEMPTS ESCALATED
  local f="$STATE_DIR/$1"
  if [ -f "$f" ]; then read -r DOWN ATTEMPTS ESCALATED < "$f"; else DOWN=0; ATTEMPTS=0; ESCALATED=0; fi
  DOWN=${DOWN:-0}; ATTEMPTS=${ATTEMPTS:-0}; ESCALATED=${ESCALATED:-0}
}
write_state() { echo "$2 $3 $4" > "$STATE_DIR/$1"; }

log "run start (DRY_RUN=$DRY_RUN, ${#MANAGED[@]} managed containers)"

for c in "${MANAGED[@]}"; do
  # Maintenance-pause: a PLANNED stop (update-pipeline recreate / manual cutover)
  # set a pause flag -> skip entirely (no start, no escalate). Reset the recovery
  # state so that when the pause ends the container is re-evaluated fresh rather
  # than carrying any pre-maintenance down/attempt count into an instant escalate.
  if maintenance_active "$c"; then
    log "$c under maintenance-pause ($(maintenance_remaining "$c")s left) — skipping (no recovery, no escalate)"
    write_state "$c" 0 0 0
    continue
  fi

  if ! container_exists "$c"; then
    # Not even created -> a stopped compose service. Treat as down (recovery=up).
    health="absent"; down=1
  else
    h="$(container_health "$c")"
    if container_running "$c" && { [ "$h" = "healthy" ] || [ "$h" = "none" ] || [ "$h" = "starting" ]; }; then
      down=0
    else
      down=1
    fi
    health="running=$(container_running "$c" && echo y || echo n),health=$h"
  fi

  read_state "$c"

  if [ "$down" = "0" ]; then
    if [ "$ATTEMPTS" != "0" ] || [ "$DOWN" != "0" ] || [ "$ESCALATED" != "0" ]; then
      log "$c recovered/healthy ($health) -> reset state"
      [ "$ATTEMPTS" != "0" ] && notify "Homelab recovery OK" "$c ismét fut/healthy ($health)" default
    fi
    write_state "$c" 0 0 0
    continue
  fi

  # down / unhealthy
  DOWN=$((DOWN + 1))
  if [ "$DOWN" -lt "$CONFIRM_CHECKS" ]; then
    log "$c down ($health), confirm $DOWN/$CONFIRM_CHECKS — leaving to docker restart-policy"
    write_state "$c" "$DOWN" "$ATTEMPTS" "$ESCALATED"
    continue
  fi

  if [ "$ESCALATED" = "1" ]; then
    log "$c still down ($health) but already escalated — waiting for human"
    write_state "$c" "$DOWN" "$ATTEMPTS" 1
    continue
  fi

  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    log "$c down after $ATTEMPTS attempts -> ESCALATE"
    notify "Homelab watchdog ESZKALÁCIÓ" "$c $MAX_ATTEMPTS sikertelen recovery után is down ($health). Emberi beavatkozás kell." high
    create_kanban_card "Homelab: $c nem jön fel (watchdog eszkaláció)" "A recovery-watchdog $MAX_ATTEMPTS próbára sem hozta vissza a(z) $c konténert ($health). Diagnózis kell (crash-loop / konfighiba). NE pörgesd a restartot." "relay" "high"
    write_state "$c" "$DOWN" "$ATTEMPTS" 1
    continue
  fi

  # attempt recovery
  ATTEMPTS=$((ATTEMPTS + 1))
  write_state "$c" "$DOWN" "$ATTEMPTS" 0
  cmd="${RECOVERY[$c]:-docker start $c}"
  log "$c down ($health) -> recovery attempt $ATTEMPTS/$MAX_ATTEMPTS: $cmd"
  if run bash -c "$cmd"; then
    notify "Homelab recovery" "$c down volt ($health) — recovery indítva (próba $ATTEMPTS/$MAX_ATTEMPTS): $cmd" default
  else
    log "$c recovery command failed (attempt $ATTEMPTS)"
  fi
done

log "run done"
