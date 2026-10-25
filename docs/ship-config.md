# Ship config

A ship's config has three layers (`dashboard/lib/ship-config.ts`; vault
research note `fleet/plans/research/ship-config-layers`):

| Layer | File | Committed | Holds |
|---|---|---|---|
| Base | `fleet/ships/<ship>.yaml` | yes | setup (id, path, mode, factory, isolation, env, authority) and defaults for the rest |
| Overlay | `fleet/home/ships/<ship>.yaml` | no (machine-local) | what changes at run time: crew, budgets, models, orchestrator, gates, maneuvers, added checks and hosts |
| Merged view | `fleet/inbox/.node/ships/<ship>.json` | no | base with the overlay on top, written by the node for `bin/launch` |

**Merge rule:** maps merge key by key, lists and values replace, `null`
removes a key the base has (`crew_budgets: {scout: null}`).

**Who writes where:**
- The shipyard (crew aboard and ashore, budgets, models, orchestrator) and the
  helmsman's Apply write the **overlay**, never the base. The committed repo
  stays clean.
- The captain may edit either file by hand: the base for setup and defaults
  everyone should get, the overlay for this machine's live state.
- New ships start from a **template** (`fleet/ship-templates/`: python-web,
  rust-services, docs) through the New ship form or
  `bin/stamp-ship <id> <path> --template <name>`; the template's checks,
  gates, and maneuvers become the base's defaults.

**Readers:** the dashboard and node read the merged view (`readShips`,
`readShipConfig`). `bin/launch` reads the node's JSON while it is newer than
both files, and otherwise merges the two files itself, so a hand edit takes
effect at the next launch either way.

**History:** every write appends to `config_changes` in the metrics database
(ship, key, old, new, by, why; the helmsman's reason carries over on Apply).
The deck's Helm section lists recent changes.

## Preview

`preview: http://localhost:3000` (base) names where the captain opens the
ship's app on their own stack. `bin/launch` puts it in the crew's prompt:
screenshot through that entry, and list the exact pages there when asking for
Go on UI work. Set it when the stack has more than one port and only one
serves the styled page (Kinwork: webpack on 3000 proxies Django on 8000).
`bin/fleet-shot` and the shared browser refuse a page whose stylesheet failed
to load (`--unstyled` / `unstyled: true` to shoot it anyway), so a wrong-port
screenshot never reaches the captain as a design.

## Routines

A ship's recurring work lives under `routines:`, a map by id (so the overlay
can change one routine or switch it off: `enabled: false`, or `null` to drop
one the base declares):

```yaml
routines:
  helm-review:
    every: weekly fri 16:30
    job: helm-review          # reviews this ship; skipped while no helmsman is aboard
  nightly-checks:
    every: daily 02:00
    agent: lead               # a role: runs on <ship>-lead
    prompt: Run the ship's checks and report anything failing.
```

- Schedules: `every 6h`, `daily 08:30`, `weekly mon 09:00` (local time).
- An agent routine is skipped while its role is ashore or over its daily crew
  budget; its turns count against that budget.
- Templates carry a default helm review. Fleet-wide routines (node jobs,
  Alice's weekly report) live in `fleet/config/routines.yaml`.
- Health > Diagnostics > Routines lists both layers with last run, result, and
  next run. Engine: `dashboard/lib/routines.ts`.

## Base branch

Voyage worktrees branch from the repo's default branch (`origin/HEAD`, else
`main` or `master`). A ship whose work lives on a long-running branch sets
`base_branch` (base or overlay), for example the fleet ship's overlay has
`base_branch: fleet-reliability`; the voyage then starts from
`origin/<branch>` (or the local branch when the remote lacks it). Without it,
crews build on a stale main and their branch conflicts at merge.

## Where a voyage sails

On the hub, a voyage can sail on the hub or on the captain's laptop (Set a
course's "Sail on", or `voyage_start` with `on: laptop`). The laptop is offered
only while **Laptop voyages** is on in the Harbor and the laptop is awake. A
laptop voyage keeps its worktree, checks, and crew's pi on the laptop and
reports to the hub as usual. `sail_on: laptop` (overlay) makes the laptop the
default when it can take the voyage, else the hub. Turning Laptop voyages off
(closing the laptop for the day) sends new voyages to the hub; the Harbor lists
open laptop voyages with **Move to hub** (the branch is pushed from the laptop
and the hub carries on). A crew in Gondolin VMs stays on the laptop and waits
while it sleeps.

The laptop decides what the hub may run there (`dashboard/lib/hosted.ts`): git
and treehouse in the ship's repo and worktrees, `gh pr`, and only the checks in
the laptop's own ship config. Security settings (isolation, env, VM allowlist,
checks) are the laptop's; from the hub it takes only crew, models, budgets,
gates, maneuvers, and the base branch. Setup: the hub's
`~/.config/fleet/services.env` needs `FLEET_LAPTOP_URL` and
`FLEET_NODE_PUBLIC_URL` (the node published with Tailscale Serve).
