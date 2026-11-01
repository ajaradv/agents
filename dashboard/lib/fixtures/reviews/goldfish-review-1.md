---
type: goldfish-review
target: fleet/plans/feature/goldfish-review.md
mode: review
depth: light-manual
writer: anthropic/claude-opus-5.5 (Claude Code)
sha: cc32d3d
lenses:
  - { lens: readiness, model: claude-fable-5.1, status: done }
  - { lens: codebase, model: claude-sonnet-5.5, status: done }
  - { lens: zoom-out, model: claude-haiku-4.5, status: done }
  - { lens: design-critic, model: none, status: not run, why: "only Claude models are available from Claude Code without loading the OpenRouter key; waits for GR2" }
summary: "Run by hand with Claude Code subagents before the goldfish tool exists. 7 blockers, 21 majors and 10 nits after merging duplicates; all resolved in the plan's 2026-11-01 revision."
---

Duplicates across reviewers are merged; the lenses that raised each finding are in brackets.

## Findings

### Blockers
- **F1** Cursor switch wired to the wrong code. `api-lanes.ts` has no profiles; real crew dispatch is `vendor/firstmate/bin/fm-dispatch-resolve.sh`. [readiness, codebase]
- **F2** Nothing in code controls a plan's move to `reviewed` or its `plan-draft`; `plan-check.ts` has no status check. [readiness, codebase]
- **F3** Personas return free text; the merge can't number findings or group them by severity. [readiness]
- **F4** Helper lifecycle is hard-wired to delegation (watch, finish, recovery, cap, budget); there's no goldfish recovery after a node restart, and no fake-spawn seam for tests. [readiness, zoom-out]
- **F5** R4's "the helper's tool gate refuses them" is false: helpers load no gate, and the gate allows all non-secret reads. [readiness, codebase, zoom-out]
- **F6** `delegate`'s cap of 2 per officer would refuse a 4-reviewer review. [zoom-out]
- **F7** The reviewer command omitted `--mode json` and `--no-skills`, which cost parsing needs. [codebase]

### Majors
- **F8** `bin/launch` can't parse nested YAML maps (`parse_simple_yaml`), and PyYAML isn't reliable. [readiness]
- **F9** `keys_needed()`/`restrict_keys()` would strip keys for providers that appear only in `models:`. [readiness, codebase]
- **F10** What `model-running.json` records when Cursor is off. [readiness, codebase]
- **F11** `models:` and `model`/`fallback_model` are two copies of one order. [zoom-out, codebase]
- **F12** Wrong transport: officer tools use `/api/decisions/<what>` with the crew token, not `/v1/`. [readiness, codebase]
- **F13** `fleet-axi` holds no token; how Claude Code's draft reaches the hub's vault. [readiness, codebase]
- **F14** How the writer's model is found; Claude Code's model id doesn't match openrouter ids. [readiness]
- **F15** No source for "failed today" for reviewer models. [readiness]
- **F16** The captain's depth override is indistinguishable from the Architect's. [readiness]
- **F17** Concurrency over the cap and budget crossing undefined; hub capacity unstated; why not `helpers.ts`. [readiness, zoom-out]
- **F18** `prepareCode`: default-branch lookup, fetch failure, locking, crash cleanup, the fleet ship's path. [readiness, codebase]
- **F19** File and frontmatter formats unpinned: slug, n, header, `review:`, skip record, bus payload, resolution regex. [readiness]
- **F20** Brainstorm: one reviewer with six lenses, or six reviewers? Light lens mapping; how parameters fill the template. [readiness]
- **F21** `architectWrite`: no `architectVault` in `GateContext`; the verdicts per path class are wrong ("as Alice has" isn't true); it must run before `writableAt`; bash bypasses it. [readiness, codebase]
- **F22** Jev failure fallback undefined; which probability field. [codebase]
- **F23** Hub clones "6 days" unverifiable; which host fetches. [codebase]
- **F24** The spec-review card isn't in `decision-queue.ts`. [codebase]
- **F25** Too many lenses before any data (six brainstorm lenses). [zoom-out]
- **F26** GR1 broader than the ask. [zoom-out]
- **F27** Reuse `dock-review.ts`'s Jev triage pattern. [zoom-out]
- **F28** The fleet-wide cap of 6 is speculative. [zoom-out]

### Nits
- **F29** The rules test path is `dashboard/lib/tool-gate-rules.test.ts`. [readiness, codebase]
- **F30** The launch test module isn't named; pattern `launch-skills.test.ts`. [readiness, codebase]
- **F31** The Architect's fallback comment changes. [readiness]
- **F32** `goldfish_review` registers only for the architect. [readiness]
- **F33** GR4's data source. [readiness]
- **F34** Spend attribution id (`<from>-helper`). [codebase]
- **F35** Create/modify tags inconsistent. [codebase]
- **F36** Copied persona names need renaming. [codebase]
- **F37** `chat-targets.ts` path is `dashboard/lib/`. [codebase]
- **F38** Say that all models go through OpenRouter. [codebase]

## Resolution

F1: fix — GR1 changes `fm-dispatch-resolve.sh` in our fork (`FM_SKIP_HARNESSES`) with its shell test; `plan-execution.ts` mirrors it for `plan_check`; api-lanes is dropped; "What is true today" notes that crews already skip exhausted quota.
F2: fix — the gate is at `specSubmit` and at `postBus` for `plan-draft`/`plan-ready` from the Architect; `reviewed` stays the captain's edit (role text).
F3: fix — `output-format.md` is appended to every prompt; `parseFindings` with fixtures; unparsed text becomes an `Unparsed` finding, never zero.
F4: fix — `startHelper` takes `onFinish` and an injectable `spawn`; parent `goldfish` and child `goldfish-lens` workflows; `recoverGoldfish()` at node start; cap and budget stay in `startDelegation`.
F5: fix — reviewer helpers load `tool-gate.ts` as `goldfish`; a new read rule stops `goldfish` and `*-helper` under career/ and profile/, with tests; R4 rewritten.
F6: fix — goldfish has its own cap (4 reviewers, one review at a time, others wait) and its own budget.
F7: fix — the run line now has `--mode json -p --no-session --no-skills`.
F8: fix — the roster is JSON (`fleet/config/models.json`); agent `models:` is an inline list, which `parse_simple_yaml` already reads.
F9: fix — `keys_needed()` walks the resolved `models:` list; test added.
F10: fix — a Cursor-off skip is recorded as `backup: true`, reason "Cursor is off".
F11: fix — `models:` replaces `model`/`fallback_model` (only `bin/launch` reads them); legacy fields are still read when `models:` is absent.
F12: fix — the Architect's tool posts `/api/decisions/goldfish`; `/v1/goldfish` is the captain's node-token path.
F13: fix — `bin/goldfish` (laptop) syncs both vaults, then runs `bin/hub fleet-axi review`, which uses `nodeToken()` on the hub.
F14: fix — the writer comes from `model-running.json` for the Architect, or `--writer` (required) on the shell path; `sameModel` compares the last two segments.
F15: fix — `fleet/inbox/.goldfish/failed-<date>.json`, written when a reviewer's model errors.
F16: fix — only the node-token path may set `by: captain`; the Architect's tool can only raise the depth.
F17: fix — over the cap, a review waits as pending; budget checked at start, and a running review finishes; the first full review measures hub memory (R7); `helpers.ts` rejected under Alternatives (no tools, one hub slot).
F18: fix — `git ls-remote --symref`; a fetch failure runs on the local origin ref with a header warning; one review at a time removes the need for a lock; `git worktree prune` in recovery; the fleet ship uses `ROOT`.
F19: fix — slug, n, header frontmatter, `review:` as a vault path, `triage.md`, the `goldfish-done` payload and the resolution regex are all specified.
F20: fix — six reviewers, one lens each, through one `brainstorm.md` template with `{{lens}}`; light is lenses 1, 2 and 5; one `renderPrompt` fills the parameters.
F21: fix — `architectVault` in `context()`; exact verdicts (allow the four areas, stop .git/.obsidian/career/profile, ask elsewhere); runs before `writableAt`; the bash bypass is accepted as R8 until bash leaves the Architect's tools.
F22: fix — a Jev failure means light; `probabilities.<choice>`, else `confidence`.
F23: contest — verified on the hub by ssh on 2026-11-01: `~/Workspace/{Kinwork,lineage_atria,pochteca}` exist there, with last commits 6 days ago; the node runs on the hub and `architectGitRead` already uses those paths with `localHost` (`dashboard/lib/git-read.ts`). The plan now says so.
F24: fix — the card is in `dashboard/lib/ship-view.ts`.
F25: contest — the captain asked for requests to be fleshed out automatically (The ask). Light (3) is the usual depth, full (6) only on Jev's "full", and GR4 trims by data. Recorded under Alternatives.
F26: contest — the captain asked to open up the model choices and to prefer Cursor again when it's back (The ask); F11's single list removes the duplication the finding was about.
F27: fix — the depth choice follows `dock-review.ts`'s pattern.
F28: fix — the cap is 4 and gets measured (R7).
F29: fix
F30: fix — `dashboard/lib/launch-models.test.ts`, using the `launch-skills.test.ts` pattern.
F31: fix
F32: fix
F33: fix — `goldfish-finding` journal rows.
F34: fix — `FLEET_AGENT_ID=goldfish`.
F35: fix
F36: fix — renamed to `goldfish-<lens>`.
F37: fix
F38: fix
