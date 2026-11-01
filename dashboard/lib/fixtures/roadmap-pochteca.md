---
type: roadmap
ship: pochteca
updated: 2026-11-02
updated_by: architect
sources:
  repo: 0123456789abcdef0123456789abcdef01234567
  read: [PLAN.md, docs/roadmap.md, fleet/specs/pochteca/*, voyages since 2026-10-01]
summary: "Execution engine skeleton is next; the signal pipeline runs on devnet."
---

## Now
P3, the Ehecatl execution engine skeleton. The signal pipeline is done; the engine waits on its protobuf contracts, which nobody has specified yet.

## Milestones
| id | milestone | status | done when |
|----|-----------|--------|-----------|
| P2 | Signal pipeline | done | signals flow from the feed to the store |
| P3 | Ehecatl execution engine (skeleton) | in progress | a devnet trade goes through the pipeline end to end |
| P4 | Risk limits | planned | the engine refuses a trade over the daily limit |

## Next up
1. **Spec Ehecatl's protobuf contracts** (P3), size M, ready: spec-session. Why: everything downstream reads them. Links: [[pochteca-ehecatl]]
2. **Wire the devnet feed into the engine** (P3), size L, ready: ready to sail. Why: the first end-to-end trade. Links: [[pochteca-devnet]]
3. **Design the risk-limit config** (P4), size S, ready: design-session. Why: the limits decide how the engine fails.
4. **Pick the production RPC provider** (P4), size S, ready: needs the captain. Why: cost and rate limits.

## Recently done
- Signal store migration (PR #41)
- Feed reconnect backoff (voyage 2026-10-28)

## Open questions for the captain
- PLAN.md says the engine is in Rust, the spec says Go. Which one?
- Does the devnet wallet need a hardware key?

## Sources
PLAN.md at 0123456, docs/roadmap.md. Replaces [[pochteca-2026-h1]].
