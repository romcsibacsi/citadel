# CITADEL #44 Fázis-2 — per-agent worktree-isolation (DORMANT-PREP)

**Status: DORMANT / NOT LIVE.** Operator (operator) GO-A covers building this prep.
The live HARD-FLIP activation is RESERVED (separate explicit operator-GO + supervised
window). Everything here is inert until the per-layer flags are flipped. Nothing in
this delta changes live behavior on commit/merge; the soaking #336/#233 are untouched.

Branch: `RELAY-44-worktree-isolation-dormant` (L1 + L2 + L3, each its own commit).

## Threat-model (HONEST — this is defense-in-depth, NOT an airtight lock)
The recurring problem is **accidental drift from TRUSTED, same-uid agents**: all
fleet agents run as `uplinkfather`, and one occasionally operates in the SHARED
deploy-checkout (`/home/uplinkfather/fable5-build`) instead of its own worktree
(`agents/<id>/repo`) — editing tracked files, running npm-test, committing there.
That dirties / collides the deploy-checkout and breaks the FF-pull.

This is **NOT** a malicious-bypass scenario. Because every agent is the same uid
(`uplinkfather`), there is **no hard fs-uid lock possible** — uplinkfather can always
chmod back, unset a config, set a marker. A true fs-uid lock would require a separate
deploy-uid owning the repo, which **breaks git-worktree sharing** (linked worktrees
must write the shared `.git/refs` to commit) — rejected as unacceptable cost.

So the model is honest **defense-in-depth**: speed-bump + explicit-override + audit
signal across three independent layers. Do **not** present this to the operator as a
removable-proof lock; present it as drift-prevention for trusted same-uid agents.

## The three layers (each catches a different drift vector)
| Layer | Mechanism | Catches | Flag (per-layer) |
|-------|-----------|---------|------------------|
| **L1** | `.githooks/` guard (pre-commit, pre-push) → abort if op runs in the shared checkout without `CITADEL_DEPLOY=1` | commit/push **pollution** of the deploy history/tree | `citadel.worktree.enforceL1` |
| **L2** | `scripts/citadel-worktree-readonly.sh {apply\|release\|status}` → tracked files read-only (chmod a-w) | uncommitted **file-edit** drift (the actual recurring vector) | `citadel.worktree.enforceL2` |
| **L3** | `scripts/citadel-worktree-drift-check.sh` → read-only detector | residual / **untracked-collision** drift; audit | `citadel.worktree.enforceL3` |

Layers are **independently** flag-gated → the live flip can be **incremental/canary**
(L1, observe; then L2, observe; then L3), not big-bang.

## core.hooksPath / hook-wiring — PRE-EXISTING, NOT a flip step (verified 2026-06-22)
`core.hooksPath = /home/uplinkfather/fable5-build/.githooks` is **pre-existing** in the
deploy-checkout's `.git/config` (set before this work; it drives the pre-existing
`.githooks/commit-msg` hook — the Claude-coauthor-trailer stripper). This delta only ADDS
guard scripts under `.githooks/`; it does NOT touch the hooksPath config.
- So the guard hooks become **WIRED** (run on every commit/push) once the deploy-checkout
  FF-pulls this merge (as of merge, fable5-build had not yet pulled it). But they exit 0
  (no-op) while the flags are off → the wired-but-dormant state is **byte-identical
  behavior** (Q3-verified across all edges; PROBE-gated). So: wired-but-not-enforcing.
- Do **NOT** unset `core.hooksPath` to "un-wire" the guards — that would break the
  commit-msg hook (a real pre-existing dependency). **Dormancy is the FLAG, not the
  hooksPath.** core.hooksPath is therefore **NOT a flip step**.

## Per-layer FLIP (live activation — RESERVED, needs operator-GO + supervised window)
- **L1**: `git config citadel.worktree.enforceL1 true`. Precondition: HARBOR's deploy
  exports `CITADEL_DEPLOY=1` (else the deploy's own git-ops in the shared checkout get
  blocked). L1 only blocks shared-checkout git-ops without the marker.
- **L2**: `git config citadel.worktree.enforceL2 true`, then run
  `scripts/citadel-worktree-readonly.sh apply` once. Precondition: HARBOR wires
  `release` before the FF-pull and `apply` after (the deploy writable-window).
- **L3**: `git config citadel.worktree.enforceL3 true` (turns the detector into a
  pre-deploy/CI gate that exits non-zero on drift). Optional — can stay report-only.

## Per-layer VERIFY (2-polarity — DENY + ALLOW, both proven in isolated mock)
- **L1** (verified): `enforceL1=true` →
  - DENY: git-op in the shared checkout, no marker → exit 1. ✔
  - ALLOW: own agent-worktree op → exit 0; shared checkout WITH `CITADEL_DEPLOY=1` → exit 0; dormant (flag off) → exit 0. ✔
- **L2** (verified): `enforceL2=true` →
  - DENY: `apply` → tracked files read-only → file edit fails EACCES. ✔
  - ALLOW: `release` → writable → edit OK; dormant → apply no-op (edit OK); chmod is git-invisible (0 status change). ✔
- **L3** (verified): clean repo → no drift, exit 0; tracked-mod + untracked-origin/main-collision → both detected; dormant → report exit 0; enforce → exit 1 on drift. ✔
- **CRITICAL deploy-allow canary (HARBOR, pre-flip)**: prove HARBOR's ACTUAL deploy
  runtime (not just the hook logic) passes under enforcement — a real FF-pull +
  redeploy with `CITADEL_DEPLOY=1` (L1) and the `release`/`apply` window (L2). This is
  the top integration risk; do it in canary before the live flip.

## Per-layer ROLLBACK (clean, instant)
- **L1**: `git config citadel.worktree.enforceL1 false` (instant → allow-all). Or remove the hooks from `.githooks/`.
- **L2**: `scripts/citadel-worktree-readonly.sh release` (restore writable) + `git config citadel.worktree.enforceL2 false`.
- **L3**: `git config citadel.worktree.enforceL3 false` (→ report-only) — never gated state.
- Full: delete the three commits / revert the branch; no residual (the dormant delta touched no live state).

## HARBOR integration (deploy-allow side — RELAY leads, HARBOR wires) — VALIDATED 2026-06-22
HARBOR validated the spec against its actual deploy flow (msg 6477→reply). Fit confirmed:
- **L2 is the real integration point — ONE narrow wrap.** HARBOR's deploy's only
  tracked-tree write is `ensure-deploy-main.sh`'s `git checkout -B main origin/main`
  (the FF-pull). Wrap only THAT: `… readonly release` → `ensure-deploy-main.sh` →
  `… readonly apply`, with **`apply` in a TRAP** so it runs even if the deploy fails
  mid-way (else the tree would stay writable). `dist/` + `web/dist` are GITIGNORED
  (build-artifact copy = untracked, OUTSIDE L2 → no window needed); `release-build.sh`
  builds in a SEPARATE worktree (also outside L2).
- **L1 is a harmless NO-OP for HARBOR's current deploy.** The deploy does NOT
  commit/push in the shared checkout (`ensure-main` = fetch / checkout -B / branch -f;
  `release-build` = separate worktree). Since L1 is pre-commit/pre-push, it never fires
  on the deploy. HARBOR exports `CITADEL_DEPLOY=1` defensively (future-proof, harmless),
  but it is NOT load-bearing today.
- **L1 scope clarification (HARBOR question, resolved): L1 stays commit/push.** Git has
  no pre-checkout hook, so a tree-writing op (`git checkout`) cannot be blocked by a
  hook — but it does NOT need to be: **L2's read-only tracked tree already covers it**
  (a stray `git checkout` in the shared checkout fails to write the read-only tracked
  files). So the agent-checkout drift vector is L2's domain, not L1's. No separate hook.
- **CANARY (top integration risk) — flip-time, post-soak, operator-GO.** HARBOR's deploy
  is 2-phase: (i) pre-restart bash (backup → ensure-main FF-pull [= the L2 window] →
  build → dist-verify), (ii) detached restart-unit (restart + post-verify + AUTO-ROLLBACK).
  The canary must prove the FULL cycle under enforcement, INCLUDING the auto-rollback
  path (rollback restores dist.old/web-dist.old = untracked, L2-free, but the whole
  cycle must run clean). HARBOR wires + canary-tests this at flip-prep.

## Incremental flip sequence (recommended, low-risk)
**PRE-FLIP CANARY CHECKLIST (belt-and-suspenders, before ANY flag enable):**
1. On the LIVE deploy-checkout (after it has FF-pulled the merge so the guards are
   actually wired), verify the guard exits 0 across ALL dormant edges — flag unset,
   flag false, not-a-repo, detached-HEAD, config-read-fail — i.e. confirm wired-but-
   dormant is truly inert on the real checkout, not just in the mock.
2. Verify HARBOR's FULL 2-phase deploy (pre-restart bash + detached restart-unit),
   INCLUDING the auto-rollback path, passes under enforcement (the deploy-allow canary).
Then flip incrementally: L1 (flag `enforceL1` + HARBOR `CITADEL_DEPLOY=1` marker) →
observe a deploy cycle → L2 (flag `enforceL2` + HARBOR release/apply window around
ensure-deploy-main + run `apply` once) → observe → L3 (optional `enforceL3` gate).
Each step reversible independently (flag false / `readonly release`). **core.hooksPath
is NOT a step** (pre-existing). Live flip is RESERVED for post-soak operator-GO.
