---
name: tool-standards
description: Use when adding or changing a tool in the agents repo (a pi tool in an extension, a read tool's output, or a script or CLI agents run), before committing.
---

# Fleet tool standards

The full standard is `docs/tool-standards.md` in this repo. Read it once per session before touching a tool. In short:

- **pi tool that reads**: add a `VIEWS` entry in `dashboard/lib/tool-out.ts` (fields per row, what to cut, empty text, next steps). Never return raw JSON to an agent.
- **pi tool definition**: description at most 600 characters, each parameter's at most 200. Say what it does, when to use it, what it refuses.
- **Any result**: counts, explicit "0", cut long text with its size and `full=true`, errors as `error:` plus what to do, idempotent writes.
- **Script or CLI agents run**: all ten AXI principles; run `just axi-check "<command>"` and fix failures.
- **Not**: rewriting pi tools as CLIs, Claude-Code-only hooks, MCP servers without weighing their per-turn cost.

Before committing, run `just test` (it includes the typecheck and the tool standard checks) and, for a CLI, `just axi-check`. Say in the commit message which checks you ran.
