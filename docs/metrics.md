# Fleet metrics

`fleet/inbox/.node/metrics.db` (SQLite, WAL) records what every voyage took,
for the voyage ledger and for dashboards (`dashboard/lib/metrics.ts`). The node
and the dashboard write it; anything can read it (`sqlite3`, Datasette, a
notebook).

| Table | One row per |
|---|---|
| `voyages` | voyage: ship, goal, sent to, branch, worktree, started, docked, commits |
| `turns` | agent turn: agent, role, ship, voyage, model, mode (vm/host), ms, cost, tokens, cache reads, error |
| `runs` | check or maneuver run (`kind`): name, deterministic, ok, ms, commit, dirty, voyage |
| `handoffs` | crew message or task change: from, to, kind, size, voyage |

Views: `cost_by_role_model`, `check_pass_rates`, `voyage_totals`.

`turns`, `runs`, and `handoffs` also carry `event_key` (unique, a ULID; the
idempotency key, so a replayed event inserts nothing) and `project_id` (the
ship, or `flagship` for the officers, whose turns have no ship). Rows from
before these columns have `legacy:<table>:<id>` keys.

## Schema changes

Each SQLite file (`metrics.db`, `journal.db`, each ship's `ship.db`) is a list
of numbered migrations (`MIGRATIONS` in `dashboard/lib/metrics.ts`,
`journal.ts`, `ship-log.ts`; runner in `dashboard/lib/db-migrate.ts`), applied
at open and recorded in `PRAGMA user_version`. To change a schema, append the
next version (SQL string, or a function for steps SQL cannot express); never
edit one that has shipped, because files already past it will not run it
again. Each migration runs in its own transaction with the version bump, so a
failure leaves the file at the last good version and the open throws with the
database and version. Read-only openers do not migrate: they read what the
writer has already brought up to date.

## Where it shows

- **Health → Fleet metrics** (`dashboard/lib/metrics-view.ts`), for 7 days,
  30 days, or all time: spend, cost per turn and cache share, voyages docked
  (average cost and time), checks passed; spend per day by role; a table by
  role, model, and mode (turns, cost, cost and time per turn, cache share);
  crew turns in a VM against on the host; checks and maneuvers by ship (runs,
  pass rate, time, latest); recent voyages; handoffs by kind.
- **Ship deck → Ledger** (`dashboard/lib/ledger-view.ts`): the voyage under
  sail (crew, runs, gates on the current commit) and past voyages.
- **Dock**: the ledger line in the dock message and a Ledger section in the
  vault voyage note.

Turns recorded before models were stored show the model as "not recorded".

On dock, the ledger (time, turns, cost per crewmate, checks, handoffs) is
added to the voyage note in the vault and to the dock message. History from
before the database existed (ship logs, voyage notes) is imported once when
the node starts; backfilled turns have no model (ship logs never stored it).

Examples:

```sql
-- What each role costs, by model and mode
SELECT * FROM cost_by_role_model ORDER BY cost DESC;
-- Voyages: cost, turns, checks
SELECT id, ship, cost, turns, checks, checks_passed, commits FROM voyage_totals ORDER BY started DESC;
-- Daily spend per agent
SELECT substr(ts, 1, 10) AS day, agent, ROUND(SUM(cost), 2) AS cost FROM turns GROUP BY day, agent ORDER BY day DESC, cost DESC;
-- Gate reliability
SELECT * FROM check_pass_rates;
```
