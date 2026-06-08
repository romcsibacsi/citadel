# Phase 8 — June-15 readiness (audit)

Verified at build time (2026-06-07), not assumed.

## Agent SDK package name — UNCHANGED
`@anthropic-ai/claude-agent-sdk` (`package.json` `^0.2.116`; 0.2.117 installed). The rumored
~June-15-2026 rename did **not** land for this package; no import changes required. Single import
site: `src/agent.ts:1`.

## Model IDs — all live, non-deprecated
| ID | Where | Status |
|---|---|---|
| `claude-opus-4-8[1m]` | `agent-config.ts` `opus` alias; seed roster; primary | current (latest Opus) |
| `claude-haiku-4-5` / `claude-haiku-4-5-20251001` | heartbeat sub-agent | current |
| `claude-sonnet-4-6` | `DEFAULT_MODEL` / `inherit` fallback | current |
| `claude-opus-4-7`, `claude-opus-4-6` | selectable alternates in the model list | valid older versions (kept as options) |

No `claude-3-*` or other deprecated ids remain. (The `claude-coding`/`claude-x`/`claude-plugins-official`/
`claude-code`/`claude-config` strings are plugin marketplace + config-dir names, not model ids.)

## Programmatic / SDK usage — minimized
Autonomous background work (the heartbeat) runs on the **interactive subscription path**, NOT the SDK
(Phase 6). The only residual `runAgent()` (SDK `query()`) call sites are low-frequency and
operator/maintenance-triggered, never an unattended loop:

| Site | Trigger | Frequency |
|---|---|---|
| `memory.ts:193` daily digest | 23:00 nightly | 1×/day |
| `agent-scaffold.ts` generateClaudeMd/SoulMd | dynamic agent creation (the 7 baked roster agents bypass this) | rare, operator |
| `routes/schedules.ts:53/84` prompt/question expansion | operator creating a schedule in the dashboard | rare, operator |
| `heartbeat.ts:561` `executeHeartbeat` | **dead** — `initHeartbeat()` never called (kept importable for tests) | never |

## "Claim your Agent SDK credit" consideration
For the residual programmatic usage above, the operator can claim the one-time Agent SDK credit on
the Anthropic side; it offsets the metered cost of the nightly digest + occasional operator-triggered
generations. The high-frequency paths (chat, heartbeat escalation) stay on the Max subscription and
do not consume metered/programmatic credit. **Do not** set `ANTHROPIC_API_KEY` — auth stays on the
subscription OAuth token.
