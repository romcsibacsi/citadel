#!/bin/bash
# wud -> update-pipeline BRIDGE, with a TAG-SAFETY GUARD (RELAY owns the wud wiring).
#
# wud can't exec host scripts, so this polls wud's API (the deterministic equivalent of
# "on-new-version"): for each container wud flags updateAvailable, it decides the lane.
#
# THE GUARD (why it exists): wud's candidate tag is often a MAJOR/variant jump or an
# outright mis-match (e.g. redis 7-alpine -> 32bit-stretch, mariadb -> 13.0-ubi10-rc,
# forgejo 12 -> 15-rootless). A post-update HTTP smoke test can PASS while such a change
# functionally breaks the service ("healthy != working"). So:
#   AUTO (forward to update-pipeline.sh, test-gated) ONLY IF ALL of:
#     - container is in FULLAUTO_TEST, AND
#     - it has a COMPLETE apply chain (GET_TAG + SET_TAG + APPLY), AND
#     - the tag change is SAME major AND SAME variant-suffix (patch/minor only).
#   Everything else (major/variant jump, mis-match, MANUAL, no apply chain) -> NOTIFY + a
#   kanban card (deduped), NEVER auto-applied.
#
# DRY_RUN=1 by default (logs, mutates nothing, no real alert). Live only after operator GO.

LOG_TAG="homelab-update-watch"
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/lib.sh"
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

CONF="${HOMELAB_WD_CONF:-$HERE/homelab-watchdog.conf}"
[ -f "$CONF" ] || { log "ERROR: config not found: $CONF"; exit 1; }
declare -A FULLAUTO_TEST=() GET_TAG=() SET_TAG=() APPLY=()
MANUAL=()
# shellcheck disable=SC1090
source "$CONF"

WUD_API="${WUD_API:-http://192.168.1.105:8099/api/containers}"
SEEN_DIR="$INSTALL_DIR/store/homelab-watchdog/seen-updates"
mkdir -p "$SEEN_DIR"

# classify: emits "name<TAB>cur<TAB>cand<TAB>same_major_variant(0/1)" per updateAvailable.
classify() {
python3 - "$WUD_API" <<'PY'
import json,sys,re,urllib.request
api=sys.argv[1]
try:
    data=json.load(urllib.request.urlopen(api,timeout=8))
except Exception as e:
    sys.stderr.write("wud api error: %s\n"%e); sys.exit(0)
def parts(tag):
    t = tag or ''
    if re.match(r'^v\d', t): t = t[1:]           # strip leading 'v' (v2.63.2 -> 2.63.2)
    m=re.match(r'^(\d+)(?:\.\d+)?(?:\.\d+)?(.*)$', t)
    if not m: return (None, tag or '')          # non-numeric tag (e.g. "stable","latest")
    return (m.group(1), m.group(2) or '')        # (major, variant-suffix)
for c in data:
    if not c.get("updateAvailable"): continue
    name=c.get("name","")
    cur=((c.get("image") or {}).get("tag") or {}).get("value","")
    cand=(c.get("result") or {}).get("tag","")
    cmaj,cvar=parts(cur); nmaj,nvar=parts(cand)
    same = 1 if (cmaj is not None and nmaj is not None and cmaj==nmaj and cvar==nvar) else 0
    print("%s\t%s\t%s\t%d" % (name,cur,cand,same))
PY
}

has_chain() { [ -n "${GET_TAG[$1]:-}" ] && [ -n "${SET_TAG[$1]:-}" ] && [ -n "${APPLY[$1]:-}" ]; }
in_manual() { local x="$1" e; for e in "${MANUAL[@]}"; do [ "$e" = "$x" ] && return 0; done; return 1; }

log "watch start (DRY_RUN=$DRY_RUN, wud=$WUD_API)"
auto=0; notified=0
while IFS=$'\t' read -r name cur cand same; do
  [ -z "$name" ] && continue
  # skip docker name-collision zombies (hex_-prefixed)
  case "$name" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]_*) log "skip zombie $name"; continue;; esac

  # Out of BOTH lists (mailcow self-updates, unmanaged containers) -> wud's own ntfy covers
  # it; skip to avoid a card storm.
  if [ -z "${FULLAUTO_TEST[$name]:-}" ] && ! in_manual "$name"; then
    log "$name $cur->$cand: unmanaged (wud ntfy covers it) — skip"
    continue
  fi

  # MANUAL list -> notify + card (deduped), NEVER auto-updated (own/safe update path).
  if in_manual "$name"; then
    seen="$SEEN_DIR/${name}@${cand}"
    if [ -f "$seen" ]; then log "$name $cur->$cand: MANUAL — már jelezve, kihagyom"; continue; fi
    log "$name $cur->$cand: MANUAL -> notify+card (nincs auto-csere)"
    notify "Homelab kézi frissítés" "$name: $cur -> $cand. MANUAL lista (saját/biztonságos frissítési út). NEM auto-frissül." default
    create_kanban_card "Homelab kézi frissítés: $name $cur->$cand" "wud új verziót jelez. Ez MANUAL (mailcow saját update.sh / Nextcloud-major occ / HA / DB-major adatformátum) — automatikus csere NÉLKÜL. Frissítsd a biztonságos úton. (Megj.: a wud jelölt-tag hibás match is lehet, pl. redis->32bit-stretch — előbb ellenőrizd/pinneld.)" "relay" "normal"
    [ "$DRY_RUN" = "1" ] || echo "$(date '+%F %T')" > "$seen"
    notified=$((notified+1))
    continue
  fi

  if has_chain "$name" && [ "$same" = "1" ]; then
    log "$name $cur->$cand: SAME major+variant + full-auto chain -> test-gated update"
    DRY_RUN="$DRY_RUN" "$HERE/update-pipeline.sh" "$name" "$cand"
    auto=$((auto+1))
    continue
  fi

  # In the full-auto list but the guard BLOCKED it (major/variant jump or no apply chain).
  # This is the actionable signal -> notify + card ONCE per (name,cand).
  if [ "$same" != "1" ]; then reason="major/variant ugrás (a smoke-teszt nem fogná a törést)"
  else reason="nincs teljes apply-lánc a configban"; fi
  seen="$SEEN_DIR/${name}@${cand}"
  if [ -f "$seen" ]; then
    log "$name $cur->$cand: full-auto BLOCKED ($reason) — már jelezve, kihagyom"
    continue
  fi
  log "$name $cur->$cand: full-auto BLOCKED ($reason) -> notify+card"
  notify "Homelab full-auto frissítés blokkolva" "$name: $cur -> $cand. A tag-safety guard blokkolta: $reason. NEM auto-frissült — kézi review kell." default
  create_kanban_card "Homelab full-auto blokkolt: $name $cur->$cand" "wud új verziót jelez egy FULL-AUTO konténerre, de a tag-safety guard blokkolta: $reason. Frissítsd kézzel a config-megőrző workflow szerint, vagy igazítsd a wud includeTags-et hogy biztonságos (azonos-major) jelölt jöjjön." "relay" "normal"
  [ "$DRY_RUN" = "1" ] || echo "$(date '+%F %T')" > "$seen"
  notified=$((notified+1))
done < <(classify)

log "watch done (auto-update=$auto, manual-notify=$notified)"
