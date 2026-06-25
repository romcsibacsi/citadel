# Install guide

> Magyar verzió: [INSTALL.hu.md](INSTALL.hu.md)

This is the full installation walkthrough: from a clean machine to a running
fleet with the dashboard open and, optionally, the Telegram channel bound.

Before anything else, work through the **[prerequisites](PREREQUISITES.en.md)**:
Linux x64 (tested on Ubuntu 24.04), Node.js >= 22.5 with `node:sqlite`, npm,
tmux >= 3.x, and the Claude Code CLI (`claude`) logged in via **subscription
OAuth** — and make sure none of the billing-flipping variables
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
`CLAUDE_CODE_USE_VERTEX`) is set anywhere
(`env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'` must print nothing).

## 1. Clone the repository

```bash
git clone <your-repo-url> fable5-build
cd fable5-build
```

## 2. Run the installer

One command:

```bash
./scripts/install.sh
```

Flags:

- `--locale hu|en` — set the install-wide default locale without prompting.
- `--yes` — fully non-interactive; if `--locale` is not given, it defaults to
  Hungarian (`hu`).

```bash
./scripts/install.sh --locale en --yes    # non-interactive English install
```

### What the installer does, step by step

1. **Prerequisite checks** — fails fast with an actionable message if any is
   missing: Node >= 22.5, a Node build that actually has `node:sqlite`, npm,
   tmux, and the `claude` binary on `PATH`.
2. **Billing-guard refusal** — if any variable on the billing denylist
   (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`,
   `CLAUDE_CODE_USE_VERTEX`) is set in the environment, the install **aborts**.
   The system is subscription-billed only; a stray credential would silently
   switch every agent session to pay-as-you-go or external billing. (The same
   denylist is enforced again at supervisor boot and at every agent launch.)
3. **Locale choice** — prompts for the default locale (`hu`/`en`, default
   `hu`) unless `--locale` or `--yes` was given.
4. **`npm ci`** — installs the (dev-only) dependencies from the lockfile.
5. **`npm run typecheck` and `npm run build`** — strict TypeScript check, then
   the backend build (`tsc`) and the dashboard bundle (esbuild).
6. **First-run initialization** — runs `node dist/app/main.js --init-only
   --locale <hu|en>`, which:
   - creates the **state directory** (mode `0700`),
   - installs the seed config as `config.json` (mode `0600`) — only if absent,
   - opens the SQLite database (`orchestrator.db`, WAL mode, created `0600`)
     and runs all schema migrations,
   - generates the **dashboard bearer token** (`dashboard-token`, `0600`) and
     the **vault master key** (`master.key`, `0600`),
   - scaffolds every roster agent under `agents/<id>/` (work dir, config root,
     skills dir, a scoped `agent-token`, `persona.md`, `operating.md`,
     `CLAUDE.md`),
   - prints the dashboard **bootstrap URL** (with the `?token=`) to **stderr**.

### Idempotency — re-running is safe

You can run `./scripts/install.sh` again at any time (e.g. after `git pull`).
It is guaranteed to:

- **never overwrite operator-edited files** — `config.json`, personas,
  operating contracts, and `CLAUDE.md` files are created only when absent;
- **never rotate existing secrets** — the dashboard token, the vault master
  key, and the per-agent tokens are generated once and then reused;
- only re-install dependencies and rebuild, and create whatever is missing.

### The state directory

All mutable state lives outside the repo, in `$ORCHESTRATOR_STATE_DIR` if set,
otherwise `~/.orchestrator`:

```
~/.orchestrator/
├── config.json          # the live configuration (seeded from seed/seed.config.json)
├── orchestrator.db      # SQLite (WAL): messages, memory, kanban, schedules, vault, ...
├── dashboard-token      # root-equivalent dashboard bearer (0600)
├── master.key           # vault master key (0600)
├── supervisor.lock      # single-supervisor pidfile (exists only while running)
├── agents/<id>/         # per-agent: workdir/, config-root/, skills/, agent-token,
│                        #            persona.md, operating.md
├── skills/              # global (fleet-wide) skills
└── logs/                # per-agent session logs
```

(The hub agent is slightly different: its skill root *is* the global `skills/`
directory, so it has no per-agent `skills/`, and as the hub it carries no
`operating.md` contract.)

Set `ORCHESTRATOR_STATE_DIR` *before* installing if you want the state
somewhere else, and keep it set for every later start.

## 3. First start and the bootstrap URL

```bash
npm start        # runs node dist/app/main.js
```

(For development there is `npm run dev`, which runs the TypeScript sources
directly via tsx.)

On the **first** start (while the dashboard token is freshly created) the
supervisor prints the dashboard **bootstrap URL** to **stderr**:

```
CITADEL dashboard: http://127.0.0.1:7080/?token=<long-token>
```

Open it **once per device**. The SPA stores the token in `localStorage` and
immediately strips it from the URL; afterwards plain
`http://127.0.0.1:7080/` works on that device. Every **later** start prints
only the dashboard URL plus a pointer to the token file — the token itself
never lands in logs again. The same bootstrap URL was also printed at the end
of the install (`--init-only` run), and the token is always readable from the
0600 `~/.orchestrator/dashboard-token` file if you need to bootstrap another
device later.

On the first dashboard load a **guided onboarding wizard** appears: step 1 is
Claude sign-in (subscription or an explicit, vault-stored API key — API-mode
operators are not locked out), and the optional steps cover channels, local
Ollama and local ComfyUI, each showing a live ✓/○/! status pulled from
`/api/onboarding/status`. Completing or dismissing it is remembered
(`onboarding:completed` / `onboarding:dismissed`), so it only auto-opens once;
you can re-open it from the dashboard any time.

The supervisor then starts the roster agents as interactive Claude Code
sessions on the fleet's **dedicated tmux server** (`tmux -L citadel-mux`, set by
`runtime.claude.socket`; staggered, 15 s apart by default). You can watch and type
into any of them from the dashboard's agent view — or attach with
`tmux -L citadel-mux attach -t citadel-<agent-id>` (the socket comes from
`runtime.claude.socket`, the session prefix from `runtime.claude.sessionPrefix`).
Because this is a dedicated server, the agents are isolated from your own tmux
sessions and **survive a supervisor restart** (see the systemd note in section 4).

## 4. Running as a service (systemd)

`scripts/install.sh` GENERATES a ready-to-use unit at **`deploy/orchestrator.service`**
from `deploy/orchestrator.service.template` (filling in your user + install dir). If you
need to tweak it, edit the `User=`/`Group=`, the `WorkingDirectory=`, and the two
absolute paths (`ExecStart=` and the `Documentation=` line), then install it:

```bash
sudo cp deploy/orchestrator.service /etc/systemd/system/orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator.service
```

What the generated unit already sets for you:

- `User=` / `Group=` and `WorkingDirectory=` — run it as the **same user** that
  completed the `claude` subscription login and ran the installer.
- An explicit `Environment=PATH=...` that **includes the npm-global bin** where
  the `claude` CLI lives (`~/.npm-global/bin` in the shipped file) — systemd
  units do not inherit your login shell's `PATH`, so without this the agents
  cannot find `claude`. Also `Environment=HOME=...` so the `claude` CLI finds
  its OAuth login under `~/.claude`.
- `UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX`
  — the billing-flipping denylist is stripped at the unit level, so even a dirty
  system environment cannot reach the supervisor. (Do **not** add any of these
  back via `Environment=`; the supervisor refuses to start if one is present.)
- `Restart=on-failure`, and `TimeoutStopSec` / **`KillMode=process`** — on stop or
  restart, systemd kills **only the supervisor process**, never the agents. The agents
  run on a **dedicated tmux server** (`tmux -L citadel-mux`, set by
  `runtime.claude.socket`; it defaults to the `sessionPrefix` when unset), which is **not
  a child of the supervisor**, so the agent sessions **persist across a supervisor
  restart** and the new supervisor **adopts** them — no agent is interrupted by a
  redeploy. (This is also why recovery is respawn-in-place and never kills the server.)

**Stopping the supervisor vs. stopping the fleet.** `systemctl stop orchestrator` (or a
restart) stops only the supervisor; the agents keep running on the dedicated tmux server.
To **fully stop the fleet**, including all agent sessions, kill that server explicitly:

```bash
tmux -L citadel-mux kill-server     # stops every agent on the dedicated socket
```

(Use the socket from `runtime.claude.socket`; the seed config sets `citadel-mux`. This
touches only the fleet's own server — your personal tmux sessions on the default server
are untouched.)

To relocate the state directory, add
`Environment=ORCHESTRATOR_STATE_DIR=/path/to/state` (it must match what the
installer used).

Notes:

- The root-equivalent token is printed to stderr only on the **first** start
  (when the token file is freshly created); every later start logs just the
  dashboard URL and the path to the 0600 token file, so the **journal** stays
  token-free in steady state. If the very first start happens under systemd,
  treat that one `journalctl -u orchestrator` entry as sensitive — or simply read the
  token from `~/.orchestrator/dashboard-token`.
- To expose the dashboard on a LAN or mesh (e.g. Tailscale), set `server.host`
  in `<stateDir>/config.json` to the bind address (it defaults to loopback,
  `127.0.0.1`). The token is **root-equivalent** — read section 5 on HTTPS and
  exposure first.
- Exactly **one** supervisor may run per state dir — stop any `npm start`
  session before enabling the unit (see the lock in Troubleshooting).

## 5. HTTPS and network exposure — read this before opening any port

By default the server binds to **loopback only** (`127.0.0.1:7080`, see
`server.host`/`server.port` in `config.json`). Keep it that way unless you know
what you are doing:

- The dashboard token is **root-equivalent**: whoever has it controls a fleet
  of agents, one of which runs with a full-host security profile on your
  machine. Never expose the port directly to a LAN or the internet.
- If you need remote access, use a **private mesh VPN** (e.g. Tailscale or
  WireGuard) and keep the bind on loopback / the mesh interface, **or** put a
  reverse proxy with **TLS** in front of it (and add the proxy's origin to
  `server.allowedOrigins` in `config.json` so state-changing requests pass the
  origin check).
- The **PWA features require HTTPS**: the service worker (offline shell,
  network-only `/api/*`) is only registered when the dashboard is served over
  `https:`. Over plain loopback HTTP the dashboard works fully, just without
  the installable-app/offline-shell extras.

## 6. Telegram channel setup (optional, recommended)

Telegram is the v1 operator channel. Unknown chats are **denied by default** —
only the configured operator chat is bridged.

1. In Telegram, talk to **@BotFather**: `/newbot`, pick a name and username,
   and copy the **bot token** it gives you.
2. Find your **numeric chat id** (e.g. message `@userinfobot`, it replies with
   your id).
3. In the dashboard open the **Channels** view, paste the bot token, set the
   operator chat id, and switch the channel to **enabled**, then save. The raw
   token is stored **encrypted in the vault** — only a `vault:` reference lands
   in `config.json`.
4. **Restart the supervisor** — channel changes take effect at the next start
   (the dashboard tells you so after saving).
5. After the restart, use the **Test** button in the Channels view to validate
   the token, then send your bot a message.

## 7. Locale at install — and changing it later

- The install-wide **default locale** (dashboard + backend prose; Hungarian by
  default) is chosen at install time: interactively, or via `--locale hu|en`.
- Each device can override the dashboard language at any time with the
  **language switcher** in the top bar (persisted per device).
- The install-wide default can be changed later in the **Settings** view (it
  switches live, no restart needed).
- The **agent prose language** — the language agents write their reports and
  documents in — is an independent axis, also set in Settings. Note that
  personas and operating contracts already scaffolded on disk are not
  re-rendered (operator edits are never overwritten); newly added agents pick
  up the new language.

## 8. Verifying the installation

```bash
npm run typecheck    # strict TS check, must be clean
npm test             # full suite: 1100+ unit + integration + boot/smoke tests
```

## 9. Troubleshooting

**"… is set in this environment" / "… present in the environment"** (naming
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` or
`CLAUDE_CODE_USE_VERTEX`) — the installer and the supervisor each refuse while
any billing-flipping variable is set. Remove it from the shell and from your
profile files (see the [prerequisites](PREREQUISITES.en.md)), open a new shell,
retry. Under systemd, also check the unit's `Environment=` lines.

**"another supervisor is already running (pid …, since …)"** — exactly one
supervisor may own a state dir. A *live* process holds `supervisor.lock`; stop
it first (`Ctrl-C`, `kill <pid>`, or `systemctl stop orchestrator`). Genuinely
**stale** locks (dead pid, e.g. after a power loss) are detected and cleared
automatically on the next start, and a boot that fails *after* acquiring the
lock (e.g. the port is in use) releases it on the way out — you never need to
delete the lock file by hand.

**`startup failed: listen EADDRINUSE ... 127.0.0.1:7080`** — another process
is using the port (often a second supervisor that got past a different state
dir, or an unrelated service). Find it with `ss -ltnp | grep 7080`, stop it,
or change `server.port` in `~/.orchestrator/config.json` and restart.

**"tmux is required for the interactive agent runtime"** — install tmux
(`sudo apt install tmux` / `brew install tmux`) and re-run the installer.

**"this Node build lacks the node:sqlite module"** — your Node is older than
22.5 or a stripped distro build. Install an official Node >= 22.5 (see the
[prerequisites](PREREQUISITES.en.md)) and check `node -e "require('node:sqlite')"`.

**Agents start but ask for login / the dashboard reports re-auth needed** —
the Claude Code CLI is installed but not (or no longer) logged in. Run
`claude` in a terminal as the orchestrator user and complete the subscription
OAuth login, then restart the affected agents from the dashboard. You can also
attach the tmux session (`tmux -L citadel-mux attach -t citadel-<agent-id>`, on
the dedicated socket) and complete the login right there.

**"npm ci failed"** — usually network/registry trouble; check connectivity
and any proxy settings, then re-run the installer (it is idempotent).

**Lost the bootstrap URL** — the token is on disk:
`cat ~/.orchestrator/dashboard-token`; open
`http://127.0.0.1:7080/?token=<that value>` once on the new device.
