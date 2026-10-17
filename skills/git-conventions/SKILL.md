---
name: git-conventions
description: Branch names and commit messages for crew work, in the conventional-commit form python-semantic-release reads (feat/, fix/, perf/ release; docs/, refactor/, test/, build/, ci/, chore/ do not). Use when a voyage starts on a new branch, before the first commit, and whenever you write a commit message.
---

# Git conventions for crew work

Ships may release with [python-semantic-release](https://python-semantic-release.readthedocs.io/en/latest/#defining-your-release-branches), which reads branch prefixes and commit types to decide versions. Name branches and write commits so it reads them correctly.

## Branch names: `<type>/<short-kebab-description>`

| Type | Use for | Releases? |
|---|---|---|
| `feat` | a new capability users see | minor |
| `fix` | a bug fix | patch |
| `perf` | a speed or resource improvement, no behaviour change | patch |
| `docs` | documentation only | no |
| `refactor` | restructuring with no behaviour change | no |
| `test` | tests only | no |
| `build` | build system, packaging, dependency upgrades that change the build | no |
| `ci` | CI configuration | no |
| `chore` | maintenance that fits nothing above (dependency bumps, tooling) | no |

- The description is 2 to 6 words, lowercase, hyphens, specific: `fix/order-total-rounding`, `chore/tailwind-4.3-daisyui-5.7`, `docs/pytest-docker-note`. Version numbers keep their dots.
- No `crew/` prefix, no dates, no ticket noise.
- A voyage's branch is created for you at Set sail, with a type guessed from the goal. **Before your first commit**, check it (`git branch --show-current`); if the type or description is wrong, rename it: `git branch -m <type>/<description>`. Never rename after commits exist on it, and never touch other branches.

## Commit messages: conventional commits

```
<type>[optional scope]: <imperative summary, lowercase, no period>

[optional body: why, not what]

[optional footer: BREAKING CHANGE: <what breaks>]
```

- Same types as branches: `feat: add order export`, `fix(api): round totals to cents`, `chore(deps): bump tailwindcss to 4.3.3 and daisyui to 5.7.50`, `docs: note that just pytest runs in docker compose`.
- `feat!:` or a `BREAKING CHANGE:` footer only for real breaking changes (a major release).
- One logical change per commit; the summary line under 72 characters.
- **Never skip hooks** (`--no-verify`, `-n`, `core.hooksPath` tricks). If a git hook fails, fix what it reports and commit again; if it cannot run at all (a missing tool or interpreter), stop and report the task blocked with the hook's error, so the captain can fix the environment.
- Never push; the captain reviews and merges.
