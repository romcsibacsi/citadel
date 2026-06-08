# CITADEL — Runbook

Operational guide for the CITADEL system (single-user AI-agent orchestration on uplinkserver).
Repo: `/home/uplinkfather/CITADEL/citadel`. Brand: **CITADEL** (daemon); main agent: **NEXUS**.

## First-time setup / deploy
1. `cp .env.example .env` and fill in: `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID`, `OWNER_NAME`
   (Discord: `CHANNEL_PROVIDER=discord` + its token). Optional: `NTFY_URL`+`NTFY_TOPIC`,
   `HEARTBEAT_TRIAGE_OLLAMA_URL`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_TOKEN`.
2. `npm install` then `npm run build`.
3. `./install.sh` (delegates to `install-linux.sh`) — interactive: sets `BOT_NAME` (default NEXUS),
   creates the `.env`, and registers the **systemd user service `citadel.service`**.
   - On first boot the 7-agent roster is materialized from `seed-agents/` into `agents/`
     (idempotent; never overwrites an edited agent).

## Start / stop / status
Two user units (created at deploy): **`nexus-dashboard`** (web + monitors, `dist/index.js`) and
**`nexus-channels`** (the live NEXUS `claude --channels` tmux agent, `scripts/channels.sh`).
- Start:  `systemctl --user start nexus-dashboard nexus-channels`
- Stop:   `systemctl --user stop nexus-channels nexus-dashboard`
- Restart:`systemctl --user restart nexus-dashboard nexus-channels`
- Logs:   `journalctl --user -u nexus-dashboard -f` · `journalctl --user -u nexus-channels -f`
          (also `store/dashboard.log`, `store/channels.log`)
- Attach to NEXUS:  `tmux attach -t nexus-channels`  (Ctrl-b d to detach)
- Status: `npm run status` — also surfaces tmux agent sessions
- Dashboard token: `cat store/.dashboard-token` (used as `?token=` / Bearer). `DASHBOARD_TOKEN` in
  `.env` is NOT auto-loaded into the process — set it as a unit `Environment=` if you want a fixed one.
- Dev (foreground): `npm run dev`

The dashboard listens on `http://127.0.0.1:3420`. First load: `http://127.0.0.1:3420/?token=<DASHBOARD_TOKEN>`
(token printed at boot / stored in `store/.dashboard-token`); it is saved to localStorage and stripped from the URL.

## Add an agent (name picker)
- **Dashboard:** Agents → "Új ügynök" (＋) → the create wizard. Name suggestions come from
  `GET /api/agents/name-suggestions?role=...` (themed, collision-safe); a custom name is allowed.
  Pick a security profile; dashboard-created agents are visible (channel) by default.
- **Programmatic (NEXUS):** `POST /api/agents` with `requestedBy: "nexus"`. The **privilege gate**
  applies: sandbox profiles auto-create; anything above sandbox returns **202 pending** and waits for
  your approval at `POST /api/agents/spawn-requests/:id/approve` (you also get an ntfy/Telegram alert);
  anything above the hard ceiling (homelab-full / orchestrator) is **403 forbidden** — never spawnable.
  NEXUS-spawned project agents default to **internal** (hidden, no own bot).
- **Reap (retire):** `POST /api/agents/:name/reap` — writes a handoff summary to `reports/handoffs/`,
  archives the agent dir to `agents/.archived/`, drops its schedules, tears down its session. Base-roster
  agents are protected. Ephemeral agents (`lifecycle.ephemeral`) are auto-reaped when done.

## Switch themes / Tweaks
Gear button in the sidebar footer → **Tweaks** panel:
- **Theme:** Obsidian Command (default) · Stark HUD · Arcane Forge.
- **Density** (comfortable/compact), **Glow** intensity, **Accent** override. All persist (localStorage)
  and apply live. Per-agent accent rings (`--ac`) follow each agent's color in every theme.

## Access remotely (PWA)
CITADEL binds `127.0.0.1` by default. To reach it from another machine, front it with the homelab
reverse proxy (Nginx Proxy Manager) or a tunnel — do NOT expose `0.0.0.0` without auth:
1. Add a proxy host (e.g. `citadel.<domain>`) → `uplinkserver:3420`, TLS on.
2. Set `DASHBOARD_PUBLIC_URL=https://citadel.<domain>` (CORS) and a strong `DASHBOARD_TOKEN` in `.env`; restart.
3. Open the URL on the remote device with `?token=...` once; then **install the PWA** (browser "Install
   app" / iOS "Add to Home Screen"). Push while away: Telegram + ntfy (iOS PWA push is limited).

## Update
`./update.sh` (git pull + `npm install` + `npm run build` + service restart). Review the diff first.

## Health / recovery (automatic)
Five watchdogs run in-process: channel-health, stuck-tool-call, auto-restart, reauth-healer, and the
channel-monitor 4-stage recovery cascade. The hybrid heartbeat (opt-in `HEARTBEAT_AGENT_ENABLED=1`)
runs a CPU triage first and only escalates to the interactive NEXUS path when something is noteworthy,
then alerts via ntfy/Telegram.

## Verify a checkout (no live services)
- `npm run typecheck` → clean.
- `npx vitest run` → 1026 pass / 4 pre-existing macOS `managed-settings` fails (Linux: ignore).
- E2E smoke: create `.env` with `DASHBOARD_TOKEN=...` + `RESPAWN_ENABLED=0`, run `tsx scripts/e2e-web.ts`
  in the background, then `node scripts/e2e-smoke.mjs` (screenshots → `test-results/e2e/`).
