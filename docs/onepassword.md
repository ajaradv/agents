# 1Password for the fleet

Replicable secret layout for the agents control center. Values never belong in git.

## Vault: `Fleet`

Create a dedicated vault (not Personal). Two kinds of items:

### Developer Environment: `agents-fleet`

Use the same variable **names** on every machine (laptop, remote Mac, Linux SDLC host).

| Variable | Consumer |
|---|---|
| `TYPESAFE_API_KEY` | Jev — `fleet/home/.env` or env |
| `DEEPSEEK_API_KEY` | Pi DeepSeek crews |
| `OPENROUTER_API_KEY` | Pi OpenRouter + SSSF ADW on ships |
| `HF_API_KEY` | Pi Hugging Face inference (`HF_TOKEN` mirrored by `bin/launch` when only one is set) |
| `CURSOR_API_KEY` | **Alice / Firstmate primaries** via `pi-cursor-sdk` (Cursor SDK API key) |
| `ANTHROPIC_API_KEY` | Optional — Pi native Anthropic only; **not** if Claude Code subscription + pinned account |

Names-only template: [fleet/config/env.example](../fleet/config/env.example).  
CLI secret references: [fleet/config/env.op.example](../fleet/config/env.op.example).

### Secure Notes (no tokens)

Checklists per harness: `claude auth status`, `cursor-agent --list-models`, `pi auth check`, `quota-axi`. Document where **account pins** live on disk (`config/claude-account`, `config/pi-account`) — pins are per-machine files, not Environment variables.

## This Mac: three ways to inject secrets

### A. Plain `.env` (simplest local dev)

Put literal values in **`fleet/home/.env`** (gitignored). `bin/launch` exports allowlisted names into Pi when they are not already in your shell. Firstmate Jev also reads `TYPESAFE_API_KEY` from this file.

Do not commit values. Use for one machine only.

### B. 1Password CLI `op run` (recommended for replication)

Your installed CLI (`op --version`) uses **`op run --env-file=…`**, not `--environment=`. The `--environment` flag is for **1Password Developer Environments** in the desktop app (optional; see C).

1. `op signin` (and `op account list` if needed).
2. Create items in vault **Fleet** for each secret (or one item with many fields).
3. Copy [fleet/config/env.op.example](../fleet/config/env.op.example) → **`fleet/home/.env.op`**.
4. Replace each `op://Vault/Item/field` path with real references (`op item list`, 1Password UI “copy secret reference”).
5. Test:

```bash
op run --env-file=fleet/home/.env.op -- printenv CURSOR_API_KEY
just firstmate-op
just alice-op
```

Override path: `OP_ENV_FILE=/path/to/.env.op just alice-op`.

### C. Developer Environments mount (desktop app + MCP)

If you use 1Password **Environments** (Labs in the desktop app), you can mount secrets at **`fleet/home/.env`** as a FIFO. Then **`just firstmate`** / **`just alice`** may be enough — no `*-op` recipes. This is separate from `op run --environment=`, which standard CLI 2.x does not support.

Do not read mounted `.env` paths into chat; use 1Password’s variable list tools.

## tmux / Herdr workers

Worker panes take allowlisted credentials from the **pane environment at spawn time**, not from Firstmate's process. Start tmux/Herdr from a shell that already ran `op run`, or rely on keys stored in Pi's account root via `pi auth`.

Copy [fleet/config/launch-env-allowlist.example](../fleet/config/launch-env-allowlist.example) to `fleet/home/config/launch-env-allowlist` when filtering worker env.

## Remote hosts

Do **not** copy `.env` over SSH.

1. Install 1Password CLI on the remote host.
2. Use a **Service Account** (or Connect) scoped to vault `Fleet`.
3. Run workers and SDLC with:

```bash
op run --env-file=fleet/home/.env.op -- just -f .claude/skills/sssf/templates/justfile sdlc "…"
```

Remote secondmate homes need their **own** Claude/Cursor/Pi subscription or pin files on that Mac; Environment only supplies API keys.

## Do not

- Store Claude or Cursor OAuth tokens in Environment (use vendor login + Keychain).
- Enable SSH agent forwarding for Firstmate (`fm-on.sh` disables it).
- Put `ANTHROPIC_API_KEY` in Environment if workers use pinned Claude subscription accounts.
- Expose Herdr or `fm-remote` on a public hostname.

## Windows

1Password local `.env` mounts are not supported on Windows. Use:

```bash
op run --environment=<environmentId> -- <command>
```

See the 1Password Environments skill in Cursor plugins.
