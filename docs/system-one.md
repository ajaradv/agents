# System-one models (Jev) in the fleet

How the fleet uses fast decision models: models that answer a typed question
about a situation with probabilities instead of writing text. Today that is
**Jev** (TypeSafe's System One model). Research, measurements, and the ranked
list of uses: vault note `fleet/plans/research/jev-system-one.md`.

## When to reach for one

Code for numbers, Jev for bounded judgments, agents for open work.

- **Jev** when you can state the decision and its outcomes: a gate (is this
  safe?), a label (which cause?), a score (how risky?), a route (who handles
  it?), a question about a text or file.
- **Code** for counting, dates, arithmetic, thresholds, and anything a rule
  gets right every time (the tool gate's local rules decide 89% of calls before
  Jev sees anything).
- **An agent** when the work needs reasoning, planning, or writing.

## The client

Every use goes through `dashboard/lib/jev.ts` (`jevAsk(use, state, questions)`):
TypeSafe first, OpenRouter's `~typesafe/jev-latest` when it fails, 5 s per
route, identical requests cached for 5 minutes, and every call logged with its
use, tokens, cost, and latency (Health > Diagnostics > Jev). Agents do not hold
the Jev key: extensions ask the node, which calls Jev.

| Type | Ask | Get back |
|---|---|---|
| `noul` | a yes/no, optional criteria for each side | the probability of yes |
| `choice` | one of up to 255 options (`criteria`: option → description) | the pick, a probability per option, confidence |
| `score` | a position on 2–10 levels (`criteria`: a list of level descriptions, low to high) | a score that can land between levels, probabilities, confidence |

Price (measured 2026-10-18): $0.042 per million input tokens, output free. A
short decision costs about $0.000013; a whole source file $0.0002–0.0004.
Latency 0.1–0.3 s.

## Writing questions

1. **One snap judgment per question.** "Is this urgent?", not "analyze and decide".
2. **Fan out.** Ask every question you might need in one call; code picks.
3. **Describe situations, not degrees.** "Blocked, no workaround", not "very severe".
4. **Always an exit.** An `other` option on any choice that might not cover every input.
5. **Isolate the state.** Send the passage, not the document; the log's tail, not the whole log.
6. **Say what normal looks like.** Jev judges against what it is told: the tool
   gate held 14 of 20 harmless calls until its question listed the agent's
   folders and described normal work (then 7, and about 3 with a majority bar).
7. **Expect terse inputs.** Plan authors write short `expect:` lines; the
   question has to say so ("it may be terse; 'if any' allows an empty answer").

## Thresholds and failure

- **Thresholds live in code, next to the questions, in one reviewable place.**
- **Confidence is the second axis:** a floor (below it, a human decides), a bar
  (above it, act without confirming), the middle confirms or holds.
- **Measure before you pick a number.** Run the question on real examples and
  set the line where true and false cases separate (the order expect check:
  correct results 0.24–0.73, failures 0.05–0.07, line at 0.15).
- **Gates fail closed**: when Jev does not answer, hold or block, never allow.
- **Advisors fail quiet**: compaction, triage, and checks change nothing when
  Jev does not answer.
- **Observe before enforcing.** A new gate or advisor first logs what it would
  have done; switch it on after looking at real traffic.

## What may be sent

TypeSafe does not train on inputs (its privacy policy); retention is "as long
as reasonably necessary", hosted in the US. The captain's decision
(2026-10-18): commands, paths, tool inputs, logs, and **repo code** may be
sent; **secrets never**. Run everything through `redact` (`dashboard/lib/redact.ts`)
first. Our own local classifiers are a later project.

## Uses in the fleet

| Use | Where | Mode |
|---|---|---|
| Tool gate (is this call safe?) | `extensions/tool-gate.ts`, `lib/tool-gate.ts` | observe (`FLEET_TOOL_GATE`) |
| Result screen (instructions hidden in fetched text) | the same | on (adds a banner, never blocks) |
| Compaction advisor (has the work moved on?) | `extensions/context-guard.ts`, `lib/compaction-advisor.ts` | observe (`FLEET_COMPACT_JEV`) |
| Failure triage (why did a check fail?) | `lib/ship-checks.ts` | on (one advisory line) |
| Order expect check (does the result meet the plan?) | `lib/orders.ts` | on (holds a step once) |
| Captain message routing | `bin/fleet-route-resolve.sh` | on |

Adding one: put the questions and thresholds in one module, call `jevAsk` with
a new `use` name, inject the ask function for tests (tests never call Jev),
measure on real examples, and start in observe when it can block anything.
