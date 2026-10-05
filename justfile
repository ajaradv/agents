set dotenv-load := true

root := justfile_directory()
ext := root / "extensions"
scripts := root / "scripts"
fm := root / "vendor" / "firstmate"
fm_extra := root / "agents" / "firstmate" / "extensions"
catalog_system := root / "prompts" / "system" / "sr_opus_5_system_prompt.md"

default:
    @just --list

# Install extension deps and init submodules (bin/setup).
setup:
    #!/usr/bin/env bash
    cd "{{root}}" && bin/setup && bun install

# Merge DeepSeek + Hugging Face into ~/.pi/agent/models-store.json (OpenRouter: Pi builtin + OPENROUTER_API_KEY)
merge-pi-providers:
    cd "{{root}}" && bin/merge-pi-providers

# Launch from agents/<id>/agent.yaml (control center)
launch agent:
    cd "{{root}}" && bin/launch {{agent}}

alice:
    cd "{{root}}" && bin/launch alice

firstmate:
    cd "{{root}}" && bin/launch firstmate

# 1Password CLI: op run --env-file with op:// references (see fleet/config/env.op.example)
# Requires: op signin, fleet/home/.env.op copied from env.op.example
alice-op:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{root}}"
    op_env="${OP_ENV_FILE:-$root/fleet/home/.env.op}"
    if [[ ! -f "$op_env" ]]; then
      echo "missing $op_env — copy fleet/config/env.op.example to fleet/home/.env.op and set op:// paths" >&2
      exit 1
    fi
    cd "$root" && op run --env-file="$op_env" -- bin/launch alice

firstmate-op:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{root}}"
    op_env="${OP_ENV_FILE:-$root/fleet/home/.env.op}"
    if [[ ! -f "$op_env" ]]; then
      echo "missing $op_env — copy fleet/config/env.op.example to fleet/home/.env.op and set op:// paths" >&2
      exit 1
    fi
    cd "$root" && op run --env-file="$op_env" -- bin/launch firstmate

architect:
    cd "{{root}}" && bin/launch architect

dashboard:
    cd "{{root}}" && bun run dashboard/server.ts

architect-op:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{root}}"
    op_env="${OP_ENV_FILE:-$root/fleet/home/.env.op}"
    if [[ ! -f "$op_env" ]]; then
      echo "missing $op_env — copy fleet/config/env.op.example to fleet/home/.env.op and set op:// paths" >&2
      exit 1
    fi
    cd "$root" && op run --env-file="$op_env" -- bin/launch architect

# ── single extensions (same names as atria-factory) ───────────────────────

pure-focus:
    pi -e "{{ext}}/pure-focus.ts"

minimal:
    pi -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts"

cross-agent:
    pi -e "{{ext}}/cross-agent.ts" -e "{{ext}}/minimal.ts"

purpose-gate:
    pi -e "{{ext}}/purpose-gate.ts" -e "{{ext}}/minimal.ts"

tool-counter:
    pi -e "{{ext}}/tool-counter.ts"

tool-counter-widget:
    pi -e "{{ext}}/tool-counter-widget.ts" -e "{{ext}}/minimal.ts"

subagent-widget:
    pi -e "{{ext}}/subagent-widget.ts" -e "{{ext}}/pure-focus.ts" -e "{{ext}}/theme-cycler.ts"

tilldone:
    pi -e "{{ext}}/tilldone.ts" -e "{{ext}}/theme-cycler.ts"

agent-team:
    pi -e "{{ext}}/agent-team.ts" -e "{{ext}}/theme-cycler.ts"

system-select:
    pi -e "{{ext}}/system-select.ts" -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts"

damage-control:
    pi -e "{{ext}}/damage-control.ts" -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts"

damage-control-continue:
    pi -e "{{ext}}/damage-control-continue.ts" -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts"

agent-chain:
    pi -e "{{ext}}/agent-chain.ts" -e "{{ext}}/theme-cycler.ts"

pi-pi:
    pi -e "{{ext}}/pi-pi.ts" -e "{{ext}}/theme-cycler.ts"

session-replay:
    pi -e "{{ext}}/session-replay.ts" -e "{{ext}}/minimal.ts"

theme-cycler:
    pi -e "{{ext}}/theme-cycler.ts" -e "{{ext}}/minimal.ts"

daily:
    pi -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts" -e "{{ext}}/cross-agent.ts" -e "{{ext}}/damage-control-continue.ts"

# Stack extensions by name (omit .ts): just open minimal damage-control
open +exts:
    #!/usr/bin/env bash
    args=""
    for e in {{exts}}; do
        args="$args -e '{{ext}}/$e.ts'"
    done
    eval "pi$args"

# Pi on another repo; appends the catalog system prompt. Example:
#   just at /path/to/repo daily
at target +exts:
    #!/usr/bin/env bash
    set -euo pipefail
    args="--append-system-prompt '{{catalog_system}}'"
    for e in {{exts}}; do
        case "$e" in
            daily)
                args="$args -e '{{ext}}/minimal.ts' -e '{{ext}}/theme-cycler.ts' -e '{{ext}}/cross-agent.ts' -e '{{ext}}/damage-control-continue.ts'"
                ;;
            minimal)
                args="$args -e '{{ext}}/minimal.ts' -e '{{ext}}/theme-cycler.ts'"
                ;;
            *)
                args="$args -e '{{ext}}/$e.ts'"
                ;;
        esac
    done
    cd "{{target}}"
    eval "pi $args"

# Pi in vendor/firstmate submodule only (not fleet/home). Optional extensions: just firstmate-vendor minimal
firstmate-vendor +exts:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ ! -d "{{fm}}" ]]; then
        echo "missing {{fm}}; run: bin/setup" >&2
        exit 1
    fi
    args="--approve"
    for e in {{exts}}; do
        args="$args -e '{{ext}}/$e.ts'"
    done
    shopt -s nullglob
    for f in "{{fm_extra}}"/*.ts; do
        args="$args -e '$f'"
    done
    cd "{{fm}}"
    eval "pi $args"

local-coms *args:
    pi -e "{{ext}}/coms.ts" -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts" {{args}}

coms-net-server:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs kill -TERM 2>/dev/null || true
    bun "{{scripts}}/coms-net-server.ts"

coms-net-server-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs kill -TERM 2>/dev/null || true
    PI_COMS_NET_HOST=0.0.0.0 bun "{{scripts}}/coms-net-server.ts"

coms *args:
    pi -e "{{ext}}/coms-net.ts" -e "{{ext}}/minimal.ts" -e "{{ext}}/theme-cycler.ts" {{args}}
