# Architect and the spec route

The Architect turns ideas and requests into plans and specs in the Obsidian vault (`ALICE_VAULT`). Only approved specs (and chores) sail. A plan is a design document the captain reads and accepts; it never sails on its own.

## Flow

1. The captain or Alice posts to the Architect's bus: `kind: plan` for an idea or request, `spec-request` after a spec or design session.
2. The Architect calls `survey mode=brainstorm` on the note and folds the findings into a draft.
3. It writes the draft: a plan in `fleet/plans/<category>/<slug>.md`, or a spec in `fleet/specs/<ship>/<slug>.md`.
4. It calls `survey mode=review` on the draft, resolves each finding under `## Resolution`, fixes the draft, and sets `review:` in its frontmatter.
5. The node checks `review:` against its own record of the survey. A draft with no matching record does not go on.
6. A plan goes to Alice as `plan-draft`, and she tells the captain. A spec goes to the captain's Decision queue with `spec_submit`; the card shows the review's depth, counts and escalations.
7. The captain accepts or rejects a plan, or approves a spec. After a plan is accepted, the Architect refreshes the ship's roadmap with its slices.
8. A voyage sails from an approved spec on the captain's Go.

## Surveyors

Fresh reviewers, each on its own model and never the writer's. Jev decides the depth (skip, light or full). Reviews run on the hub. From the laptop, use `bin/survey <vault path> --writer <model>`. The design is the vault plan `goldfish-review`.

## Status

A plan's `status:` is `draft`, then `accepted` or `rejected`, set only by the captain. A spec is `draft`, `approved` (by the captain), `sailing`, `built`.

## Running the Architect

`just architect` or `just architect-op` (the same 1Password env file as Alice). The model is the first usable one in the Architect's list; the aliases and the Cursor switch are in `fleet/config/models.json`. `bin/setup-alice-vault` creates the vault folders.

See [roles/architect.md](../roles/architect.md).
