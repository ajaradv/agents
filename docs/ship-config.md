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
