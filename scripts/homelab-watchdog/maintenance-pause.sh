#!/bin/bash
# Homelab maintenance-pause CLI (kártya #4686bb79).
#
# Pause the recovery-watchdog for a container during PLANNED hand maintenance
# (manual cutover / surgery / a deliberate stop), so the deliberate stop is NOT
# mistaken for a crash and does NOT escalate. The update-pipeline does this
# automatically around its recreate; this CLI is for MANUAL maintenance.
#
# The pause auto-expires after its TTL (safety net): if you forget to --resume,
# the watchdog re-enables itself once the TTL passes -- a container is never left
# unwatched forever. Run --resume to end the pause early when the op is done.
#
# Usage:
#   maintenance-pause.sh <container> [ttl_seconds]   # pause (default 1800s = 30min)
#   maintenance-pause.sh --resume <container>        # end the pause early
#   maintenance-pause.sh --list                      # list active pauses + time left

LOG_TAG="homelab-maint"
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

case "${1:-}" in
  --list)
    mkdir -p "$MAINT_DIR"
    found=0
    for f in "$MAINT_DIR"/*; do
      [ -e "$f" ] || continue
      c="$(basename "$f")"
      rem="$(maintenance_remaining "$c")"
      if [ "$rem" -gt 0 ]; then
        printf '%s: %ss left\n' "$c" "$rem"; found=1
      else
        rm -f "$f"   # expired -> tidy up
      fi
    done
    [ "$found" = 0 ] && echo "(no active maintenance pauses)"
    ;;
  --resume)
    [ -z "${2:-}" ] && { echo "usage: $0 --resume <container>"; exit 2; }
    maintenance_clear "$2"
    log "maintenance-pause cleared for $2 (recovery-watchdog re-enabled)"
    ;;
  ''|-h|--help)
    echo "usage: $0 <container> [ttl_seconds] | --resume <container> | --list"
    ;;
  *)
    ttl="${2:-1800}"
    case "$ttl" in *[!0-9]*|'') echo "ttl_seconds must be a positive integer"; exit 2 ;; esac
    maintenance_set "$1" "$ttl"
    log "maintenance-pause set for $1 (${ttl}s) — recovery-watchdog will skip it until then or --resume"
    ;;
esac
