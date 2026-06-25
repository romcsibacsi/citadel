#!/usr/bin/env bash
# One-command installer (SPEC §23). Idempotent: re-running is safe — it never
# overwrites operator-edited files and never rotates existing secrets.
# Usage: ./scripts/install.sh [--locale hu|en] [--profile <name>] [--yes]
#   --profile kkv-base  installs the trimmed product instance (#104): hub-only roster,
#                       no background learning-loop, FTS-only memory. Omit for the own fleet.
set -euo pipefail

LOCALE=""
PROFILE=""
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --locale) LOCALE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '%s\n' "$*" >&2; }
die()  { printf 'INSTALL FAILED: %s\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say "== Orchestrator installer =="

# --- prerequisites (see docs/PREREQUISITES.*.md) ---
command -v node >/dev/null 2>&1 || die "Node.js >= 22.5 is required. Install: https://nodejs.org or your package manager."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if [[ "$NODE_MAJOR" -lt 22 || ( "$NODE_MAJOR" -eq 22 && "$NODE_MINOR" -lt 5 ) ]]; then
  die "Node.js >= 22.5 required (found $(node --version)). The embedded SQLite (node:sqlite) needs it."
fi
node -e "require('node:sqlite')" >/dev/null 2>&1 || die "this Node build lacks the node:sqlite module; install an official Node >= 22.5 build."
command -v npm  >/dev/null 2>&1 || die "npm is required (ships with Node)."
command -v tmux >/dev/null 2>&1 || die "tmux is required for the interactive agent runtime. Debian/Ubuntu: sudo apt install tmux"
command -v claude >/dev/null 2>&1 || die "the Claude Code CLI is required. Install: npm install -g @anthropic-ai/claude-code — then run 'claude' once and log in with your subscription (OAuth)."
# CLI smoke-test (#104): actually EXECUTE the CLI, not just resolve it on PATH. On a
# Raspberry Pi / ARM box this proves the Node-based CLI runs on this architecture
# before we spend minutes building — a fast fail if the arch/runtime is unsupported.
say "-- smoke-testing the Claude CLI on this machine ($(uname -m))"
claude --version >/dev/null 2>&1 || die "the 'claude' CLI is on PATH but did not run ('claude --version' failed) on $(uname -m). Verify the Claude Code install supports this architecture."

# Subscription-billing protection (SPEC §5/§20.11): refuse on any billing-flipping variable
# (the same denylist as src/core/billing.ts).
for BILLING_VAR in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX; do
  if [[ -n "${!BILLING_VAR:-}" ]]; then
    die "$BILLING_VAR is set in this environment. This system is subscription-billed only — such variables silently switch agents to pay-as-you-go or external billing. Unset it (and remove it from shell profiles) before installing."
  fi
done

# --- locale choice (SPEC §7a: chosen at install; default Hungarian) ---
if [[ -z "$LOCALE" ]]; then
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    LOCALE="hu"
  else
    printf 'Default locale / Alapertelmezett nyelv [hu/en] (default: hu): ' >&2
    read -r LOCALE_INPUT || LOCALE_INPUT=""
    LOCALE="${LOCALE_INPUT:-hu}"
  fi
fi
[[ "$LOCALE" == "hu" || "$LOCALE" == "en" ]] || die "locale must be 'hu' or 'en' (got: $LOCALE)"

say "-- installing dependencies"
npm ci --no-audit --no-fund >&2 || die "npm ci failed — check network access and the npm registry."

say "-- building (typecheck + backend + dashboard)"
npm run typecheck >&2 || die "typecheck failed — the source tree is inconsistent."
npm run build >&2 || die "build failed."

say "-- wiring the git commit-msg hook (strips the Claude/Anthropic co-author trailer)"
# core.hooksPath is LOCAL config (not carried by clone), so a fresh install must set
# it. The hook keeps the GitHub history free of the "… and claude" co-author chip on
# every commit (dev session AND fleet agents). Skipped gracefully for tarball installs
# with no .git. Idempotent + safe — the hook always exits 0 so it can't block a commit.
if git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ -f "$ROOT/.githooks/commit-msg" ]]; then
    chmod +x "$ROOT/.githooks/commit-msg" 2>/dev/null || true
    git -C "$ROOT" config core.hooksPath "$ROOT/.githooks" || say "  (warning: could not set core.hooksPath; set it manually)"
  fi
else
  say "  (not a git checkout — skipping hook wiring)"
fi

say "-- first-run initialization (state dir, secrets, schema, roster scaffold)"
[[ -n "$PROFILE" ]] && say "   applying product profile: $PROFILE"
INIT_ARGS=(--init-only --locale "$LOCALE")
[[ -n "$PROFILE" ]] && INIT_ARGS+=(--profile "$PROFILE")
node --disable-warning=ExperimentalWarning dist/app/main.js "${INIT_ARGS[@]}" || die "initialization failed."

# --- generate the systemd unit from the factory template (FIX-factory-clean §A.4) ---
# The shipped tree carries only deploy/orchestrator.service.template (no personal
# user/paths); here we fill it from the installing user + this directory so the
# real unit is local and never committed.
TEMPLATE="$ROOT/deploy/orchestrator.service.template"
if [[ -f "$TEMPLATE" ]]; then
  say "-- generating the systemd unit (deploy/orchestrator.service)"
  SVC_USER="$(id -un)"
  SVC_GROUP="$(id -gn)"
  NODE_BIN="$(command -v node)"
  GENERATED="$ROOT/deploy/orchestrator.service"
  sed -e "s|__USER__|${SVC_USER}|g" \
      -e "s|__GROUP__|${SVC_GROUP}|g" \
      -e "s|__INSTALL_DIR__|${ROOT}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__NODE__|${NODE_BIN}|g" \
      "$TEMPLATE" > "$GENERATED" || die "could not generate the systemd unit."
  say "   wrote $GENERATED"
fi

say ""
say "== Done =="
# Guard against a SECOND supervisor (#187): if one is already running, `npm start` will
# refuse (single-instance lock) — point the operator at the running one instead of a rival.
if systemctl is-active --quiet citadel.service 2>/dev/null || systemctl is-active --quiet orchestrator.service 2>/dev/null; then
  say "NOTE: a supervisor systemd service is ALREADY active on this host."
  say "  Do NOT also run 'npm start' — a second supervisor is rejected by the single-instance lock."
  say "  Check it with:  systemctl status citadel.service   (or orchestrator.service)"
else
  say "Start the supervisor with:  npm start"
fi
if [[ -f "$ROOT/deploy/orchestrator.service" ]]; then
  say "Or install the generated systemd unit (auto-start on boot):"
  say "  sudo cp $ROOT/deploy/orchestrator.service /etc/systemd/system/orchestrator.service"
  say "  sudo systemctl daemon-reload && sudo systemctl enable --now orchestrator.service"
fi
say "The dashboard bootstrap URL (with the access token) is printed at startup — open it once per device."
