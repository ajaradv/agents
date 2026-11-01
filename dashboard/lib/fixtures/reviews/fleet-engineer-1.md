---
type: goldfish-review
target: fleet/plans/feature/fleet-engineer.md
mode: review
depth: light-manual
writer: anthropic/claude-opus-5.5 (Claude Code)
sha: cc32d3d
lenses:
  - { lens: readiness, model: claude-fable-5.1, status: done }
  - { lens: codebase, model: claude-sonnet-5.5, status: done }
  - { lens: zoom-out, model: claude-haiku-4.5, status: done }
summary: "Run by hand with Claude Code subagents. After merging duplicates: 1 blocker, 15 majors and 10 nits; all resolved in the plan's 2026-11-01 revision."
---

Duplicates across reviewers are merged; the lenses that raised each finding are in brackets.

## Findings

### Blocker
- **F1** The raw ssh call skips `bin/hub`'s PATH export (bun isn't found), and the host lives in a shell variable. [readiness, codebase, zoom-out]

### Majors
- **F2** Nothing enforces the 8-second cap; `ConnectTimeout` bounds only the connect. [readiness, codebase]
- **F3** Hub items' paths, calls and output not pinned (deploys.log, drift, `systemctl` scope, the routines.json key and fields, overdue rule). [readiness, codebase]
- **F4** The output format (TOON or markdown) and the hub-part wire format are undefined. [readiness, codebase]
- **F5** Scratchpad worktrees can't be found by a new session; "unpushed" and fetch are undefined. [readiness]
- **F6** No `gh` timeout, CI roll-up rule or row limit. [readiness]
- **F7** The plans filter uses `reviewed`, which no plan has; the review "resolved" rule is undefined; the frontmatter walker and vault root aren't named. [readiness, codebase]
- **F8** A missing roadmap returns `MissingRoadmap` rather than throwing; the output and call aren't named. [codebase]
- **F9** The E1 role cites `bin/goldfish` and the harbormaster before either exists. [readiness]
- **F10** The `CLAUDE.md` edit is unspecified. [readiness, codebase]
- **F11** The cut rules are incomplete (whole section or lines, what if still over, the marker, the handoff cap order). [readiness]
- **F12** E2's "try each procedure once" includes live destructive operations. [readiness]
- **F13** Test gaps: flag parsing, plain `--brief` unchanged, repo and PR parsers, missing roadmap, handoff date, exit 0, settings.json. [readiness, codebase]
- **F14** A second capping pipeline duplicates `session-brief.ts` `buildBrief`. [zoom-out]
- **F15** The handoff's "Waiting on the captain" is derivable (PRs, plan statuses, queue). [zoom-out]
- **F16** Two SessionStart hooks can print the brief twice. [zoom-out, readiness]
- **F17** The worktree scan is speculative. [zoom-out]
- **F18** `--engineer` and `--hub-part` must be added to `FLAGS[""]` and `SWITCHES`. [codebase, readiness]

### Nits
- **F19** handoff.md already exists. [codebase, zoom-out]
- **F20** `hub-on-exe-dev` is 23 lines, not about 30. [codebase]
- **F21** The memory count and per-rule sources; `ps -E`/`ps eww` come from the plan. [codebase]
- **F22** File markers incomplete. [codebase]
- **F23** The role's `tools:` format isn't given. [readiness, zoom-out]
- **F24** "brief" means two things in E2. [readiness]
- **F25** The exact `MEMORY.md` text. [readiness]
- **F26** The fleet orders path is missing from the role's delegation. [zoom-out]
- **F27** Function and test lists are too detailed. [zoom-out]
- **F28** What `--engineer` does on the hub itself. [readiness]

## Resolution

F1: fix — the brief spawns `bin/hub fleet-axi --brief --hub-part`; `bin/hub` gains `FLEET_HUB_SSH_OPTS`; no host name in TypeScript.
F2: fix — `Bun.spawn` with SIGTERM at 8 s and SIGKILL 1 s later.
F3: fix — the table pins each source, call and output line; units are system scope; the drill is overdue past 8 days.
F4: fix — markdown sections in the shape of Alice's brief; the hub part is inserted verbatim.
F5: fix — `git worktree list --porcelain` from the primary (scratchpad worktrees are registered there); the `@{upstream}`, else `origin/main`, rule; no fetch, with the fetch time shown.
F6: fix — 5 s timeout, the roll-up rule, limit 10.
F7: fix — the real status set with the `updated`, else `created`, fallback; `reviewStatus` with its regexes in `review-status.ts`, shared with GR2; the vault from `aliceVault()`.
F8: fix — `readRoadmap("fleet", { vault })`, and the missing and stale output lines.
F9: fix — E1 wording uses today's paths (general-purpose reviewers, `bin/hub-deploy`); E2 gives the exact role change.
F10: fix — the import line placement; all five bullets stay; the deploying bullet gains the runbook pointer.
F11: fix — `fitSections`, line by line, "(+N more)", a final "cut:" line; the handoff is capped first.
F12: fix — procedures are classed Run, Dry run or Document only; live ones need the captain's approval.
F13: fix — test cases added for each.
F14: fix — `fitSections` extracted from `buildBrief` and shared.
F15: fix — "Waiting on the captain" dropped; "Promised next steps" keeps only sequences no source records.
F16: fix — one committed hook; `setup hooks` checks both files.
F17: contest — leftover worktrees are real. On 2026-11-01, `git worktree list` showed `~/.treehouse/agents-extract-fix` (branch `extract-claude-prefix`, squash-merged as #79 but its worktree still there) and a detached `agents-9361ee`. Listing them gets them cleaned up. One `git worktree list` call replaces the filesystem scan. (Corrected: the first version of this line said neither was in a PR.)
F18: fix
F19: fix — marked (edit).
F20: fix
F21: fix — the per-rule list is in "What is true today"; `ps -E` and `ps eww` are kept on purpose as part of the same rule.
F22: fix
F23: fix — pi names, ignored by Claude Code.
F24: fix — "task prompt".
F25: fix — exact text given.
F26: fix — orders added to Delegation.
F27: decline — the readiness reviewer asked for more detail at the same places; the zero-decision rule wins for an implementation section.
F28: fix — in-process on Linux.
