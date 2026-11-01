# The hub

The hub runs the live fleet: the fleet node, the dashboard, the browser service, the backups and the timers. This is its runbook. E1 has the facts; the procedures come in E2 (plan `fleet/plans/feature/fleet-engineer.md` in the vault).

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

- `fleet/inbox/.node/node.log` and `dashboard.log` on the hub.
- `sudo journalctl -u fleet-node --since -1h` (or any unit above).
- `fleet/inbox/.node/deploys.log` for deploys.
