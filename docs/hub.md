# The hub

The hub runs the live fleet: the fleet node, the dashboard, the browser service, the backups and the timers. This is its runbook: the facts, then the procedures the harbormaster (`.claude/agents/harbormaster.md`) follows. Plan: `fleet/plans/feature/fleet-engineer.md` in the vault.

## Facts

- **Host:** `fleet-hub-k1s7.exe.xyz`, an exe.dev VM (2 vCPU, 4 GB) in the captain's exe.dev Personal pool (4 vCPU, 8 GB, $35), beside the voyage VMs. `FLEET_HUB` overrides the name for `bin/hub`.
- **History:** exe.dev (2026-10-22), then the laptop (2026-10-26 morning), then back on exe.dev the same day.
- **The laptop is a client and a ship host.** Its `com.fleet.node` and `com.fleet.dashboard` launch agents are disabled. Never re-enable them while the hub runs: two hubs would both act on the fleet. The laptop keeps `com.fleet.worker` (`bin/laptop-worker`: quota-axi, voyages on the laptop) and `bin/vault-sync`.
- **Live state is on the hub.** The databases (`fleet/inbox/.node/journal.db`, `metrics.db`) and the agents' memory (e.g. `fleet/inbox/alice/memory/state.md`) live there. The laptop's copies under `fleet/inbox/` are stale pre-cutover leftovers. Read live numbers with `bin/hub fleet-axi ...`; read or edit agent memory over ssh on the hub.
- **Leftover backups from the moves:** on the laptop, `fleet/inbox.pre-cutover-20261026`; on the hub, `fleet/inbox.pre-return-20261026` and `~/fleet-overlays-backup/`.
- **Units are system units:** `fleet-node`, `fleet-dashboard` (`FLEET_NODE_SPAWN=0`), `fleet-browser`, `fleet-litestream`, `vault-sync.timer`, `fleet-heartbeat.timer`. Use `systemctl` (not `--user`) and `sudo journalctl -u <unit>`.
- **The services' PATH is only `~/.local/bin`** plus the system dirs. Anything an agent runs must be linked there: node for npm-installed pi (exit 127 on 2026-10-29). A non-interactive ssh has no login PATH either; `bin/hub` sets it.
- **After resuming a paused VM the clock is stale:** run `sudo systemctl restart systemd-timesyncd` before starting services.
- **Vault skills** on the hub need `git submodule update --init` and `bin/setup-alice-vault`.

## Deploys

- `bin/hub-deploy` from the laptop pulls on the hub, waits for idle agents, restarts fleet-node and fleet-dashboard, and checks both answer. `--check` is a dry run, `--new-session a,b` starts those agents fresh when a role, tool or session brief changed, and `--rollback [sha]` undoes the last deploy (push a fix to main before the next deploy).
- **Pull the laptop's `main` first.** `bin/hub-deploy` pipes the laptop's copy of itself over ssh, so an old laptop checkout runs the old script (2026-10-31, #89's first deploy).
- Services are reinstalled when their settings change. The fingerprint is `~/.config/fleet/.services.installed`; `bin/fleet-services drift` prints why the units are out of date, and nothing when they're current.
- History: `fleet/inbox/.node/deploys.log` on the hub, one line per deploy: `<time> <from-sha> <to-sha> <deploy|rollback>`.

## Backups and alerts

- **Backups:** Litestream, pinned in `bin/litestream-pin.sh` (0.5.17). `fleet-litestream` showing active proves nothing: from 10-27 to 10-31 the hub ran Litestream v0.3.13 against the v0.5 config and wrote nothing. The real check is `bin/hub fleet-backup drill`, which restores into a temp dir (7 databases, about 15 s). The weekly `backup-drill` routine (Sunday 05:00) pushes a blocked notice on failure. Details: `docs/backups.md`.
- **Down alert:** `fleet-heartbeat.timer` pings healthchecks.io every 5 minutes (grace 10). It sends `/fail` with the reason when the node, the dashboard or Litestream is down. The URL is in `~/.config/fleet/secrets/heartbeat.env`: never print it. Details: `docs/heartbeat.md`.

## Logs

- `fleet/inbox/.node/node.log`, `dashboard.log` and `browser.log` on the hub. `/etc/logrotate.d/fleet` (written by `bin/fleet-services install`) rotates them weekly or past 10 MB, keeping four gzipped copies (`dashboard.log.1`, `dashboard.log.2.gz`, ...).
- `sudo journalctl -u fleet-node --since -1h` (or any unit above).
- `fleet/inbox/.node/deploys.log` for deploys.

## Procedures

Each procedure has a class:
- **Run**: read-only. The harbormaster runs it whenever asked.
- **Dry run**: shown with `--check` freely. Done for real only when the task prompt quotes the captain's approval (the engineer's merge-and-deploy approval of 2026-11-01 counts for deploys of merged, approved work).
- **Document only**: changes the hub. Done only when the task prompt quotes the captain's approval for that procedure.

Never in any procedure: print or copy the heartbeat URL, `.env` files, the service env, `~/.config/fleet/secrets/*`, `~/.pi/agent/models.json`, or 1Password values; `pgrep -fl`, `ps -E` or `ps eww` on agent processes (use `pgrep -f <name>` for PIDs).

### Run

| Procedure | Command | Expected | When it differs | Last run |
|---|---|---|---|---|
| Deploy check | `bin/hub-deploy --check` | `== the hub is at origin/main (<sha>)`, or the commits it would pull and who is busy; `pi model overrides: current` | Commits on main not deployed: report them (deploying is a Dry run). A tracked local change on the hub: report the file, don't touch it. | 2026-11-01 ok |
| Services drift | `bin/hub fleet-services drift` | No output | Prints why the units are out of date: report it. The fix is a deploy with `--reinstall` (Dry run). | 2026-11-01 ok |
| Backup drill | `bin/hub fleet-backup drill` | `ok <db>: restored and checked` per database (7), `drill passed`, about 20 s | Any `fail` or a missing database: report the lines and `bin/hub fleet-backup status`. Don't restore. | 2026-11-01 ok (18 s) |
| Heartbeat | `bin/hub fleet-heartbeat status` | `ping URL: stored in …`, the timer `active (enabled)`, recent `ok: pinged` lines | `problem: sent /fail` lines: report what they list. `not set`: needs the captain. | 2026-11-01 ok |
| Units | `bin/hub bash -c 'systemctl is-active fleet-node fleet-dashboard fleet-browser fleet-litestream vault-sync.timer fleet-heartbeat.timer'` | `active` six times | A unit not active: `sudo journalctl -u <unit> -n 50 --no-pager` on the hub, and report. Don't restart it. | 2026-11-01 ok |
| Logs | `bin/hub bash -c 'tail -50 ~/Workspace/agents/fleet/inbox/.node/node.log'` (or `dashboard.log`) | No repeated errors in the last hour | Report the repeated lines and their first time. | 2026-11-01 ok |
| Deploy history | `bin/hub bash -c 'tail -5 ~/Workspace/agents/fleet/inbox/.node/deploys.log'` | `<time> <from> <to> deploy`, the last `to` equal to the hub's HEAD | A `rollback` line, or HEAD different from the last `to`: report. | 2026-11-01 ok |
| Vault sync | `bin/hub vault-sync --status` and `bin/vault-sync --status` | `"result":"ok"` within the last few minutes on both | `conflict`: report the detail (see Vault-sync conflict below). | 2026-11-01 ok |
| Laptop worker | `bin/laptop-worker --status` | `service: running`, a tailnet address, `health: {"ok":true,…}` | Not running: report (relaunching it is Document only). | 2026-11-01 ok |
| quota-axi | `command -v quota-axi` on the laptop | A path | Missing: report; Cursor quota checks fail without it. | 2026-11-01 ok |
| Clock | `date -u` on the laptop and `bin/hub date -u` | Within a few seconds | More than a minute apart: report (Clock resync is Document only). | 2026-11-01 ok |

### Dry run

| Procedure | Check | For real | After |
|---|---|---|---|
| Deploy | `bin/hub-deploy --check` | Pull `main` on the laptop first (the script pipes the laptop's copy), then `bin/hub-deploy` | Deploy history shows the new line; Units all active; the output ends `done.` |
| Deploy with new sessions | `bin/hub-deploy --check` | `bin/hub-deploy --new-session <a,b>` when a role, tool or session brief changed | As Deploy, plus `new session <agent>: …` per agent |

### Document only

| Procedure | Command | Notes |
|---|---|---|
| Rollback | `bin/hub-deploy --check --rollback` to see the plan, then `bin/hub-deploy --rollback [sha]` | Resets the hub's main to the commit before the last deploy. The hub is then behind origin/main: push a fix to main before the next deploy. |
| Reinstall services | `bin/hub-deploy --reinstall` | When Services drift reports a change. Restarts the fleet. |
| Litestream | `bin/hub hub-install --litestream`, then `bin/hub fleet-backup install` and a Backup drill | Installs the pinned version (`bin/litestream-pin.sh`). Never trust `fleet-litestream` being active: drill. |
| Clock resync | `bin/hub sudo systemctl restart systemd-timesyncd`, then Clock | After resuming a paused VM, before starting services. |
| Vault-sync conflict | On the machine that reports it: `git -C ~/Workspace/brain status`, resolve the rebase by hand, then `bin/vault-sync` | Never force-push the vault. Ask before touching `career/` or `profile/`. |
| Laptop worker relaunch | `bin/laptop-worker --install` (macOS) | Safe to re-run; then Laptop worker. |
| Restore a database | `bin/hub fleet-backup restore [--timestamp T] [db]` | Stops the fleet. Only for lost or corrupt data. Details: `docs/backups.md`. |

## Runs

| Date | Procedure | Outcome |
|---|---|---|
| 2026-11-01 | All Run procedures (engineer, while writing them) | All as expected. Drill 18 s, 7 databases. Notes: `dashboard.log` is 2.9 MB and has no rotation; `--check` says "would restart services" even with nothing to pull. |
| 2026-11-01 | Deploy check (harbormaster acceptance) | ok: hub at origin/main (fa6e758), pi model overrides current |
| 2026-11-01 | Backup drill (harbormaster acceptance) | ok: 7 databases, 15 s |
| 2026-11-01 | Services drift (harbormaster acceptance) | ok: no output |
| 2026-11-01 | Deploy check, Units (harbormaster, first run by name) | ok: hub at origin/main (b913c78), six units active; dashboard.log 2.9 MB, no rotation (fixed in the next deploy) |
