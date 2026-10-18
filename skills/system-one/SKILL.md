---
name: system-one
description: Use when adding or changing a fleet decision made by Jev (TypeSafe's System One model): a gate, a classifier, a score, a router, or a check that answers a typed question instead of writing text.
---

# System-one decisions (Jev)

The full guideline is `docs/system-one.md` in the agents repo. Read it before writing a Jev use. In short:

- **Fit**: Jev for bounded judgments you can state with their outcomes; code for numbers, dates, counting, and rules that are always right; an agent for open work.
- **Client**: always `jevAsk(use, state, questions)` from `dashboard/lib/jev.ts` (fallback route, cache, spend log). Agents never hold the key; extensions ask the node.
- **Questions**: one snap judgment each, fanned out in one call; situations not degrees; an `other` exit on choices; send the passage, not the document; say what normal looks like; expect terse inputs. Score criteria are a list of levels, low to high.
- **Thresholds**: in code next to the questions; measure on real examples first and put the line where true and false separate.
- **Failure**: gates fail closed (hold, never allow); advisors change nothing when Jev does not answer.
- **Rollout**: anything that can block starts in observe mode and is switched on after real traffic.
- **Data**: redact first (`dashboard/lib/redact.ts`); repo code is allowed, secrets never.
- **Tests**: inject the ask function; tests never call Jev. Then run `just test`.
