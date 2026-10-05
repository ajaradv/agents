# Architect and plan pipeline

Firstmate stays the router. Architect does not see every captain note. Mechanical work skips planning. Plans live in the Obsidian vault (`ALICE_VAULT`) so you can read markdown or open a Lavish board before work becomes crew briefs.

## Flow

1. Captain drops notes in **`{vault}/fleet/inbox/`**.
2. **Alice** ingests into **`fleet/ideas/`** (unscoped thoughts) or **`fleet/requests/`** (actionable asks; include ship when known).
3. Alice enqueues Firstmate with **`kind: request`** and a vault **`ref`** to the note.
4. **Firstmate — step 1:** execute now (mechanical, obvious ship) → ship/scout spawn using **implementation** rules in `crew-dispatch.json`. Otherwise → needs a plan.
5. **Firstmate — step 2:** for plan drafts, match a **planning** rule (Jev via `TYPESAFE_API_KEY` + `bin/fm-dispatch-resolve.sh` when enabled, else judgment on the same `when` text), rank profiles with **quota-axi**, then **`fm-spawn`** an Architect-role worker with the winning harness/model/effort.
6. The worker writes **`fleet/plans/<category>/<slug>.md`** with **`status: draft`**, appends **`FLEET_INBOX/firstmate/events.jsonl`** (`kind: plan-draft`), and Firstmate logs **`FLEET_INBOX/architect/events.jsonl`** for the interactive Architect.
7. Captain reviews in Obsidian (and optionally Lavish). Status: **`draft` → `reviewed` → `finalized`**. Only **`finalized`** is executable.
8. On **`finalized`**, Architect (or captain via Architect) sends **`kind: plan-ready`** to Firstmate. Firstmate **`fm-brief`** + **`fm-spawn`** using **implementation** dispatch, not the planning profile array.

## Surfaces

| Surface | Command | Model | Role |
|---|---|---|---|
| Interactive primary | `just architect` / `just architect-op` | `cursor/grok-4.7@256k` | Review, revise, captain-driven finalize |
| Dispatched worker | Firstmate `fm-spawn` | Jev + quota from planning rules | Write draft plans from inbox events |

Planning lanes prefer **Claude Code** high/xhigh or medium, then **Cursor Grok** — never Claude-via-Cursor. API fallbacks use the same Pi providers as ship dispatch when subscriptions are exhausted.

## Vault layout

```text
fleet/inbox/              # human drop zone
fleet/ideas/
fleet/requests/
fleet/plans/{project,feature,bugfix,refactor,research,ops}/
```

Plan frontmatter: `title`, `category`, `status`, `ship`, `created`, `source`. Optional `lavish:` when a board exists.

## Lavish

No custom Lavish app in this slice. Open the plan markdown in Obsidian, or use an existing **lavish-axi** board against that file if installed (Firstmate may export `config/lavish-axi-host` to workers).

## Setup

```bash
bin/setup-alice-vault    # ideas, requests, plan dirs + architect bus under fleet/inbox/
just architect-op        # same 1Password env file as Alice/Firstmate
```

See [roles/architect.md](../roles/architect.md), [roles/firstmate.md](../roles/firstmate.md), and [fleet/config/crew-dispatch.json](../fleet/config/crew-dispatch.json).
