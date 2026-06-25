# Provider / model abstraction — anti-vendor-lock + fallback (DESIGN PROPOSAL, #223)

Status: **design-first proposal, NOT a build.** Business-continuity risk raised by the
operator: the fleet is strongly Anthropic-pinned; if a model is retired on short notice
(e.g. a 2-day Fable deprecation) we are exposed. This doc maps where the pin lives,
proposes a provider-abstraction with model-fallback, and surfaces the **operator
decision points** — above all the auth/cost-model clash. Provider-landscape +
deprecation-risk data is ORACLE's research (#C); this is the architecture.

---

## 1. Where the model/provider pin lives today

The system is pinned at **two very different depths** — conflating them is the main trap.

### 1a. The MODEL string (shallow, easy to vary)
- `config.agents[].model` — a per-agent model id or alias (e.g. `claude-opus-4-8[1m]`,
  `claude-sonnet-4-6`). Set per agent (#198 tiering).
- `config.modelAliases` — `alias → model-id` map (`default`/`fast`/`deep` + identity entries).
- `src/app/specFactory.ts:39` — resolves `modelAliases[agent.model] ?? agent.model` and
  passes it as the `--model <id>` launch-arg to the Claude Code CLI.
- `src/cost/view.ts` — a per-model price map (for the cost rollup only).

Varying the model string **within Anthropic** (opus/sonnet/haiku/fable) is already routine
and costs nothing — it is just a different `--model`.

### 1b. The RUNTIME + auth (deep, the real lock)
- **The runtime IS the Claude Code CLI.** Every interactive agent is a `claude` process in
  a tmux pane (`ClaudeCodeAdapter`). Session continuity, the watch/inject streams, the
  operator attach, the permission model — all are Claude-Code-TUI features. This is the
  deepest pin: the agents are not "an LLM behind an interface", they are Claude Code.
- **Auth = subscription-OAuth (default).** The operator logs into `claude` once; agents
  share that subscription (the flat-rate "pool"). No API key anywhere.
- **The subscription-billing invariant (SPEC §5).** `BILLING_ENV_DENYLIST` =
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
  `CLAUDE_CODE_USE_VERTEX` — stripped at boot AND at every launch (`adapter.start`). Any of
  these flips the TUI from flat-rate subscription to metered/external billing. This is the
  invariant the card says NOT to break.

### 1c. The seam that ALREADY exists (the foundation of this proposal)
The adapter already supports **three** provider/billing modes via env injection at launch:
| Mode | Mechanism | Billing | Gating |
|---|---|---|---|
| **subscription** (default) | nothing injected; OAuth pool | flat-rate | the invariant (denylist strip) |
| **ollama / local-model** (`agent.runtime:'ollama'`) | `ANTHROPIC_BASE_URL` = private ollama URL + dummy `ANTHROPIC_AUTH_TOKEN` | free (local) | PRIVATE-endpoint only: sync `isPrivateBaseUrl` + async resolve-and-refuse; never a public IP/cloud FQDN |
| **api** (`billing.mode:'api'`) | `ANTHROPIC_API_KEY` from vault | pay-as-you-go | deliberate opt-in only |

**`ANTHROPIC_BASE_URL` is the provider-redirection point.** The Claude CLI talks to
whatever Anthropic-API-shaped endpoint it points at. The ollama path proves the seam works
today. An **Anthropic-compatible aggregator** (LiteLLM / a cloud proxy / Bedrock-Vertex
fronts) can therefore back OpenAI/Google/etc behind the same mechanism — **but it needs a
real key → metered billing → the invariant clash (§3).**

---

## 2. Two fallback SCOPES — keep them separate

The operator's stated risk ("a model is retired in 2 days") and "anti-vendor-lock" are
**different problems** with very different cost.

### Scope A — within-Anthropic model fallback (cheap, subscription-safe)
If a model id becomes unavailable, fall back to ANOTHER Anthropic model
(`fable → opus → sonnet → haiku`). Config-level, **no auth change, stays on the
subscription pool, never touches the invariant.** This directly mitigates the "Fable in 2
days" risk. **High ROI, low risk — recommended first.**

### Scope B — cross-provider fallback (true anti-vendor-lock, operator-gated)
Run an agent on OpenAI / Google / local / an aggregator when Anthropic (or a specific
model) is unavailable. Every path here needs a non-subscription auth → **cost-model change
= operator decision.** Three sub-paths, increasing cost/effort:
- **B1 — aggregator via `ANTHROPIC_BASE_URL`.** Point the existing seam at an
  Anthropic-API-compatible aggregator that fronts other providers. **Reuses the adapter
  unchanged** (same redirection as ollama) + the private-endpoint gating if self-hosted.
  Needs the aggregator's API key → metered. *Lowest-effort cross-provider path.*
- **B2 — Bedrock / Vertex.** Anthropic models via AWS/GCP (`CLAUDE_CODE_USE_BEDROCK/VERTEX`,
  currently on the denylist). Diversifies the *delivery* of Anthropic models (helps if
  Anthropic's direct API is down) but NOT a model deprecation. Metered/cloud-billed.
- **B3 — native multi-runtime (non-TUI SDK agents).** A parallel runtime calling provider
  SDKs directly. **Largest change by far** — it forgoes the entire Claude-Code-TUI agent
  model (sessions, attach, watch/inject, permissions). A different product, not a config
  flip. *Defer unless the operator wants non-Anthropic as a PRIMARY runtime.*

---

## 3. The critical invariant clash (auth + cost) — the operator's call

| | Stays as-is | Would change |
|---|---|---|
| **Auth** | subscription-OAuth pool (default, the interactive fleet) | API keys / aggregator keys for any Scope-B path |
| **Billing** | flat-rate subscription | metered pay-as-you-go (B1/B2) or cloud bill |
| **Invariant** | denylist strip intact; agents never see a key | the key is injected ONLY for the opted-in agent/scenario (the existing `billing.mode:'api'` path already does this safely) |

**What MUST stay on subscription:** the steady-state interactive fleet — the
subscription-pool invariant is preserved in every phase below. Scope B is an
**opt-in / emergency-fallback** mode, never the default.

**Operator decision points (this proposal does not pre-decide them):**
1. Provision a fallback provider at all? (cost commitment + a metered key in the vault.)
2. WHICH agents/scenarios may fall back to a metered provider, and WHEN (only when the
   subscription is unreachable? a per-agent opt-in? a global emergency switch?).
3. Accept a non-Anthropic provider's quality/safety/format differences for the affected work.
4. For B1: self-host the aggregator (private-endpoint gate applies) vs a SaaS aggregator
   (a public endpoint — needs an explicit, audited carve-out in the SSRF/billing gates).

---

## 4. Recommended gradual path (each phase shippable + reversible)

- **Phase 0 — within-Anthropic model-fallback chain (Scope A). DO FIRST.**
  Add an ordered fallback list to the model config (e.g. `agent.model` resolves to a primary
  + a fallback chain, or `modelAliases` entries gain a `fallbacks: []`). On a launch error
  that is *model-unavailable* (not auth/network), the adapter retries with the next model in
  the chain and alerts the operator. **No auth/cost change, subscription-only, ~a focused
  change in specFactory + the adapter's launch-error handling.** Mitigates the stated
  "Fable 2-day" risk now. Build + PROBE-gate when approved.

- **Phase 1 — provider-abstraction config schema (dormant).**
  A `providers` config concept: `provider-id → { kind: subscription | anthropic-api |
  aggregator | ollama | bedrock | vertex, baseUrl?, authRef?, models[] }`, and
  `agent.model → (provider, model)` resolution. The adapter ALREADY has the three injection
  modes; this is mostly a config + thin resolver on top, **DORMANT-default** (no behavior
  change until an operator enables a non-default provider). Reuses the ollama
  private-endpoint gating + the `billing.mode:'api'` opt-in unchanged.

- **Phase 2 — aggregator fallback (Scope B1, operator-gated).**
  Wire one Anthropic-compatible aggregator as a FALLBACK provider behind `ANTHROPIC_BASE_URL`
  + a vault key, used only on the emergency/opt-in path from Phase 0. Metered, opt-in,
  PROBE-gated (SSRF/private-endpoint + the billing invariant). Operator provisions the
  aggregator + key.

- **Phase 3 — native multi-runtime (B3). OPTIONAL, LARGE, DEFER.**
  Only if the operator wants non-Anthropic as a primary runtime. Scoped separately.

**The local-model (ollama) path is the existing proof** that Phases 1–2 are mechanically
feasible without breaking the invariant — it already redirects the runtime to a non-Anthropic
endpoint under strict gating.

---

## 5. Risk / cost summary

| Path | Effort | Cost change | Invariant risk | Mitigates |
|---|---|---|---|---|
| Phase 0 (within-Anthropic fallback) | low | none (subscription) | none | a single model's deprecation/outage |
| Phase 1 (config schema, dormant) | low-med | none until enabled | none (dormant) | enables B without committing |
| Phase 2 (aggregator fallback) | med | metered when used | gated opt-in (like ollama/api today) | Anthropic-wide outage; some vendor-lock |
| Phase 3 (native multi-runtime) | high | metered + new runtime | large (new agent model) | full anti-vendor-lock |

**Recommendation:** approve **Phase 0 now** (it removes the acute risk cheaply and safely),
land **Phase 1** as a dormant schema so the rest is a config flip, and treat **Phase 2** as
an operator-gated business-continuity option informed by ORACLE's provider/deprecation
research (#C). Phase 3 only on an explicit operator strategy decision.

> Open inputs needed before building beyond Phase 0: ORACLE #C (which aggregators are
> genuinely Anthropic-API-compatible + their reliability; per-provider deprecation history;
> realistic metered cost), and the operator's answers to the §3 decision points.
