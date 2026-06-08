# Phase 2 — Trims (what was removed & why)

Single-user hardening. Rollback for the whole phase: `git revert <phase2 commit>` (or `git checkout
c33b165 -- <path>` for a single file). Everything is isolated on branch `citadel-build`.

## Removed — Slack provider (2a)
Single-user setup uses Telegram + Discord only. Deleted `slackProvider` + manifest/scopes/smoke-test
machinery; `ChannelProviderType` is now `'telegram' | 'discord'`. Files: `channel-provider.ts`,
`config.ts` (SLACK_* env), `routes/agents.ts` (endpoints + VALID_PROVIDERS), `telegram.ts`,
`heartbeat.ts` (disabled-plugins), `channels.sh`, `channel-poller-reap.ts`. Deleted
`__tests__/slack-manifest.test.ts`, `scripts/smoke-test-slack-channel.sh`.
**Kept on purpose:** `SLACK_ALLOWLIST_ENTRY` + managed-settings helpers in `routes/agents.ts`
(imported by `managed-settings.test.ts`, macOS-only, harmless on Linux).

## Removed — llm-breakdown / token analytics (2b)
The `claude -p` token-analytics path. Deleted `web/llm-breakdown.ts`, `web/token-usage.ts`,
`web/routes/token-usage.ts` + their tests; removed `tryHandleTokenUsage` wiring (`web.ts`) and the
`POST /api/kanban/:id/breakdown` + `/api/ideas/:id/breakdown` generation endpoints.
**Kept:** `token_usage`/`token_usage_cursors` table schemas in `db.ts` (no-op, avoids migration churn).

## Removed — community / multi-user features (2c)
Invites, Discord group-bootstrap, channel-request-watcher (multi-user only). Deleted
`web/channel-invites.ts`, `web/discord-group-bootstrap.ts`, `web/channel-request-watcher.ts`; removed
their startup wiring in `index.ts` and invite endpoints in `routes/agents.ts`.
**Kept:** `pending_channel_requests` table schema + `*ChannelRequest*` db helpers (still used by
`channel-request.test.ts`).

## Watchdogs — RETAINED (2d), not trimmed
The Phase-0 map verified each of the 5 resilience watchdogs guards a distinct real failure mode, so
**none are removed** (the spec says trim only where *clearly* redundant for single-user; none is):

| Watchdog | File | Guards against |
|---|---|---|
| channel-health-monitor | `web/channel-health-monitor.ts` | transient plugin drops (reconnect w/ backoff) |
| stuck-tool-call-watcher | `web/stuck-tool-call-watcher.ts` | frozen TUI tool-call (CPU-guarded respawn) |
| auto-restart-runner | `web/auto-restart-runner.ts` | long-session context bloat (scheduled restart) |
| reauth-healer | `web/reauth-healer.ts` | dead OAuth token (re-login / escalate) |
| channel-monitor cascade | `web/channel-monitor.ts` | vanished/wedged main session (4-stage recovery) |

## Verification
typecheck clean; `vitest` = 941 passed / 1 skipped / 4 pre-existing macOS fails (no regressions).
Frontend dead-links (idea-breakdown button, hidden Slack setup elements) deferred to the Phase-7
frontend rebuild — noted, they don't throw on load.
