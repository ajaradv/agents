# Agents control center

> **Work in progress.** This is a personal, actively changing system. Interfaces, file layouts and agent roles move week to week, and parts of this README lag behind the code. Expect rough edges; nothing here is a stable API.

## Why this exists

One person, several software projects, and a crew of AI agents doing the work. This repo is the control center for that crew: it defines who the agents are, what they may do, how they are launched, and how their work is watched, gated and paid for.

The goals:

- **One officer to talk to.** Alice is the captain's (the owner's) chief of staff. She takes requests in a chat, looks things up, and hands work to the right crew. The aim is an "omni agent": she acts only through typed tools (no shell), remembers what matters, and eventually takes up work on her own when the feedback says it is wanted.
- **Crews per project.** Each project (a *ship*) gets a crew: a lead, a builder, a scout, a helmsman, a designer. They work in their own checkouts and worktrees, report back through the fleet, and never merge or deploy on their own.
- **Cheap, checked decisions.** Small judgment calls (is this tool call safe? did this order step do what it said? should this context be compacted?) go to Jev, a system-one model that answers typed questions for fractions of a cent. Anything risky waits for the captain's Go.
- **Everything observable.** Every turn, tool failure, gate decision and voyage is recorded, so the fleet can be asked exact questions about what it did and what it cost.

## How it fits together

| Piece | What it is |
|---|---|
| **The hub** | An exe.dev VM that runs the fleet node, the dashboard, Alice and the officers. The laptop is a client and a ship host. Deploy with `bin/hub-deploy`. |
| **Node** (`dashboard/node.ts`) | Owns the agents: starts them, routes messages, runs routines and orders, keeps the databases (`metrics.db`, `journal.db`, per-ship logs). |
| **Dashboard** (`dashboard/server.ts`) | The captain's UI: chat with any agent, what needs a decision, health, spend. |
| **Agents** (`agents/<id>/agent.yaml`, `roles/<id>.md`) | pi agents with a model, extensions, tools and a role prompt. `bin/launch` starts one. |
| **Fleet tools** (`extensions/fleet.ts`) | The typed tools agents use: fleet status, ship tasks and logs, `fleet_query` for numbers, the vault tools, Go-gated actions. |
| **Tool gate** (`extensions/tool-gate.ts`) | Every tool call passes local rules, then Jev; in observe mode it logs what it would hold, in enforce mode it holds or stops. |
| **Orders** (`docs/orders.md`) | Short, exact sequences of fleet actions Alice runs step by step, each checked against the plan. |
| **The vault** | An Obsidian vault (`~/Workspace/brain`): plans, research, tasks with "Done when" checklists, the captain's profile. The node mirrors it into SQLite for search; `bin/vault-sync` keeps laptop and hub in step. |
| **SSSF** (`.claude/skills/sssf/`) | The software-factory workflows (ADWs) stamped into ship repos. |

## Status and what is next

The current focus is Alice's memory and tools (vault plan `fleet/plans/research/alice-memory-and-tools.md`), in phases:

- **M0** cleanup and note summaries — done
- **M1** typed fleet and vault tools, the vault mirror, a session brief — done
- **M2** facts in `journal.db`, `remember`, observations with expiry, a capped state file
- **M3** Jev intent routing, and Alice without bash
- **M4** extraction: Jev proposes what to remember, the captain approves
- **M5** proactive work from feedback
- **M6** local embeddings for the vault

`bin/fleet-axi next` lists the open steps of every active vault task.

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
vendor/gsap-skills/        greensock GSAP skills (Designer motion work)
vendor/motion-design-skill/ LottieFiles motion-design craft skill (Designer)
vendor/three-agent-skills/ Three.js + R3F best-practice skills (Designer)
bin/launch                 start an agent from agent.yaml
bin/setup                  submodules + bun + alice vault
.github/workflows/ci.yml   pull requests and main: typecheck, tests, secret scan
bin/setup-alice-vault      brain inbox + obsidian skill symlinks
bin/voice-setup            local text-to-speech model (Kokoro) for dashboard voice replies
bin/seed-fleet-home        copy vendor/firstmate → fleet/home
bin/new-agent              scaffold agents/<id>, roles/<id>.md, just recipe, inbox, README row
bin/stamp-ship             fleet/ships/<id>.yaml + copy SSSF into a ship + install.py (+ optional Firstmate registration)
bin/agent-portrait         rail portrait for an agent in the house pixel style (OpenRouter image model)
docs/harness-auth.md       per-harness login and API keys
docs/onepassword.md        vault Fleet, Environment agents-fleet
docs/remote-ops.md         Herdr secondmates, Alice relocate, SDLC, phone SSH
docs/architect.md          plan pipeline, vault plans, Firstmate triage
docs/dashboard.md          localhost fleet UI, chat bar, usage (htmx + SSE)
docs/tool-standards.md     how tools are built: AXI output rules, checks (just test, just axi-check)
docs/system-one.md         Jev (system-one) decisions: when to use, the client, questions, thresholds, data
bin/fleet-axi              the fleet from any shell (read-only): ships, waiting on the captain, vault tasks, Jev, gate
dashboard/                 Bun server + static UI
agents/alice/improvements/ phone chat/voice action plans (later)
```

## Ships

| Ship | Path | Factory |
|---|---|---|
| `lineage_atria` | `/Users/avega/Workspace/lineage_atria` | `.claude/skills/sssf` (stamped) |
| `pochteca` | `/Users/avega/Workspace/pochteca` | none yet |
| `fleet` | this repo | none (meta ship) |
| `kinwork` | `/Users/avega/Workspace/Kinwork` | none (Django; design records from the Designer) |

Record definitions: [fleet/ships/](fleet/ships/).

## Two lifecycles

| Where | Role | Examples |
|---|---|---|
| **This repo** | Interactive Pi, Firstmate, Alice, Architect, Shipwright, Designer | `just setup`, `bin/launch alice`, `bin/launch firstmate`, `just architect` |
| **Stamped ship** | ADW control plane + trace | `just demo`, `just sdlc` inside `lineage_atria` |

## Setup

```bash
cd /Users/avega/Workspace/agents
just setup                 # bin/setup + bun install
bin/setup-alice-vault      # brain vault inbox + obsidian skill symlinks
```

Firstmate submodule: `vendor/firstmate` (upstream `kunchenguid/firstmate` added by `bin/setup`).

## CI

Pull requests and pushes to `main` run [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on Ubuntu 24.04: Bun 1.4.4 (the version `bin/hub-install` pins), `bun install --frozen-lockfile`, `tsc -p .`, and `bun test` in `dashboard/`. A second job scans the full git history with gitleaks. Shellcheck over the shell scripts in `bin/` is reported and does not fail the workflow. The gate is that Linux job, the same family as `bin/hub-install`. Login Keychain and launchd stay on the laptop; this suite covers them with the file secret store and in-process fakes.

Reproduce the required jobs locally:

```bash
git submodule update --init --recursive   # public remotes; no token
bun install --frozen-lockfile             # Bun 1.4.0
just typecheck                            # node_modules/.bin/tsc -p .
just test                                 # cd dashboard && bun test
```

Secret scan (gitleaks 8.30.1, full history; the committed `.gitleaks.toml` is picked up automatically):

```bash
gitleaks detect --log-opts="--all" --redact --no-banner
```

Shellcheck (advisory; Ubuntu's shellcheck 0.9.0 in CI):

```bash
find bin -type f -exec grep -lE '^#!.*(bash|/sh)$' {} + | xargs shellcheck
```

## Launch agents

```bash
just alice                 # Pi + cursor-sdk, composer-2.5, vault cwd
just firstmate             # Pi + cursor-sdk, grok-4.7@256k, fleet/home
just alice-op              # op run --env-file=fleet/home/.env.op (see fleet/config/env.op.example)
just firstmate-op
just architect             # Pi + grok-4.7@256k, vault cwd, plan review primary
just shipwright            # Pi + composer-2.5, repo cwd, new agents + SSSF stamping
just designer              # Pi + gpt-5.5, whole impeccable sessions; shares its session with dashboard chat
just architect-op
just dashboard             # http://127.0.0.1:8787 — usage, fleet, chat rail, Firstmate TUI start/stop
bin/launch alice -- -p "…" # extra pi args after --
```

Override vault and bus: `ALICE_VAULT`, `FLEET_INBOX`. See [fleet/inbox/README.md](fleet/inbox/README.md) and [docs/remote-ops.md](docs/remote-ops.md).

Only **pi** is wired in this slice. Other harness names in `agent.yaml` are stored and refused until implemented.

Default models (listed per agent in `agents/<id>/agent.yaml`, not in `~/.pi/agent/settings.json`; Cursor models go through `pi-cursor-sdk`). **Do not** route Claude through Cursor for crew panes — use Claude Code (`harness: claude`) for subscription coding, or Grok/Composer for Cursor lanes.

| Agent | Model | Why |
|---|---|---|
| Alice | `openrouter/deepseek/deepseek-v4-pro` | The captain's officer: typed fleet and vault tools, long sessions |
| Firstmate | `openrouter/deepseek/deepseek-v4-pro` | Routing and supervision (being retired in favor of Alice) |
| Architect | `cursor/grok-4.7@256k` | Interactive plan review; workers spawned by Firstmate |
| Shipwright | `cursor/composer-2.5` | Repo upkeep: new agents, ship stamping |
| Designer | `openrouter/anthropic/claude-sonnet-5.5` | Design taste and image reading; impeccable comps and critique |

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

- **Rule ids:** each rule in `crew-dispatch.json` has a stable `id` (`news-scout`, `scout`, `plan-greenfield`, `plan-scoped`, `mechanical`, `big-ship`, `api-fallback`). Architect plans and Jev routing refer to rules by id; Firstmate's validator ignores the extra key. Cursor profiles carry the effort in the model name (`grok-4.7-high`), never an `effort` field.
- **Secrets:** [docs/onepassword.md](docs/onepassword.md) — vault **Fleet**, Environment **agents-fleet**; names in [fleet/config/env.example](fleet/config/env.example).
- **DeepSeek / Hugging Face:** `just merge-pi-providers` (from [pi-deepseek-provider.json](fleet/config/pi-deepseek-provider.json) and [pi-huggingface-provider.json](fleet/config/pi-huggingface-provider.json)). **OpenRouter:** Pi builtin + `OPENROUTER_API_KEY`.
- **OpenRouter / native Anthropic API:** operator-owned keys and Pi provider wiring; dispatch names the lane in `crew-dispatch.json`.
- **Harness setup:** [docs/harness-auth.md](docs/harness-auth.md).
- **quota-axi:** external CLI on PATH; ranks profiles by spend priority after auth probe.
- **Jev (optional):** `TYPESAFE_API_KEY` in `fleet/home/.env`; `bin/fm-dispatch-resolve.sh` selects a dispatch rule before quota chooses a profile. `bin/fleet-route-resolve.sh` (dashboard **Auto**) picks who owns a message: an agent, a group (its lead), or Firstmate.
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
- Ideas / requests / initiatives / plans: `brain/fleet/ideas/`, `brain/fleet/requests/`, `brain/fleet/initiatives/`, `brain/fleet/plans/` — see [docs/architect.md](docs/architect.md).

**Tools** ([pi-obsidian](https://pi.dev/packages/pi-obsidian)): read, search, append, tags, backlinks, Kanban, Canvas, daily notes.

**Skills** ([kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)): OFM, Bases, JSON Canvas, CLI — linked under `brain/.pi/skills/`. Query routing is in [roles/alice.md](roles/alice.md).

## Stamp / refresh a factory on a ship

Preferred: `bin/stamp-ship <id> <path> [--adws ...] [--mode ...] [--register "desc"] --dry-run`, or ask **Shipwright** (`just shipwright` or the dashboard rail). The manual steps below are what the script runs.

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
