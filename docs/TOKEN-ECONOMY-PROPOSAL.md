# Token-economy: cost observability + cost-modeling (DESIGN PROPOSAL, #222)

Status: **design-first proposal, NOT a build.** Operator question: what do we spend on
tokens monthly, what would it cost in API billing vs the subscription, is a lower plan
enough. Good news: **most of the observability
already exists** — this is mostly modeling/views on top, plus one genuinely-new piece
(per-end-customer attribution). Per-model API prices are ORACLE's (#224); the
tier/pricing math is SIGMA's lane.

---

## 1. Observability — what ALREADY exists (verify-before-build)

We DO record per-agent/per-model token usage today:
- **`CostStore.usage`** (`src/cost/store.ts`) — rolled-up rows keyed
  `(agent, model, day)` → `in_tok, out_tok, cache_tok, source(exact|estimate)`.
  Source = each agent's Claude Code session JSONL, rolled by `src/cost/rollup.ts`.
  Accessors: `byAgent(from,to)`, `byModel(from,to)` over any date range.
- **`TokenUsageStore.token_usage`** (`src/tokens/store.ts`) — per-call detail:
  `agentId, sessionId, ts, inputTokens, outputTokens, cacheRead, cacheCreation, toolName,
  taskTitle, project`. Collected by `src/tokens/collector.ts`.
- **Pricing + API-$ math** (`src/cost/view.ts`) — `DEFAULT_PRICES` (per-model
  input/output per-million; operator-editable in the dashboard) and the cost computation
  (`input incl. cache + output`), already producing a **per-agent estimated $ in API
  mode**. A cost dashboard view is registered (`registerCostDashboard`).

**So elements 1 and most of 3 are effectively done.** The token telemetry + the
API-equivalent-$ math are in place; what's missing is the monthly *framing*, the
subscription comparison, the tier analysis, and the per-end-customer cut.


---

## 2. Gaps vs. the 5 asks

| Ask | Status | Effort |
|---|---|---|
| 1. Per-agent/model observability | **EXISTS** (CostStore + TokenUsageStore) | — |
| 2. Monthly aggregation + view | thin: group the existing daily rows by `month` | low |
| 3. API-equivalent $ vs subscription | API-$ math EXISTS; add the *vs subscription-flat-cost* comparison | low (needs the subscription's flat monthly cost as config) |
| 4. Tier-sufficiency | new readout: monthly usage vs plan tiers (the tier limits/prices are input) | low build, SIGMA does the modeling |

---

## 3. Proposed MVP scope (low effort, high operator value)

**MVP / Phase 0 — monthly cost panel + subscription comparison + tier readout.** All on
top of the EXISTING `CostStore.usage` (already per-agent/model/day) and `cost/view` price
math:
1. **Monthly rollup view**: group the daily rows by `substr(day,1,7)`; show per-month
   total + per-agent + per-model breakdown.
2. **API-equivalent vs subscription**: monthly Σ(tokens × per-model price) = the
   API-billing cost; compare against the subscription's flat monthly cost (a new config
   value) → "subscription saves $X" / "under-utilized by $Y". Directly answers the
   operator's core question.
3. **Tier-sufficiency readout**: monthly usage vs the plan tiers (tier limits/prices as
   input from ORACLE #224 + operator); flag "a lower tier would cover this" when usage sits
   under a cheaper tier's ceiling. The *thresholds/modeling* are SIGMA's (data-analysis).

This MVP is mostly views + a monthly query + two config inputs (subscription flat cost,
tier table). No new telemetry needed — it reuses what's recorded.


---

## 4. Inputs needed + owners

- **ORACLE #224** — validated public per-model API prices (input/output per million); the
  `DEFAULT_PRICES` in `cost/view.ts` are placeholders to confirm.
- **SIGMA** — the cost-modeling math: tier-sufficiency thresholds and the per-end-customer
  pricing/package recommendation (data-analysis, not view-building).
- **Operator** — the subscription's flat monthly cost + which plan tiers exist (for the comparison + tier readout).

> Net: the observability is largely built; #222's real work is a thin monthly +
> subscription-comparison + tier view on the existing data. Recommend approving the Phase-0 MVP now.
