# CITADEL — how it works, and how to verify it's real in 10 minutes

> **For reviewers.** This is a guided, *verifiable* tour. Every claim below points to a file, a commit, or a command
> you can run yourself. Don't take the prose on faith — `git log` and `npm test` are the ground truth.

CITADEL is an **owned, self-improving multi-agent orchestrator**. A **NEXUS** hub directs a fleet of specialist
agents (FORGE/SPARK/SIGMA/PROBE/ORACLE/…) that pick up work from a kanban board; competing solutions are judged
adversarially; the winner is merged through a real **branch → test → review → approve** gate. It runs on the Claude
subscription path (not a metered API), ships with **zero runtime dependencies**, and is covered by a **deterministic
1161-test suite**.

What makes it interesting to an engineering team is the last property: **it improves itself**. The same machinery
the operator uses to delegate work is wired so the system can propose, build, adversarially verify, and **merge its
own code changes** behind a hard safety gate. One such self-authored change is already in this repository's history
(see §2).

---

## How it was built (honest framing)
CITADEL was built and is maintained by a **directed fleet of AI coding agents** operating under the orchestrator's
own gated process — the human role is **architecture, direction, and the approval gate**, not hand-typing every
line. That's the point on display: *orchestrating AI agents to build, verify, and self-improve software.* The
clean-room codebase (zero third-party runtime code), the rigorous test gate, and the self-improvement loop are the
artifacts of that approach. Nothing here is mocked or slideware — every capability below is backed by code you can
read and tests you can run.

---

## 1. Verify it's real (≈10 minutes)
| Step | Command | What it proves |
|---|---|---|
| Real, iterated history | `git log --oneline` | An incremental FIX-*/BUILD-* history (170+ commits) — engineering over time, not a single dump. |
| The suite is green + deterministic | `npm test` | 1161 tests pass; unit run concurrent, integration serialized for determinism (re-run it — same result). |
| Strict typing | `npm run typecheck` | `tsc --noEmit` over backend + web + UI tsconfigs, clean. |
| Zero runtime deps | `cat package.json` | No `dependencies` field — only dev tooling. Persistence is the built-in `node:sqlite`. Nothing third-party ships. |
| Billing-safety is enforced, not promised | `npx tsx --test src/judge/billing.test.ts` | A **static source scan** that fails if any panel code path could reach a metered API — proven by a mutation probe. |

## 2. The self-improvement loop actually ran — here's the receipt
```
git show ad9398d        # "Merge branch 'panel/add-a-parity-guard-test-for-the-/sol-forge'"
```
This merge was produced by the orchestrator's **own gated apply route**, not a human. It ran like this:
1. A task was created; **NEXUS** fanned it out to two solver agents, each on its **own isolated `git worktree`**.
2. Each solver produced a competing solution (a parity-guard test) and committed it on its branch.
3. **PROBE** (an adversarial refuter) and **ORACLE** (a correctness/research judge) independently evaluated both —
   they *ran and mutation-tested* the candidates, not just read them.
4. A **deterministic decision rule** (veto-on-fatal → integer score → stable tie-break) picked the winner.
5. The **gate** ran: branch-isolation check → the real `npm` test suite in the winner's worktree → a final review.
6. On approval, the winner branch was **merged into `main`**. The artifact it authored and shipped is
   [`test/web-i18n-parity.test.ts`](test/web-i18n-parity.test.ts) — now part of the suite you just ran.

Read the engine yourself:
- [`src/judge/service.ts`](src/judge/service.ts) — the loop orchestration (solicit → judge → decide → gate → apply).
- [`src/judge/decisionRule.ts`](src/judge/decisionRule.ts) + [`decisionRule.test.ts`](src/judge/decisionRule.test.ts)
  — the winner-selection is a **pure function of a frozen input snapshot**; the test proves the same inputs always
  replay to the same winner (no nondeterminism, no model "judgment call" in the aggregation).
- [`src/judge/gateRunner.ts`](src/judge/gateRunner.ts) — the real `git worktree` + test gate (with the node_modules
  link so a packaged deploy can actually run the suite).
- [`src/judge/verdictParse.ts`](src/judge/verdictParse.ts) — durable, file-based verdict capture (a TUI has no
  structured return, so the judges write their verdict to a file the orchestrator reads — robust to terminal redraw).

**Why it's safe.** Nothing reaches `applied` without `test = passed` AND `review = passed` AND **operator approve**;
the predicate lives in the apply *route* (not an error-tolerant hook); the test stage is unwaivable; five action
categories (publish, payment, data-delete, permission-change, external-message) are **hard-locked** and can never
self-apply; and the whole loop is billing-clean *by construction* (enforced by the static test in §1).

## 3. Architecture highlights (for the skim)
- **Zero-dependency TypeScript/Node** (ESM, strict), persistence on `node:sqlite`. Brand-neutral, config-driven.
- **First-class agent runtime + reconnecting channel clients** — agents are real interactive sessions on a dedicated
  tmux server (they survive a supervisor restart); Telegram + Discord work inbound *and* outbound.
- **Encrypted vault** (AES-256-GCM/scrypt) for secrets; **an autonomy ladder** with the five hard-locked categories;
  **a 27-view PWA dashboard** (dark + daylight themes, runtime HU/EN, applied before first paint, no framework).
- **Local models & local media** — embedding-based memory search via local **Ollama**; image (SDXL) and video
  (Wan 2.2) generation via a local **ComfyUI** pipeline. No data leaves the box for these.

## 4. Truthful by design (what we deliberately DON'T claim)
Engineering trust comes from honest limits, so the README and code agree on these:
- **Slack**: the outbound client exists, but its Socket-Mode *inbound* is not wired in this build
  (`src/channels/registry.ts` → slack `implemented: false`). We don't pretend it receives.
- **Media generation & semantic memory** require external infra (a GPU + ComfyUI; an Ollama server). Without them
  those features **degrade cleanly** (clear errors / a keyword-search fallback) — they never fake a result.
- We'd rather under-promise. The code and the test suite are the source of truth; the docs are checked against them.

## 5. A curated 10-minute review path
1. `git show ad9398d` — a merge the machine authored.
2. `src/judge/service.ts` + `decisionRule.ts` (+ `.test.ts`) — the self-improvement engine + its determinism proof.
3. `src/judge/gateRunner.ts` + `billing.test.ts` — the real gate + the billing-safety static proof.
4. `src/runtime/` — how agents are launched/driven (interactive, subscription-billed, never a metered API).
5. `npm test` — watch 1161 tests go green.

*Questions or a live walkthrough: reach out to the repository owner.*
