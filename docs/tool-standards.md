# Fleet tool standards

How tools in this repo are built, so agents read their results right the first
time and pay as little as possible for them. Based on the AXI principles
([axi.md](https://axi.md)); why we adopted them: vault research note
`fleet/plans/research/axi-evaluation.md`. Everything here works for any
harness: pi first, nothing that only works in Claude Code.

## Three kinds of tool

| Kind | Examples | Standard |
|---|---|---|
| **pi tools** (registered by an extension; the node answers) | `voyage_status`, `ship_log`, `vault_tasks`, `task_add` | the output rules below; definitions short |
| **CLIs agents run** (scripts, wrappers, AXIs we build) | `bin/stamp-ship`, `bin/new-agent`, a future fleet AXI | all ten AXI principles, checked with axi-axi |
| **Third-party AXIs and MCP servers** | jev-axi, obsidian-axi | reviewed against this page before an agent gets them; MCP only when its tool definitions are worth their cost every turn |

Do not rewrite pi tools as CLIs: a pi tool already gives the model a typed
definition, runs the same in a VM and on the host, and the node enforces who
may call it.

## Output rules (every tool)

1. **Read tools answer through a view** (`dashboard/lib/tool-out.ts`): TOON, each
   list a table of 3–6 chosen fields. Add a `VIEWS` entry for every new read tool.
2. **Cut long text, never drop it**: show the size of what was cut and offer
   `full=true`. At most 60 rows per list; say how many more there are.
3. **Counts and derived status** in the answer, so the agent needs no follow-up
   call (`11 open (10 ready, 1 waiting)`).
4. **Say "0" explicitly**, naming what was searched (`tasks: 0 tasks on this voyage`).
5. **Errors** start `error:` and say what to do next; never a raw stack or API body.
6. **Writes are idempotent**: repeating one that already holds says so and succeeds.
7. **Next steps** only when the next move is not obvious, as complete calls.

## Definitions (every pi tool)

- Description at most 600 characters, each parameter's at most 200: they ride
  every turn of every agent that has the tool. Say what it does, when to use it,
  and what it refuses.
- Parameters typed and minimal; enums for closed sets.

## CLIs agents run

- All ten AXI principles: no-args shows live content, `--help` with examples on
  every command, structured errors on stdout with exit codes 0 / 1 / 2, unknown
  flags rejected, TOON output, next-step hints.
- Check before shipping: `just axi-check "<command>"` (axi-axi validate, strict).
- Context for pi comes from the launcher or an extension, not from Claude Code
  hooks; ship a `SKILL.md` generated from the CLI's own help.

## Checked, not just asked for

| Check | Where |
|---|---|
| Strict typecheck of the dashboard, node, and the extensions the fleet loads | `just typecheck`; `dashboard/lib/typecheck.test.ts` |
| Every read tool has a view; views stay bounded; definitions stay short | `dashboard/lib/tool-standards.test.ts` |
| A CLI meets AXI | `just axi-check "<command>"` |

`just test` runs the first two. The Shipwright builds to this page (skill
`skills/tool-standards`); a helmsman aboard the `fleet` ship may review tool
evidence (failures, oversized outputs) against it and propose fixes.

## Known gaps (2026-10-18)

- The scripts agents run (`bin/stamp-ship`, `bin/new-agent`, `bin/order`,
  `bin/plan-execution.ts`, `bin/agent-portrait`) each fail three axi-axi checks:
  no-args prints usage and exits 2, `--help` has no examples, errors go to stderr.
- Vendored extensions the fleet does not load are outside the typecheck.
