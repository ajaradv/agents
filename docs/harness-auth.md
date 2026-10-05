# Harness authentication

How each billing lane authenticates for this fleet. Secrets never go in git. See [onepassword.md](onepassword.md) for vault layout.

## Billing lanes

| Lane | Who bills | Auth surface |
|---|---|---|
| Claude Code pane | Claude subscription | `claude auth login`; optional `FM_HOME/config/claude-account` |
| Cursor CLI pane | Cursor subscription | Cursor Agent CLI login; `cursor-agent --list-models` |
| Pi + cursor-sdk | Cursor (API-shaped) | Alice / Firstmate primaries only; same Cursor account as CLI |
| Pi + DeepSeek | DeepSeek API | `DEEPSEEK_API_KEY` + Pi catalog merge |
| Pi + Hugging Face | Hugging Face API | `HF_API_KEY` + Pi catalog merge |
| Pi + OpenRouter | OpenRouter API | `OPENROUTER_API_KEY` + Pi provider wiring |
| Jev (optional) | TypeSafe API | `TYPESAFE_API_KEY` in env or `fleet/home/.env` |

Dispatch defaults: [fleet/config/crew-dispatch.json](../fleet/config/crew-dispatch.json). Do not route Claude models through Cursor for crew panes.

## Subscription harnesses

### Claude Code (`harness: claude`)

```bash
claude auth login
claude auth status   # required before fm-spawn launches a worker
```

Optional pin: `fleet/home/config/claude-account` — one line, `ordinary` or absolute path to a dedicated Claude config directory. A pinned launch **unsets** env credentials such as `ANTHROPIC_API_KEY` so subscription login wins. Do not put API keys in `.env` if you rely on a pin.

### Cursor CLI (`harness: cursor`)

```bash
cursor-agent --list-models   # confirm login; align model ids in crew-dispatch.json
```

Use **grok** for scout/recon and **composer** for ship work only.

### Pi primaries (Alice, Firstmate) — `pi-cursor-sdk`

```bash
just alice      # cursor/composer-2.5
just firstmate  # cursor/grok-4.7@256k
```

These use **`npm:pi-cursor-sdk`**, which talks to Cursor through the **Cursor SDK**, not the same login as **`harness: cursor`** crew panes (Cursor Agent CLI subscription).

**Auth (pick one):**

1. In Pi: `/login` → API key → **Cursor** (stored in Pi’s auth store — no env var required on later launches).
2. Environment: **`CURSOR_API_KEY`** (Cursor SDK API key from your Cursor account / SDK settings). Add to [fleet/home/.env](onepassword.md) or `op run` via [env.op.example](../fleet/config/env.op.example).

Without a key or stored login, `cursor/composer-2.5` and `cursor/grok-4.7` will fail even if `cursor-agent` works for crew spawns.

Extensions come from `agents/*/agent.yaml` via `bin/launch`, not global `~/.pi/agent/settings.json` packages.

## API harnesses (Pi crews)

Run **`just merge-pi-providers`** to merge tracked snippets into `~/.pi/agent/models-store.json` without removing other providers:

- [fleet/config/pi-deepseek-provider.json](../fleet/config/pi-deepseek-provider.json) — `deepseek-chat`, `deepseek-reasoner`
- [fleet/config/pi-huggingface-provider.json](../fleet/config/pi-huggingface-provider.json) — router base + starter model; run `pi --list-models huggingface` for more ids

**OpenRouter** uses Pi’s built-in `openrouter` provider; set **`OPENROUTER_API_KEY`** only (no merge file).

Set keys via [onepassword.md](onepassword.md) or `just firstmate-op` / `just alice-op`. `fleet/home/.env` may be a 1Password FIFO — `bin/launch` reads it with a 2s timeout so `just firstmate` does not hang.

For worker panes in tmux/Herdr, list key **names** in `config/launch-env-allowlist` (inherited to remote secondmate homes); values must exist in the **destination pane** environment when spawned.

Optional Pi pin: `fleet/home/config/pi-account` — line 1: Pi root; line 2: space-separated providers (e.g. `deepseek openrouter huggingface cursor`).

## quota-axi

Install [quota-axi](https://github.com/kunchenguid/quota-axi) on PATH. Firstmate runs it once per dispatch intake; `spendPriority` ranks profiles that pass eligibility gates. It is data-only — it does not pick routes by itself.

```bash
quota-axi              # default TOON
quota-axi auth --json  # when a candidate's credential surface is unclear
```

## Jev (typed dispatch)

Optional rule match before quota chooses a profile:

```bash
# key in environment or fleet/home/.env
bin/fm-dispatch-resolve.sh data/<id>/brief.md --project <name>
```

Off = one stderr line, no network; Firstmate still dispatches with judgment.

## Worker launch allowlist

If `fleet/home/config/launch-env-allowlist` exists, only listed env **names** pass to new workers (plus Firstmate's operational floor). Example: [fleet/config/launch-env-allowlist.example](../fleet/config/launch-env-allowlist.example).

## Per-host replication checklist

1. `bin/seed-fleet-home`
2. 1Password Environment `agents-fleet` (mount or `op run`)
3. Subscription logins (Claude, Cursor, Pi cursor provider)
4. Pi catalog merges for API providers you use
5. `config/claude-account` / `config/pi-account` on **each** host that runs workers (not inherited from primary)
6. `quota-axi` on PATH

Remote secondmates: inherited config includes `crew-dispatch.json` and `launch-env-allowlist`; **not** inherited: `.env`, `claude-account`, `pi-account`. See [remote-ops.md](remote-ops.md).
