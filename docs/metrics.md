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

## Records from workers: POST /v1/ingest

A worker (the laptop, a voyage VM) keeps what it records for the hub in an
outbox, `<inbox>/.node/outbox.db` (`dashboard/lib/outbox.ts`), and sends it to
the node's `/v1/ingest` (`dashboard/lib/ingest.ts`). If the hub restarts or the
link drops, the records wait and go later. Today the worker queues the result
of every check the hub asks it to run; `/host/exec` takes the hub's `run`
descriptor (`event_key`, ship, agent, name) and queues a `runs` event before
answering. The hub records the same run under the same `event_key` when the
answer arrives, so whichever copy lands second is a duplicate. When the answer
is lost, the hub records nothing for that run and the worker's copy is the
record.

```
POST /v1/ingest
{ "source": "laptop" | "<vm name>",
  "events": [{ "table": "runs" | "turns" | "handoffs" | "ship_events",
               "event_key": "<1-80 of A-Za-z0-9:_->", "data": { ... } }] }
-> { "accepted": n, "duplicates": n, "rejected": [{ "event_key": "...", "reason": "..." }] }
```

- **Idempotent.** A key the hub already has adds nothing and counts as a
  duplicate, so a batch may be sent again until it is answered.
- **Columns.** `data` uses the table's column names; anything else, or a missing
  required column, rejects that event (the rest of the batch stands). `runs`:
  ship, agent, kind (check or maneuver), name, ok, ms required; cost,
  deterministic, detail, commit_sha, dirty, ts optional. `turns`: agent, ok, ms
  required; ship, model, cost, tokens, cache_read, prompt, error, ts optional
  (no ship is an officer's turn). `handoffs`: ship, from_agent, kind required;
  to_agent, size, ts. `ship_events`: ship, actor, kind required; summary,
  payload (an object), ts; the row goes into that ship's log. A ship must be one
  the hub knows. `ts` (ISO) is the worker's time; the hub fills `project_id`,
  `role`, `mode`, and the voyage under sail.
- **Limits.** 500 events and 1 MB per request (413 beyond). Each table is one
  transaction per batch (one per ship for `ship_events`).
- **Auth.** The node token (`Authorization: Bearer`), or the worker's own
  ingest token in `X-Fleet-Ingest-Token`: the hub secret `ingest-<source>`,
  where the source is `laptop` or a VM name, and only that source. An ingest
  token opens this route and no other; the request guard lets a tagged tailnet
  device (a voyage VM) through to `/v1/ingest` on it. The hub makes the token
  when a worker is first used (the laptop on first use per node process; a VM
  when it is adopted) and sends it with the node's address to the worker
  (`POST /host/ingest-config`); removing a VM deletes it.
- **The outbox.** Pending events go every 30 s and about 2 s after one is queued,
  oldest first, 200 to a request. Accepted and duplicate keys are marked sent. A
  rejected key is kept with its reason and never retried. A failed send backs
  off from 30 s, doubling to 30 min. Sent rows are dropped after 7 days; the
  table holds 20,000 rows at most.
