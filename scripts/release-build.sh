#!/usr/bin/env bash
# Release build from the AUTHORITATIVE origin/main (#88 build-integrity).
#
# The shared deploy checkout's local main can diverge from origin — e.g. a direct
# operator commit that never went through the #72 PR flow (the db5b4b5 Windows guide),
# or any local-only commit. Building in-place from that mutable checkout risks shipping
# un-reviewed content, and a plain `git pull --ff-only` simply dies on a diverged main.
#
# This helper instead ALWAYS builds from a CLEAN origin/main worktree, so the artifact
# is the reviewed, authoritative state regardless of local divergence. It is strictly
# NON-DESTRUCTIVE and NON-BLOCKING: it never rewrites or blocks the operator's local
# commits — it only WARNS (visibly) if the local main has diverged, then builds from
# origin anyway. The caller (HARBOR release flow) deploys the printed artifact dir.
#
# Output (stdout, last line): the absolute path of the freshly built worktree; its
# build output (e.g. web/dist, dist) is the authoritative artifact. The CALLER removes
# the worktree after deploying:  git worktree remove --force <path>
#
# Env:
#   RELEASE_BRANCH      branch to build (default: main)
#   RELEASE_BUILD_CMD   build command run inside the clean worktree (default: npm run build)
#   RELEASE_REPO_ROOT   the deploy checkout to operate on (default: this script's repo)
#   RELEASE_KEEP        1 = do not auto-remove the worktree on a build failure (debug)
set -uo pipefail

# Operate on the deploy checkout. In production the script lives in that checkout, so
# the default (its own repo root) is correct; RELEASE_REPO_ROOT overrides it (tests).
REPO_ROOT="${RELEASE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_ROOT" || exit 1
BRANCH="${RELEASE_BRANCH:-main}"
BUILD_CMD="${RELEASE_BUILD_CMD:-npm run build}"

log() { printf '[release-build] %s\n' "$*" >&2; }

# refresh the authoritative ref (best-effort; on failure we use the last-known origin)
if ! git fetch origin "$BRANCH" >/dev/null 2>&1; then
  log "WARN: git fetch origin $BRANCH failed; using the last-known origin/$BRANCH"
fi

# (b) NON-BLOCKING divergence warning: local commits NOT on origin/$BRANCH (visibility)
DIVERGENT="$(git rev-list "origin/${BRANCH}..${BRANCH}" 2>/dev/null || true)"
if [ -n "$DIVERGENT" ]; then
  COUNT="$(printf '%s\n' "$DIVERGENT" | grep -c .)"
  log "⚠ DIVERGENCE: local '${BRANCH}' has ${COUNT} commit(s) NOT on origin/${BRANCH}."
  log "  Building from origin/${BRANCH}; these local commits are NOT shipped and NOT modified:"
  git log --no-decorate --format='    %h  %an  %s' "origin/${BRANCH}..${BRANCH}" >&2 || true
  log "  (If these should ship, push them through the PR flow; the build stays authoritative meanwhile.)"
fi

# (a) BUILD-FROM-ORIGIN: a clean, throwaway worktree of origin/$BRANCH
WT="$(mktemp -d "${TMPDIR:-/tmp}/release-build-XXXXXX")"
cleanup() { if [ "${RELEASE_KEEP:-0}" != "1" ]; then git worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WT" 2>/dev/null || true; fi; }
if ! git worktree add --detach "$WT" "origin/${BRANCH}" >/dev/null 2>&1; then
  log "ERROR: could not create a worktree at origin/${BRANCH}"
  rm -rf "$WT" 2>/dev/null || true
  exit 1
fi
BUILT_SHA="$(git -C "$WT" rev-parse --short HEAD 2>/dev/null || echo '?')"
log "building from origin/${BRANCH} @ ${BUILT_SHA}"

# deps: reuse the installed node_modules (same lockfile) so the helper is fast; a
# release flow that wants lock-exact deps can set RELEASE_BUILD_CMD='npm ci && npm run build'.
if [ -d "$REPO_ROOT/node_modules" ] && [ ! -e "$WT/node_modules" ]; then
  ln -s "$REPO_ROOT/node_modules" "$WT/node_modules" 2>/dev/null || true
fi

if ! ( cd "$WT" && eval "$BUILD_CMD" >&2 ); then
  log "ERROR: build failed in the origin/${BRANCH} worktree"
  cleanup
  exit 1
fi

log "build OK from origin/${BRANCH} @ ${BUILT_SHA}; artifact dir follows on stdout (caller deploys + removes it)"
# the ONLY stdout line: the artifact dir for the caller
printf '%s\n' "$WT"
