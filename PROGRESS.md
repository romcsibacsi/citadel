# CITADEL — Build Progress

> Resume anchor. If a session runs out of context or hits a rate limit, read this file
> + the TaskList state, then continue from **Next step**. Nothing here is guesswork —
> `ASSUMPTION` / `UNKNOWN` tags mark anything unverified.

- **Project:** CITADEL — single-user AI-agent orchestration system, a rebrand+hardening of
  an open-source upstream agent framework.
- **Host:** uplinkserver (headless Ubuntu, Node v22.22.2, no GPU). Build runs in tmux session `build`.
- **Repo:** `/home/uplinkfather/CITADEL/citadel` — branch **`citadel-build`**, forked from upstream
  `develop` @ `d64bb2e`. **Treat the live homelab as sacred** — do not touch running prod containers
  until a change is built + verified.
- **Auth:** subscription via OAuth (`~/.claude/.credentials.json` present). Do NOT use `ANTHROPIC_API_KEY`
  (confirmed empty). Keep autonomous background work OFF the metered/SDK path.
- **Spec:** the full CITADEL build brief (see chat / `REBUILD_PROMPT_V3.md` is the *upstream's* own
  build prompt, a reference only — not the CITADEL spec).

---

## Current state (verified Phase-0 recon — 2026-06-07)

- Upstream framework cloned, branch `citadel-build` created, `npm install` done (573M node_modules),
  only `package-lock.json` dirty. **package.json still carries the upstream package name — rebrand NOT started.**
- Theme zips extracted → `../themes/nexus1` (Stark HUD, richest ref), `nexus2` (Arcane Forge),
  `nexus3` (Obsidian Command, default). `citadel-design.zip` == `nexus1.zip` (dup, ignore).
- Avatars (7 portraits) `../citadel-avatars/`, glyphs (7) `../citadel-glyphs/` — present.
- 159 TS source files; large vitest suite (~70 test files in `src/__tests__`).
- **Caveat:** the CITADEL spec's file paths are approximate (e.g. it says `src/web/channel-monitor.ts`,
  `src/web.ts`, `agent-team.ts`, `message-router.ts`; this checkout has `src/channel-coordinator.ts`,
  `src/team-trust.ts`, etc.). The Phase-0 map (below) records the REAL paths.

## Architecture map (Phase 0) — DONE

- Full synthesis → [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); raw 7-subsystem map → `docs/phase0-map.json`.
- **Baseline:** typecheck clean; vitest **1012 pass / 1 skip / 4 fail**. The 4 fails are all
  macOS-only `managed-settings.test.ts` on Linux — pre-existing, NOT a regression. Bar: no new fails.
- **SDK name unchanged** (`@anthropic-ai/claude-agent-sdk@0.2.117`); model `claude-opus-4-8[1m]`. (Resolves a Phase-8 unknown.)
- **Hybrid heartbeat already half-built** upstream (tmux heartbeat agent via `schedule-runner`); Phase 6 extends, not rewrites.
- **Spawn already gated** to main-agent; Phase 5 hardens (cap/approval/sandbox) + reaper.

---

## Plan (phases ↔ TaskList)

| Phase | Task IDs | Status | Commit |
|---|---|---|---|
| 0 — Setup + architecture map | #1, #2 | ✅ done | a9d82fb |
| 1 — Rebrand upstream→CITADEL | #3 | ✅ done | c33b165 |
| 2 — Trim (Slack, llm-breakdown, community, watchdogs) | #4–#7 | ✅ done | f9b88ef |
| 3 — ntfy push channel | #8 | ✅ done | 881f9e0 |
| 9 — Root CLAUDE.md discipline doc | #19 | ✅ done | bc15bf3 |
| 4 — 7-agent roster + profiles + team graph | #9 | ✅ done | bc15bf3 |
| 5 — Agent-spawns-agent (gate / naming+types / reaper) | #10–#12 | ✅ done | f1d336c |
| 6 — Hybrid heartbeat | #13 | ✅ done | 9fd85fb |
| 8 — June-15 readiness (SDK pkg + model id) | #18 | ✅ done | c2956a5 |
| 7 — PWA + multi-theme + avatars + surfaces | #14–#17 | ✅ done | 912b969, 7283b49 |
| 10 — Verification (baseline / new-feature / E2E) | #20–#22 | ✅ done | aea753d |
| 11 — Vault docs + runbook | #23 | ✅ done | (this commit) |
| 12 — Deploy + remote smoke | #24 | ⏸ operator-gated | needs tokens/subdomain |
| 13 — Handoff + remove NOPASSWD reminder | #25 | ⏳ final | |

**Test baseline holds at:** typecheck clean; vitest = 964 pass / 1 skip / **4 pre-existing macOS fails** (the only acceptable failures).

## Invariants (must NOT break)

1. Interactive tmux agents stay interactive (subscription pool) — never route conversational agents
   through the SDK/headless path.
2. Per-agent context/session isolation preserved (ledger scoped per agent).
3. Trust model in the message router preserved (`from_agent` untrusted).
4. No agent can ever escalate its own privilege.
5. Memory-layer continuity preserved.

## Decisions / assumptions

- **DECISION:** Product/daemon = **CITADEL**; main orchestrator agent (chat partner) = **NEXUS**
  (`MAIN_AGENT_ID=nexus`, `BOT_NAME=NEXUS`). Mechanical ids → `citadel.*` (db/pid/service/plist).
- **DECISION:** Cadence = **full autonomous** (user-chosen). Build all phases, commit per task,
  stop only on hard blocker / rate limit / completion.
- **DECISION:** Keep all 5 resilience watchdogs (map confirms each guards a real failure mode); P2d
  documents retention rather than removing.
- **ASSUMPTION:** ntfy server URL + topic and the PWA's remote subdomain (NPM/Cloudflare) are
  config-driven via `.env`; concrete values confirmed with user at deploy (Phase 12). Defaults stubbed.
- **RESOLVED:** SDK package name unchanged; OAuth via `~/.claude/.credentials.json` (framework already
  bridges it — `heartbeat-oauth-token.test.ts`).

## Next step

Build is functionally COMPLETE on `citadel-build` and validated in isolation (typecheck clean; vitest
1026 pass / 4 pre-existing macOS fails; Playwright E2E 18 surfaces × desktop+mobile × 3 themes green).
Remaining = **operator-gated**: Phase 12 live deploy + remote smoke needs real Telegram/Discord tokens,
ntfy URL/topic, and an NPM subdomain decision — deliberately NOT done autonomously (live homelab is
sacred / outward-facing). See `docs/RUNBOOK.md` to deploy. Phase 13: remove the temp NOPASSWD sudoers
after the build. Minor polish noted in the vault: Stark theme visual closeness; Tweaks select sync.

## Rollback

Whole build is isolated on branch `citadel-build` in a throwaway clone; live homelab untouched.
Per-change rollback notes are recorded in each phase's vault doc as work proceeds.

## 2026-06-07/08 — Live deploy + teljes funkcionális audit (post-build)

Deploy él (Discord/NEXUS, systemd nexus-dashboard + nexus-channels). Éjszakai átfogó
funkcionális audit lefutott: 463 elemű UI-leltár, 12 párhuzamos Playwright/API tesztelő,
603 check, 138 screenshot. **12 bug javítva + retesztelve** (commitok: e1bd03d, f411a7e,
73fe052, 8aaa5c9, 5ecfe0d, 13d314e + installed-unit Restart=always fix), köztük critical:
a háttérfeladatok BG_PROMPT-ja sosem ért el az agenthez (tmux server-env). Trust-modell,
privilege gate, multi-agent orkesztráció (FORGE/SPARK vita + NEXUS döntés), skill-lánc
élesben bizonyítva. Teljes riport + nyitott leletek: `~/CITADEL/audit-20260607/REPORT.md`.

**O1+O2 utólag javítva (2026-06-08, commitok dbc3674 + 1c1dc4e):** O1 = Telegram one-click invite
backend (deep-link pairing; Discordnál a szekció elrejtve). O2/O3/O4 = operátor mint reply-expected
human principal (`<operator>` keret + preamble, dedikált `/api/operator/message` route, 403-guard a
generikus POST-on, terminális operator-címzett a routerben). Residual O2-res: közös bearer token →
forgery-ellenállás = trusted-peer szint (valódi fix: külön operátor-credential). Élő E2E PASS,
suite 1033/1033. Marad: O5–O8 (alacsony prio).

**Ütemezett-feladat de-kontamináció (2026-06-08, commitok f376af8 + 4dff361 + 44422f2):** a 3
scheduled-task prompt (dream-engine, reggeli-napindító, memoria-heartbeat) tele volt upstream
szennyezéssel (operátor-személynév, upstream-brand + legacy roster, fix Telegram chat_id, legacy
útvonal, sqlite3 CLI, legacy bot-aláírás, task-config agent=legacy). Átírva CITADEL-re: a
**dream-modul a SAJÁT csapat** (NEXUS+FORGE/SPARK/SIGMA/RELAY/SCREENER/ORACLE) munkáját nézi át és abból
álmodik; dashboard-API olvasás (nincs sqlite3), abszolút utak, csatorna-semleges (Discord-élő), nulla
upstream-brand (grep-igazolt, élő ~/.claude + repo). A scheduler prefixe is csatorna-semleges (Telegram-keepalive
csak CHANNEL_PROVIDER=telegram esetén). Élő dry-run PASS (DREAM.md a saját csapatról), suite 1034/1035.
**Június 15 = build-readiness direktíva nekem** (nem csapat-mérföldkő): SDK-csomagnév + élő model-id +
subscription/interaktív út — már auditálva `docs/phase8-june15.md`-ben (SDK-rename ~jún 15 watch-item,
eddig nem landolt). A mostani munka curl-API + interaktív sessionök = 5.8-konform.

## 2026-06-08 — Frissítés-forrás + webes titokkezelés (commitok abb428d + 818c848)

Az update-checker már a SAJÁT repót figyeli (UPDATE_GITHUB_REPO / github.com remote auto-detect / a
jelenlegi ágat, nem hardcode main), nincs upstream-brand fallback; opcionális GITHUB_TOKEN privát
mirrorhoz. Új **webes titokkezelés**: a Vault oldalon „Rendszer-integrációk" kártya (GITHUB repo + token),
ahonnan a titok titkosítva a Vaultba kerül ÉS a .env-be tükröződik, futásidőben olvasva (nincs restart).
Modulok: `system-settings.ts` (bővíthető SYSTEM_SETTINGS séma — új titok = 1 sor + 1 getSystemSetting
olvasás a fogyasztónál), `env-writer.ts` (atomi .env upsert). Élesben: repo=romcsibacsi/citadel beállítva.
Operátor teendő: (1) Gitea push-mirror a github.com/romcsibacsi/citadel-re + a citadel-build ág pusholása;
(2) ha privát, a GitHub token megadása a kártyán. 19 új teszt, suite 1053.

## 2026-06-08 — Gitea→GitHub push-mirror + webes titokkezelés él
Forrás = Gitea (git.uplinkfather.com/romeo/citadel, default ág citadel-build). Push-mirror beállítva a
github.com/romcsibacsi/citadel-re (privát), `sync_on_commit=true` — minden Gitea-push automatikusan
átmegy GitHubra. A 17 lokális session-commit felpusholva Gitea-ra (token git-jelszóként), onnan a mirror
GitHubra. Titkok a Vaultban (TELEGRAM/DISCORD/NTFY/GITHUB token + GITHUB_PUSH_TOKEN + GITEA_TOKEN),
.env változatlan. Gitea-push módja: `git -c credential.helper='!f(){ echo username=romeo; echo
password=$GITEA_TOKEN; };f' push origin`. Dashboard checker: romcsibacsi/citadel @ citadel-build, behind 0.
