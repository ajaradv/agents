# Remote operations

Three different “remote” shapes for this fleet. Pick the row that matches the job.

| Goal | Mechanism | Host OS |
|---|---|---|
| Crew/scout panes away from primary | Firstmate **remote secondmate** + Herdr `fm-remote` | **macOS** with GUI login |
| Alice on another machine | Pi + shared vault + synced `FLEET_INBOX` | macOS or Linux (Pi + vault) |
| SDLC / ADW batch factory | Ship checkout + `op run` + SSSF justfile | **Linux or macOS** |
| Phone → laptop shell / Herdr attach | Cloudflare Access + WARP, or Tailscale + SSH | Phone + laptop |

## Remote secondmates (worker panes)

Firstmate supports **whole homes** on another SSH host, not single remote panes. Upstream guide: [vendor/firstmate/docs/remote-secondmates.md](../vendor/firstmate/docs/remote-secondmates.md).

### Architecture

- **Primary** (your laptop): `FM_HOME=fleet/home`, routing, watcher, wake queue, Alice bus.
- **Remote Mac**: full secondmate home, projects, backlog, worker panes.
- **Agent pane**: always Herdr session **`fm-remote`** (survives SSH disconnect).
- **Control**: `fm-on.sh` → remote job worker → `fm-remote-secondmate-control.sh` (send, capture, state).
- **Replies**: mirrored via `fm-procevent-remote-reply.sh` into primary status.

### Provision (summary)

1. SSH alias on primary (pubkey, no agent forwarding).
2. Clone Firstmate on remote at absolute `root:`; symlink `fm-remote-entrypoint.sh` into `~/.local/bin`.
3. `bin/fm-on.sh <id> fm-remote-doctor.sh --fix` on primary.
4. `bin/fm-remote-home-seed.sh` per upstream docs; register route in `data/secondmates.md` on primary home.

### Config inheritance

**Inherited** to remote home: `crew-dispatch.json`, `crew-harness`, `launch-env-allowlist`, `backend`, etc.

**Not inherited** (set on each host): `fleet/home/.env`, `config/claude-account`, `config/pi-account`.

API keys on remote workers: 1Password `op run` on that Mac + allowlist, or Pi-stored provider logins.

### Hard constraints

- macOS GUI session for Herdr `fm-remote` server (LaunchAgent in Aqua login).
- FileVault / console login called out in upstream docs for headless Macs.
- Linux **cannot** host Firstmate remote secondmates (no supported Herdr fleet server path in this setup).

### Communication with remote crews

You do not SSH to individual crew panes. Primary uses:

- `fm-send` / peek / crew-state on the secondmate route
- Task reports under remote `data/<id>/` fetched via confined remote file reader
- Alice bus stays on **primary** repo: Firstmate still appends progress to `FLEET_INBOX/alice/events.jsonl` locally

Optional: register `lineage_atria` on the remote home so ship work runs there while you supervise from primary.

## Alice on another laptop

Alice is **not** a secondmate. She is `bin/launch alice` with:

- `ALICE_VAULT` — Obsidian vault root (default from `agent.yaml` or `/Users/avega/Workspace/brain`)
- `FLEET_INBOX` — agent JSONL bus (default: `<agents-repo>/fleet/inbox`)

If Firstmate stays on laptop A and Alice runs on laptop B:

1. Sync vault (Obsidian Sync, git, Syncthing).
2. Sync **`fleet/inbox/` only** (both JSONL files) or set `FLEET_INBOX` to a shared folder.
3. Same Cursor/Pi login and 1Password Environment on B.

See [fleet/inbox/README.md](../fleet/inbox/README.md).

## SDLC on remote servers (Linux)

Product code lives in the ship checkout, not in `agents/`.

```bash
git clone …/lineage_atria
# stamp SSSF from agents repo if needed
cd lineage_atria
op run --environment=agents-fleet -- \
  just -f .claude/skills/sssf/templates/justfile sdlc "your prompt"
```

Secrets: [templates/env.sample](../.claude/skills/sssf/templates/env.sample) (`OPENROUTER_API_KEY`, `HF_TOKEN`, etc.). No Herdr on Linux for this path.

Register the remote clone path in the Firstmate home that owns that work, or run ADW standalone without primary supervision.

## Phone → laptop (Herdr attach)

**Do not** publish Herdr on a public URL. Herdr is a local control plane (pane read, send-keys).

### Recommended: Cloudflare Zero Trust

1. `cloudflared` tunnel on laptop → **SSH only** (e.g. `ssh.fleet.example.com`).
2. Cloudflare **Access** policy (email / Google / 1Password IdP).
3. Phone: **WARP** + Termius/Prompt, or `cloudflared access ssh`.
4. On laptop: `herdr --session default` or attach to `fm-remote` locally.

### Alternative: Tailscale

Tailscale on laptop + phone → SSH to MagicDNS → local Herdr client.

Firstmate **voice** (Nova Sonic) is a separate path: laptop client → SSH → `fm-voice-relay.py` on desktop ([voice-relay.md](../vendor/firstmate/docs/voice-relay.md)). It speaks to **Firstmate**, not Alice.

## Alice chat/voice from phone

Not implemented in this repo. Action plans: [agents/alice/improvements/](../agents/alice/improvements/).
