# Fleet orders

An order is a short, exact sequence of fleet actions that Alice runs **as
written**, after the captain's Go. Planners write them: Claude Code, the
Architect, the captain. Use one when the next move is a few fleet calls (read a
ship's state, message a lead, start a voyage), not code work: code changes stay
with crews.

`bin/order format` prints the body format and every tool a step may call with
its parameters, generated from the code, so it is always current.

## The body

```markdown
## Intent

Why this order exists, in a sentence or two (Alice does not act on it).

## Steps

1. `ship_tasks` ship=kinwork
   expect: the open voyage and its tasks, if any
2. `fleet_chat` to=kinwork-lead text="Status for the captain, please."
   expect: the message lands in kinwork-lead's thread

## Acceptance

- `agent_chat_read` agent=kinwork-lead n=5
  expect: the message above is in the thread
```

- One fleet tool call per step, the tool name in backticks.
- Literal `key=value` arguments; quote values with spaces. No placeholders.
- Every step and check has an indented `expect:` line. Terse is fine; write
  "if any" when an empty result is fine. An independent check (Jev) compares
  each step's actual output with its expect line.
- Acceptance lines use read tools and run after the steps.

## Submitting

```bash
bin/order check ./body.md                                    # every problem, with its line number
bin/order new --ship kinwork --by claude-code --title "Kinwork status round" < body.md
```

The order lands in the vault (`fleet/orders/<date>-<slug>.md`) as queued and
shows on the fleet deck for the captain's Go. The captain's own orders are
approved when submitted.

## While it runs

- The deck shows **step k of N** and the call Alice is on.
- Every fleet call must name the order and step and match the step literally;
  anything else is refused and pauses the order for the captain (Retry or
  Cancel). Reads outside the plan are allowed and listed in the report.
- Alice's own tools (bash, file reads and writes) are recorded with the order
  id in the fleet log and listed in the report; they are not refused.
- **Chat priority**: when the captain writes to Alice mid-order, she finishes
  the step she is on, answers, and the order resumes by itself.
- Orders that have not started can be **edited** (they must still parse) or
  **deleted** from the deck; a deleted note moves to `fleet/orders/deleted/`.
- The report (every step, its evidence, planned vs actual) is appended to the
  note when the order ends.

Code: `dashboard/lib/order-note.ts` (format, parsing, edit and delete),
`dashboard/lib/orders.ts` (the watcher), `bin/order`.
