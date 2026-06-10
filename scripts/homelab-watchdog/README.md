# Homelab watchdog (deterministic recovery + test-gated auto-update)

Build per `docs/homelab-watchdog-proposal.md` (RELAY v2). **Deterministic, no AI** for
watching — the AI/team only steps in at escalation. Built by FORGE; the homelab-specific
config (allowlist, commands, tests) is RELAY's to fill in `homelab-watchdog.conf`.

> **SAFETY / go-live gate.** Everything ships **DRY_RUN=1** (logs intended actions,
> mutates nothing, sends no real alert). Nothing is enabled. The operator reviews a
> dry-run on one non-critical container BEFORE anything runs live on the homelab.

## Components

1. **`recovery-watchdog.sh`** — layer 2 of the recovery design. A systemd `--user` timer
   runs it every few minutes; for each container on the **MANAGED allowlist** that is
   *persistently* down/unhealthy it runs `docker start` / `compose up` (never a recreate,
   never an intentionally-stopped container). After `MAX_ATTEMPTS` failed recoveries it
   **stops** and **escalates** (ntfy + Telegram + a kanban card to RELAY). Every recovery
   is reported. Layer 1 (Docker's own restart-policy/healthcheck) handles most crashes
   before this even fires; this is the coarse net.

2. **`update-pipeline.sh`** — test-gated full-auto update. `wud` (what's-up-docker) calls
   it on a new version: `config-backup → pin new tag → pull + recreate → POST-UPDATE
   SMOKE TEST → PASS keeps / FAIL auto-rollbacks to the previous tag → always reports`.
   The **test is the gate**. The risky minority (mailcow, Nextcloud-major, Home Assistant,
   DB-major) is on the **MANUAL** list → notify + card only, never auto-updated.

3. **`lib.sh`** — shared helpers (dry-run-aware `run`/`notify`/`create_kanban_card`,
   docker state readers). Secrets (NTFY/Telegram/dashboard token) come from the install
   `.env` — never hardcoded.

4. **`homelab-watchdog.conf.example`** — the config template RELAY fills (`MANAGED`,
   `RECOVERY`, `FULLAUTO_TEST`, `MANUAL`, `GET_TAG`/`SET_TAG`/`APPLY`/`BACKUP`).

5. **`../systemd/homelab-recovery-watchdog.{service,timer}`** — the timer units (ship
   DRY_RUN=1, **not enabled**).

## Try it (dry-run — safe, mutates nothing)

```bash
cp scripts/homelab-watchdog/homelab-watchdog.conf.example scripts/homelab-watchdog/homelab-watchdog.conf
# RELAY fills the conf with the real allowlist/commands/tests, then:
DRY_RUN=1 scripts/homelab-watchdog/recovery-watchdog.sh
DRY_RUN=1 scripts/homelab-watchdog/update-pipeline.sh radarr 5.3.6
```

## Go live (only after the operator approves the dry-run)

1. RELAY confirms `homelab-watchdog.conf` (real allowlist/commands/tests).
2. Run a dry-run on one non-critical container; FORGE reports the result to NEXUS → operator.
3. After GO: in `homelab-recovery-watchdog.service` set `DRY_RUN=0`, fix the paths, then
   `systemctl --user enable --now homelab-recovery-watchdog.timer`.
4. Wire `wud`'s on-new-version action to call `update-pipeline.sh <container> <tag>`
   (with `DRY_RUN=0`). RELAY owns the wud/homelab wiring.
