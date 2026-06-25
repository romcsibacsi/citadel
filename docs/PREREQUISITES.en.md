# Prerequisites

> Magyar verzió: [PREREQUISITES.hu.md](PREREQUISITES.hu.md)

This document lists **every** prerequisite of the orchestrator, with minimum and
tested versions, concrete install commands, and the verification steps for each.
The installer (`scripts/install.sh`) checks the same prerequisites and fails fast
with an actionable message if any of them is missing or incompatible — but reading
this page first saves you the round-trips.

Once everything below is in place, continue with the [install guide](INSTALL.en.md).

## Summary

| Prerequisite | Minimum | Tested | Purpose |
|---|---|---|---|
| OS / arch | Linux x64 | Ubuntu 24.04, kernel 6.8 | Host platform (macOS expected to work, untested) |
| Node.js | 22.5 | 22.22 | Runtime; the embedded `node:sqlite` module requires >= 22.5 |
| npm | ships with Node | 10.x | Dependency install and build scripts |
| tmux | 3.x | 3.4 | The interactive agent runtime substrate |
| Claude Code CLI (`claude`) | 2.x | 2.1.x | The agents themselves — interactive, subscription-billed sessions |
| `ANTHROPIC_API_KEY` & co. | **must NOT be set** | — | Subscription-billing protection — a denylist of billing-flipping variables (see below) |

There are **no other runtime dependencies**: the project has zero npm runtime
packages (only dev tooling), SQLite is embedded in Node itself (`node:sqlite`),
and no external database, message broker, or web server is needed.

## Operating system and architecture

- **Linux x64** is the supported and tested platform (tested on Ubuntu 24.04
  with kernel 6.8).
- **macOS** is expected to work — everything used (Node, tmux, the Claude Code
  CLI) is available there — but it is **untested**.
- **Windows** is not supported *natively* (the agent runtime is built on tmux,
  which has no native Windows build) — but it runs **fully under WSL2**, which is
  the recommended way to run it on a Windows PC. Step-by-step below.

## Running on Windows via WSL2 (step by step)

WSL2 (Windows Subsystem for Linux) gives you a real Ubuntu Linux running *inside*
Windows 10/11 — tmux, Node and bash all work there, so CITADEL runs exactly as it
does on Linux. No dual-boot, no VM to babysit.

1. **Enable WSL2 + install Ubuntu.** Open **PowerShell as Administrator** (press
   Start, type "PowerShell", right-click it → *Run as administrator*), then run:
   ```powershell
   wsl --install -d Ubuntu
   ```
   Reboot if it asks. On Ubuntu's first launch it asks you to choose a username and
   password — set them (this is your Linux login, separate from your Windows one).
2. **Open Ubuntu** (Start → "Ubuntu"). You now have a Linux terminal. Update it:
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```
3. **From here, follow the normal Linux setup in this document** — install Node
   ≥ 22.5, tmux and the Claude Code CLI (the sections below), then run
   `./scripts/install.sh`. Everything behaves exactly as on a native Linux box.

Good to know:
- Your project files live inside the Ubuntu home (`~`); you can still open them from
  Windows Explorer at `\\wsl$\Ubuntu\home\<your-name>`.
- WSL2 needs Windows 10 version 2004+ or Windows 11.
- (Optional) image/video generation needs a ComfyUI on a GPU — that can be the same
  Windows PC's GPU reached from WSL2, or a separate machine.

## Node.js >= 22.5 (with `node:sqlite`)

The orchestrator persists all state through Node's built-in SQLite module
(`node:sqlite`), which first shipped in Node 22.5. Use an **official Node
build** — some distro builds strip the module. Tested with Node 22.22.

Install — pick one:

**NodeSource packages (Debian/Ubuntu):**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**nvm (any Linux/macOS, no root needed):**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# open a new shell, then:
nvm install 22
nvm use 22
```

**Official installer/binaries:** download from <https://nodejs.org>.

Verify both the version and the SQLite module:

```bash
node --version                      # must print v22.5.0 or newer
node -e "require('node:sqlite')"    # must exit silently (no error)
```

## npm

npm ships with Node.js — installing Node as above gives you npm. Verify:

```bash
npm --version
```

## tmux >= 3.x

Every agent runs as a real, interactive Claude Code session inside a tmux
session; the supervisor creates, watches, and types into those sessions. Tested
with tmux 3.4.

```bash
# Debian/Ubuntu
sudo apt install tmux

# macOS
brew install tmux
```

Verify:

```bash
tmux -V    # e.g. "tmux 3.4"
```

## Claude Code CLI, logged in via subscription OAuth

The agents are interactive Claude Code sessions billed against your **Claude
subscription** (Pro/Max). Tested with Claude Code 2.1.x.

Install:

```bash
npm install -g @anthropic-ai/claude-code
```

Then establish the subscription login **once**, as the same OS user that will
run the orchestrator:

```bash
claude
```

An interactive session starts; on first run it walks you through the OAuth
login — choose the **subscription** (claude.ai account) login, *not* an API
key. The credential is stored locally and reused by every agent session.

Verify:

```bash
claude --version    # e.g. 2.1.x
```

and start `claude` once more: an interactive session must open **without asking
for an API key or login**. (The installer only checks that the `claude` binary
exists — the login itself is exercised the first time an agent session starts.)

## No billing-flipping variables — verify it

This system is **subscription-billed only**. The Claude Code CLI silently
switches even interactive sessions to **pay-as-you-go metered or external
billing** when any of these variables is present — a whole fleet of agents on a
stray credential can get expensive fast:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `CLAUDE_CODE_USE_BEDROCK`
- `CLAUDE_CODE_USE_VERTEX`

This denylist (`src/core/billing.ts`) is enforced in three places: the
installer and the supervisor both **hard-refuse to run** when any of them is
set, and every agent launch additionally strips all four via `env -u`.

Verify that none of them is present:

```bash
env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE'    # must print nothing
```

If it prints anything, remove the variables from the current shell **and** from
your shell profiles (`~/.bashrc`, `~/.profile`, `~/.zshrc`, etc.), then open a
new shell and check again:

```bash
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX
grep -rnE "ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE" ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null
```

If you later run the supervisor under systemd, make sure the unit's
`Environment=` lines do not introduce any of these variables either.

## Optional / deferred backends

**None required.** The embedding backend (semantic memory search) and the media
generation backend are **deferred modules** in this version — the system runs
fully without them, and no optional service needs to be installed or configured.

## Quick check — everything at once

```bash
node --version && node -e "require('node:sqlite')" && \
npm --version && \
tmux -V && \
claude --version && \
{ env | grep -E 'ANTHROPIC|CLAUDE_CODE_USE' && echo "FAIL: remove the billing variables above" || echo "OK: no billing-flipping variables"; }
```

When all of the above succeed, proceed to the [install guide](INSTALL.en.md).
