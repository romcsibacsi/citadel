#!/bin/bash
# Homelab test-gated update-pipeline — FULL-AUTO, the TEST is the gate (operator's
# design: "ha megfelelő tesztek vannak, mehet full auto").
#
# Flow (docs/homelab-watchdog-proposal.md §2):
#   wud detects new version -> THIS script (CONTAINER NEW_TAG):
#     config-backup -> pin new tag -> pull + recreate -> POST-UPDATE SMOKE/HEALTH TEST
#       PASS -> keep,        report ("frissítve X->Y, teszt zöld")
#       FAIL -> AUTO-ROLLBACK to the previous tag + report ("rollback, teszt bukott")
#
# Two lanes (from the config):
#   - FULLAUTO_TEST[c]  -> full-auto with the post-update test as the gate.
#   - MANUAL list       -> NEVER auto-updated; only notify + a kanban card (the risky
#     minority: mailcow, Nextcloud-major, Home Assistant, DB-major).
#
# HARD SAFETY:
#   - DRY_RUN=1 by default: logs intended actions, mutates nothing, no real alert.
#   - mailcow & co. are MANUAL (own update.sh); this pipeline never touches them.
#   - Always backs up config before changing a tag; rollback restores the old tag.
#
# Usage:
#   DRY_RUN=1 update-pipeline.sh radarr 5.3.6     # dry-run (safe, default)
#   DRY_RUN=0 update-pipeline.sh radarr 5.3.6     # live (only after operator GO)

LOG_TAG="homelab-update"
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"

CONTAINER="${1:-}"; NEW_TAG="${2:-}"
[ -z "$CONTAINER" ] && { echo "usage: $0 <container> <new_tag>"; exit 2; }

CONF="${HOMELAB_WD_CONF:-$HERE/homelab-watchdog.conf}"
[ -f "$CONF" ] || { log "ERROR: config not found: $CONF"; exit 1; }
# Config provides: MANUAL=(...), declare -A FULLAUTO_TEST/BACKUP/GET_TAG/SET_TAG/APPLY.
declare -A FULLAUTO_TEST=() BACKUP=() GET_TAG=() SET_TAG=() APPLY=()
MANUAL=()
TEST_RETRIES=6      # poll the smoke test up to N times (container needs time to come up)
TEST_INTERVAL=10    # seconds between test polls
# shellcheck disable=SC1090
source "$CONF"

in_list() { local x="$1"; shift; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }

log "update request: $CONTAINER -> ${NEW_TAG:-<unspecified>} (DRY_RUN=$DRY_RUN)"

# --- notify-then-manual lane ---
if in_list "$CONTAINER" "${MANUAL[@]}"; then
  log "$CONTAINER is on the MANUAL list -> notify only, NO auto-update"
  notify "Homelab update (kézi)" "$CONTAINER új verzió: ${NEW_TAG:-?}. Ez a konténer notify-then-manual (saját frissítési út). Operátori lépés kell." high
  create_kanban_card "Homelab kézi frissítés: $CONTAINER -> ${NEW_TAG:-?}" "Új verzió elérhető. Ez a konténer NEM full-auto (DB-major/Nextcloud-major/HA/mailcow). Frissítsd a saját biztonságos úton (pl. mailcow update.sh)." "relay" "normal"
  exit 0
fi

# --- full-auto lane (test-gated) ---
if [ -z "${FULLAUTO_TEST[$CONTAINER]:-}" ]; then
  log "$CONTAINER has no full-auto post-update test -> treat as manual (safe default)"
  notify "Homelab update (nincs teszt)" "$CONTAINER új verzió: ${NEW_TAG:-?}. Nincs full-auto smoke-teszt definiálva -> kézi frissítés." high
  create_kanban_card "Homelab: $CONTAINER frissítés teszt nélkül" "Új verzió, de nincs full-auto post-update teszt a configban. RELAY: adj tesztet vagy frissítsd kézzel." "relay" "normal"
  exit 0
fi

# 1) current tag (for rollback)
OLD_TAG=""
if [ -n "${GET_TAG[$CONTAINER]:-}" ]; then OLD_TAG="$( [ "$DRY_RUN" = 1 ] && echo "<dry:old>" || eval "${GET_TAG[$CONTAINER]}" )"; fi
log "$CONTAINER current tag: ${OLD_TAG:-<unknown>}"

# 2) backup config (rollback safety net)
if [ -n "${BACKUP[$CONTAINER]:-}" ]; then
  log "backup: ${BACKUP[$CONTAINER]}"; run bash -c "${BACKUP[$CONTAINER]}" || { log "WARN backup failed -> abort (no update without a backup)"; notify "Homelab update abort" "$CONTAINER backup sikertelen, frissítés megszakítva." high; exit 1; }
fi

apply_tag() { # $1 = tag
  local tag="$1"
  if [ -n "${SET_TAG[$CONTAINER]:-}" ]; then TAG="$tag" run bash -c "${SET_TAG[$CONTAINER]}"; fi
  if [ -n "${APPLY[$CONTAINER]:-}" ]; then run bash -c "${APPLY[$CONTAINER]}"; fi
}

smoke_ok() {
  local i
  for ((i=1; i<=TEST_RETRIES; i++)); do
    if [ "$DRY_RUN" = "1" ]; then log "[DRY-RUN] would run smoke test: ${FULLAUTO_TEST[$CONTAINER]}"; return 0; fi
    if eval "${FULLAUTO_TEST[$CONTAINER]}" >/dev/null 2>&1; then return 0; fi
    log "smoke test not green yet ($i/$TEST_RETRIES), waiting ${TEST_INTERVAL}s"; sleep "$TEST_INTERVAL"
  done
  return 1
}

# 3) pin new tag + pull/recreate
log "applying new tag: ${NEW_TAG:-<unspecified>}"
apply_tag "$NEW_TAG"

# 4) post-update test gate
if smoke_ok; then
  log "$CONTAINER smoke test PASS after update ${OLD_TAG:-?}->${NEW_TAG:-?}"
  notify "Homelab frissítve ✅" "$CONTAINER ${OLD_TAG:-?} -> ${NEW_TAG:-?}, post-update teszt ZÖLD." default
else
  log "$CONTAINER smoke test FAIL -> AUTO-ROLLBACK to ${OLD_TAG:-?}"
  if [ -n "$OLD_TAG" ]; then apply_tag "$OLD_TAG"; fi
  notify "Homelab ROLLBACK ⚠️" "$CONTAINER frissítés ${OLD_TAG:-?}->${NEW_TAG:-?} BUKOTT a teszten -> visszaállítva ${OLD_TAG:-?}." high
  create_kanban_card "Homelab rollback: $CONTAINER frissítés bukott" "A(z) $CONTAINER ${OLD_TAG:-?}->${NEW_TAG:-?} frissítés a post-update teszten elbukott, auto-rollback megtörtént. Nézd meg, miért tört a teszt." "relay" "high"
  exit 1
fi
