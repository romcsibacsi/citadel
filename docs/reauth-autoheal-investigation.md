# Re-auth `/login` auto-heal — investigation & verdict (FIX-reauth-autoheal)

## Összefoglaló (HU)

**Verdikt: B (a per-agent automatikus `/login` a ROSSZ eszköz) — a mai flottára gyakorlatilag C/host-szintű.**
A per-agent auto-`/login` nem tudja BEFEJEZNI az előfizetéses OAuth-ot: élő próbán a `/login` egy böngészős
OAuth-URL-t + „paste code" lépést mutat, amihez EMBER kell (a bot legfeljebb a metódust választja ki, ott elakad).
Ráadásul egy shared-subscription agent paneljében a `/login` BEFEJEZÉSE leválasztja (decouple) a megosztott
symlinket → pont azt a hibát okozza, ami a 13-agent incidenst. **Mind a 15 élő agent shared-subscription** (0
own-team, 0 api), tehát az in-pane `/login` ma egyetlen agentnek sem helyes. A helyes megoldás host-szintű, és
nagyrészt MÁR megépült (auth-broker: önjavító symlink-sweep + proaktív host-token-refresh + egy-host-reauth).
**DE egy kritikus, élőben igazolt defekt van:** a broker OAuth token-végpontja rossz
(`console.anthropic.com` → 429, nem frissít); a valódi végpont `https://claude.ai/v1/oauth/token` (400
`invalid_grant`). Ezt ebben a fázisban KIJAVÍTOTTAM. A maradék két ajánlott lépés (operátori egy-kattintásos host
`/login` assist; az `adapter.ts:387` authMode-gating az own-team hibrid előfeltételeként) operátori jóváhagyásra vár.

## Summary (EN)

**Verdict: B (per-agent auto-`/login` is the WRONG tool) — effectively C/host-level for today's fleet.**
Per-agent auto-`/login` cannot COMPLETE subscription OAuth — a live probe shows `/login` reaches a browser OAuth URL
+ "paste code" step that a HUMAN must do (a bot can at most pick the method, then stalls). Worse, COMPLETING `/login`
in a shared-subscription agent's pane DECOUPLES the shared symlink — the exact failure behind the 13-agent incident.
**All 15 live agents are shared-subscription** (0 own-team, 0 api), so in-pane `/login` is correct for none of them
today. The right solution is host-level and is largely ALREADY built (the auth-broker: self-heal symlink sweep +
proactive host-token refresh + one-host re-auth). **But there is one critical, live-verified defect:** the broker's
OAuth token endpoint default is wrong (`console.anthropic.com` → generic 429, never refreshes); the real endpoint is
`https://claude.ai/v1/oauth/token` (HTTP 400 `invalid_grant`). **This investigation fixes that.** Two further
recommended items (a scripted one-click operator HOST `/login` assist; an `adapter.ts:387` authMode-gating fix as the
precondition for any own-team in-pane hybrid) await an operator go-ahead.

> **Divergence from the operator's lean:** the operator leaned toward auto-heal; the verdict says per-agent
> auto-`/login` is the wrong layer. This is NOT a hard product fork — it's the "better way" the brief explicitly
> invited, and the better solution (host-level) is already most of the way there.

---

## Evidence (grounded)

### Q1 — Can an auto-heal COMPLETE for subscription OAuth? **No.**
- Detection is **footer-only text-scraping**, not credential/token validation: `paneState.ts:61-69`
  (`AUTH_ERROR_MARKERS`), `readFooterSignals` (`paneState.ts:151-166`), classified `error`→`reauth-needed`
  (`paneStateToBusyState`, `paneState.ts:196-206`); the adapter scrapes the footer region each poll
  (`adapter.ts:493-503`). No API probe — it just sees the `/login` screen text.
- **Empirical probe (live, 2026-06-16, agent `screener`):** `/login` → method picker (headless-selectable) →
  selecting "Claude subscription" prints:
  `Browser didn't open? Use the url below to sign in … https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=…&state=…` + `Paste code here if prompted >`. **A human must open the browser, approve, and paste a code.** A bot stalls at this step.
- The runtime DELIBERATELY blocks machine-driven `/login`: `supervisor.performInject` throws on a `reauth-needed`
  state unless `opts.source === 'operator'` (`supervisor.ts:202-219`) — "the human re-authenticating in the live
  pane, NOT credential auto-injection". So a per-agent auto-`/login` saves ~nothing (a human is still required to
  approve+paste) and is architecturally rejected.

### Q2 — The shared-symlink decoupling trap. **Per-agent `/login` is the wrong LAYER for shared-sub.**
- `ensureSharedSubscriptionAuth` (`adapter.ts:144-173`) SYMLINKs the one host token into each agent's config-root and
  self-repairs the link on every start. The comment is explicit: an in-pane `/login` "atomic-renames a REAL
  `.credentials.json` over the symlink and the agent is PERMANENTLY decoupled".
- `reauth-needed` for a correctly-linked shared agent is a **pane-text** signal; the ROOT cause is the **host token**
  expiring (all agents symlink it → all show `/login` at once). The sanctioned fix is ONE host re-auth + relink +
  restart (`POST /api/agents/shared-auth/refresh`, `agents.ts`).
- **Empirical:** merely opening `/login` + Escape did NOT decouple (`screener`'s link stayed a symlink); decoupling
  happens only on COMPLETION (writing the new file) — consistent with the comment + the 13-agent incident.

### Q3 — Proactive vs reactive. **Proactive host-level is strictly better — and mostly already built.**
- `readSharedAuthStatus` (`adapter.ts:121-132`) reads host-token expiry. `createAuthBroker`
  (`runtime/claude/authBroker.ts`, merged `c878ff5`) already does (1) a self-heal symlink sweep, (2) a proactive
  refresh (sole serialized refresher, 10-min lead, atomic in-place write), (3) escalate-once on failure.
- **CRITICAL DEFECT (live-verified, fixed here):** the broker's `OAUTH_TOKEN_URL` default was
  `https://console.anthropic.com/v1/oauth/token`, which returns a generic HTTP **429** (never engages the grant). A
  dummy-token probe shows the real endpoint is **`https://claude.ai/v1/oauth/token`** (HTTP **400**
  `{"error":"invalid_grant"}` — it validates the grant). `CLAUDE_OAUTH_TOKEN_URL` is unset in the live env, so the
  wrong default ran → the proactive refresh silently degraded to escalation. **Fix applied:** default →
  `https://claude.ai/v1/oauth/token`, plus a test asserting the real default URL is used.

### Q4 — Scope by auth mode. **HYBRID in principle; host-level only in practice (no own-team agents exist).**
- Live roster: **15/15 shared-subscription, 0 own-credentials, 0 api** (`~/.orchestrator/config.json`).
- In-pane `/login` is correct ONLY for own-team(`own-credentials`)/api agents (own config-root, no shared symlink to
  clobber) — and the route already exists, operator-gated, refusing shared-sub:
  `POST /api/agents/:id/auth-login` returns 409 for `shared-subscription` (`agents.ts:351-371`).
- **Latent safety bug (gap, NOT fixed here):** `adapter.ts:387` keys `ensureSharedSubscriptionAuth` on
  `!apiMode && localModel === undefined`, **not** on `agent.authMode`. An `own-credentials` agent under subscription
  billing would still be symlinked to the host token → an in-pane `/login` would decouple it. The hybrid's safety
  precondition is therefore false in code today; it must be fixed (gate on `authMode==='own-credentials'`) BEFORE any
  own-team in-pane assist is safe. Dead-path today (no such agents), so deferred.

### Q5 — Safety invariants (must hold for any solution).
- **Hub/NEXUS never auto-`/login`'d:** `performInject` blocks machine delivery on `reauth-needed` (force cannot
  bypass); only operator-source is allowed (`supervisor.ts:202-219`).
- **Bounded escalation:** fire-once per episode via the `reauthSurfaced` Set (`supervisor.ts`), `watcherService.ts`
  alerts once — no noisy loop.
- **Subscription billing:** `assertNoApiKey` at boot (`main.ts:97-107`) + `core/billing.ts` denylist; the shared
  symlink must never be wrongly decoupled.

---

## Recommendation

**B (with a hybrid hook), realized as host-level for the current all-shared-sub fleet.** Do NOT build per-agent
auto-`/login`. Instead:

1. **[DONE this branch]** Fix the auth-broker's OAuth token endpoint (`claude.ai/v1/oauth/token`) so the proactive
   refresh — the leg that keeps the fleet off `/login` entirely — actually works. (+ a test pinning the default URL.)
2. **[Recommended, awaits go-ahead]** A **scripted one-click operator HOST `/login` assist**: the current
   shared-auth surface is observe-only + relink/restart; add an operator action that drives the host-shell `claude`
   login then triggers the existing relink+restart sweep — clearly an operator action, not credential injection.
3. **[Recommended, deferred — dead-path today]** Fix `adapter.ts:387` to gate the credential symlink on
   `agent.authMode` (skip `own-credentials`), the precondition that makes the EXISTING `auth-login` in-pane assist
   safe for own-team agents if any are ever added (the hybrid leg).

All three preserve: NEXUS/hub never auto-injected; subscription-only (no API key; shared symlink never wrongly
decoupled); bounded + always-escalating.
