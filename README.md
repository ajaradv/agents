# Agents control center

Fleet catalog: agent personas, harness defaults, Pi extensions, software-factory (SSSF) source, and ship definitions. Product code lives in ship checkouts; this repo defines how agents are launched and which factory gets stamped where.

## Layout

```
agents/<id>/agent.yaml     deployment: type, harness, model, extensions, skills
roles/<id>.md              persona (passed as Pi --append-system-prompt)
agents/config.yaml         npm extension allowlist by agent type
extensions/                pi-vs-cc extensions (interactive stacks via justfile)
.claude/skills/sssf/       SSSF skill + ADW templates (migrated from atria-factory)
fleet/ships/*.yaml         ship → path, orchestrator, factory stamp, mode
fleet/inbox/               agent event bus JSONL (gitignored)
fleet/config/              crew-harness + crew-dispatch (copied into fleet/home/config on seed)
fleet/home/                firstmate FM_HOME (gitignored; seeded from vendor/firstmate)
vendor/firstmate/          firstmate distro (ajaradv fork)
vendor/obsidian-skills/    kepano obsidian skills (symlinked into brain vault)
bin/launch                 start an agent from agent.yaml
bin/setup                  submodules + bun + alice vault
bin/setup-alice-vault      brain inbox + obsidian skill symlinks
bin/seed-fleet-home        copy vendor/firstmate → fleet/home
docs/harness-auth.md       per-harness login and API keys
docs/onepassword.md        vault Fleet, Environment agents-fleet
docs/remote-ops.md         Herdr secondmates, Alice relocate, SDLC, phone SSH
docs/architect.md          plan pipeline, vault plans, Firstmate triage
docs/dashboard.md          localhost fleet UI, chat bar, usage (htmx + SSE)
dashboard/                 Bun server + static UI
agents/alice/improvements/ phone chat/voice action plans (later)
```

## Ships

| Ship | Path | Factory |
|---|---|---|
| `lineage_atria` | `/Users/avega/Workspace/lineage_atria` | `.claude/skills/sssf` (stamped) |
| `pochteca` | `/Users/avega/Workspace/pochteca` | none yet |
| `fleet` | this repo | none (meta ship) |

Record definitions: [fleet/ships/](fleet/ships/).

## Two lifecycles

| Where | Role | Examples |
|---|---|---|
| **This repo** | Interactive Pi, Firstmate, Alice, Architect | `just setup`, `bin/launch alice`, `bin/launch firstmate`, `just architect` |
| **Stamped ship** | ADW control plane + trace | `just demo`, `just sdlc` inside `lineage_atria` |

## Setup

```bash
cd /Users/avega/Workspace/agents
just setup                 # bin/setup + bun install
bin/setup-alice-vault      # brain vault inbox + obsidian skill symlinks
```

Firstmate submodule: `vendor/firstmate` (upstream `kunchenguid/firstmate` added by `bin/setup`).

## Launch agents

```bash
just alice                 # Pi + cursor-sdk, composer-2.5, vault cwd
just firstmate             # Pi + cursor-sdk, grok-4.7@256k, fleet/home
just alice-op              # op run --env-file=fleet/home/.env.op (see fleet/config/env.op.example)
just firstmate-op
just architect             # Pi + grok-4.7@256k, vault cwd, plan review primary
just architect-op
just dashboard             # http://127.0.0.1:8787 — usage cards, Herdr Alice start/stop
bin/launch alice -- -p "…" # extra pi args after --
```

Override vault and bus: `ALICE_VAULT`, `FLEET_INBOX`. See [fleet/inbox/README.md](fleet/inbox/README.md) and [docs/remote-ops.md](docs/remote-ops.md).

Only **pi** is wired in this slice. Other harness names in `agent.yaml` are stored and refused until implemented.

Default models (Cursor via `pi-cursor-sdk`, listed per agent, not in `~/.pi/agent/settings.json`). **Do not** route Claude through Cursor for crew panes — use Claude Code (`harness: claude`) for subscription coding, or Grok/Composer for Cursor lanes.

| Agent | Model | Why |
|---|---|---|
| Alice | `cursor/composer-2.5` | Vault inbox and ship-shaped actions on Cursor |
| Firstmate | `cursor/grok-4.7@256k` | Routing, supervision, and recon-shaped primary work |
| Architect | `cursor/grok-4.7@256k` | Interactive plan review; workers spawned by Firstmate |

## Crew dispatch and billing lanes

Source of truth: [fleet/config/](fleet/config/). After `bin/seed-fleet-home`, files appear under `fleet/home/config/` only when missing locally (your edits are not overwritten).

| Lane | Who bills | Firstmate launches |
|---|---|---|
| Claude Code pane | Claude subscription | `harness: claude` |
| Cursor CLI pane | Cursor subscription | `harness: cursor` + `grok-4.7` or `composer-2.5` |
| Pi + cursor-sdk | Cursor API-shaped | Alice / Firstmate primaries only |
| Pi + DeepSeek | DeepSeek API | `harness: pi` + `deepseek/...` + `provider: deepseek` |
| Pi + Hugging Face | Hugging Face API | `harness: pi` + `huggingface/...` + `HF_API_KEY` |
| Pi + OpenRouter | OpenRouter API | `harness: pi` + `openrouter/...` — you add key and model id |

- **Secrets:** [docs/onepassword.md](docs/onepassword.md) — vault **Fleet**, Environment **agents-fleet**; names in [fleet/config/env.example](fleet/config/env.example).
- **DeepSeek / Hugging Face:** `just merge-pi-providers` (from [pi-deepseek-provider.json](fleet/config/pi-deepseek-provider.json) and [pi-huggingface-provider.json](fleet/config/pi-huggingface-provider.json)). **OpenRouter:** Pi builtin + `OPENROUTER_API_KEY`.
- **OpenRouter / native Anthropic API:** operator-owned keys and Pi provider wiring; dispatch names the lane in `crew-dispatch.json`.
- **Harness setup:** [docs/harness-auth.md](docs/harness-auth.md).
- **quota-axi:** external CLI on PATH; ranks profiles by spend priority after auth probe.
- **Jev (optional):** `TYPESAFE_API_KEY` in `fleet/home/.env`; `bin/fm-dispatch-resolve.sh` selects a dispatch rule before quota chooses a profile.
- **Remote crews / phone SSH:** [docs/remote-ops.md](docs/remote-ops.md).
- **Alice phone chat/voice (later):** [agents/alice/improvements/](agents/alice/improvements/).

```bash
bin/seed-fleet-home   # vendor firstmate + install fleet/config into fleet/home/config
just firstmate        # scout on lineage_atria should prefer claude, then cursor/grok
```

## Alice: vault inbox and Obsidian

- Vault: `/Users/avega/Workspace/brain` (open in Obsidian).
- Human inbox: `brain/fleet/inbox/` — drop notes; Alice reads them at session start.
- Agent bus (this repo): `fleet/inbox/alice/events.jsonl`, `fleet/inbox/firstmate/events.jsonl`, `fleet/inbox/architect/events.jsonl`.
- Ideas / requests / plans: `brain/fleet/ideas/`, `brain/fleet/requests/`, `brain/fleet/plans/` — see [docs/architect.md](docs/architect.md).

**Tools** ([pi-obsidian](https://pi.dev/packages/pi-obsidian)): read, search, append, tags, backlinks, Kanban, Canvas, daily notes.

**Skills** ([kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)): OFM, Bases, JSON Canvas, CLI — linked under `brain/.pi/skills/`. Query routing is in [roles/alice.md](roles/alice.md).

## Stamp / refresh a factory on a ship

From this repo (source of truth for SSSF):

```bash
mkdir -p /path/to/ship/.claude/skills
cp -R /Users/avega/Workspace/agents/.claude/skills/sssf /path/to/ship/.claude/skills/
cd /path/to/ship
uv run .claude/skills/sssf/scripts/install.py
```

`install.py` skips existing files. Use `--force` only when you intend to overwrite stamped prompts and config.

`lineage_atria` was stamped in the initial fleet setup; run the same commands to refresh after editing templates here.

## Interactive Pi (non-agent)

```bash
just daily
just at /Users/avega/Workspace/lineage_atria daily
just firstmate-vendor      # pi in vendor/firstmate submodule (not fleet/home; use just firstmate for control center)
```

## atria-factory

SSSF content was copied from [atria-factory](/Users/avega/Workspace/atria-factory). Ship YAML no longer points there. The old repo is unchanged; edit factories here under `.claude/skills/sssf/`.
