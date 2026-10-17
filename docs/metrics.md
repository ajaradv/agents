# Fleet metrics

`fleet/inbox/.node/metrics.db` (SQLite, WAL) records what every voyage took,
for the voyage ledger and for dashboards (`dashboard/lib/metrics.ts`). The node
and the dashboard write it; anything can read it (`sqlite3`, Datasette, a
notebook, a future dashboard page).

| Table | One row per |
|---|---|
| `voyages` | voyage: ship, goal, sent to, branch, worktree, started, docked, commits |
| `turns` | agent turn: agent, role, ship, voyage, model, mode (vm/host), ms, cost, tokens, cache reads, error |
| `runs` | check run (later maneuvers): name, deterministic, ok, ms, voyage |
| `handoffs` | crew message or task change: from, to, kind, size, voyage |

Views: `cost_by_role_model`, `check_pass_rates`, `voyage_totals`.

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
