# Ship roadmaps

One current overview per ship, in the vault, kept by the Architect, so "what is next on X" has one answer. Design: vault plan `fleet/plans/feature/ship-roadmaps.md`.

## The note

`ships/<ship>/roadmap.md` in the vault, for every ship including `fleet`. Frontmatter (`type: roadmap`, `ship`, `updated`, `updated_by`, `sources.repo` = the full sha of the default branch it was written from, `summary`) and these sections: **Now**, **Milestones** (a table: id, milestone, status, done when), **Next up** (a numbered list of three to seven items), **Recently done**, **Open questions for the captain**, **Sources**.

A Next up item has a fixed shape so a tool can read it:

```
1. **Spec Ehecatl's protobuf contracts** (P3), size M, ready: spec-session. Why: everything downstream reads them.
```

Readiness is one of `ready to sail`, `spec-session`, `design-session`, `needs the captain`. The full template is in `roles/architect.md` (section Ship roadmaps); a worked example is the test fixture `dashboard/lib/fixtures/roadmap-pochteca.md`.

## Who writes it

The Architect only. The repo's own `PLAN.md` is an input, never edited; disagreements between sources go to Open questions. The tool gate does not restrict the Architect's vault writes, so no rule is needed for `ships/*/roadmap.md`. After a refresh the Architect posts one line to Alice (`bus_post`, kind `roadmap-refreshed`).

Refresh triggers (after a dock, a Monday routine) are a later phase; today the Architect refreshes on request.

## Reading it

- **`ship_next(ship?, full?)`**, the fleet tool for Alice: for one ship, the summary, `updated` and any stale reasons, Now, the Next up items (title, milestone, size, readiness) and the open questions; `full` adds milestones, recently done and each item's why. Without `ship`, every ship in brief. A ship with no note says so.
- **`bin/fleet-axi next --ship <ship|all> [--full]`** prints the same from a shell. `bin/fleet-axi next` without `--ship` is unchanged (vault task steps).

A roadmap is **stale** when `updated` is more than 8 days old, when `sources.repo` is not a commit of the ship's repo, or when the repo's default branch has commits after `sources.repo`. If the repo is not on this machine, only the date is checked.

The parser is `dashboard/lib/roadmap.ts`; the node answers `GET /api/fleet/ship-next`.
