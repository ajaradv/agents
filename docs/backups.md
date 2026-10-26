# Hub backups

The hub keeps all fleet state in SQLite. Litestream replicates it, continuously, to a
Cloudflare R2 bucket, so losing the VM loses at most a few seconds of writes.
`bin/fleet-backup` sets it up and checks it; `bin/hub-install` installs the pinned
Litestream (v0.3.13). Voyage VMs are not backed up.

## What is replicated

Under `fleet/inbox/` on the hub: `.node/metrics.db`, `.node/journal.db`, and
`ships/<ship>/ship.db` for every ship (test ships `zz-*` are skipped). Each goes to
`fleet-hub/<path without .db>` in the bucket (for example `fleet-hub/ships/lineage_atria/ship`).
Litestream syncs every 10 s, takes a snapshot a day, and keeps 30 days.

## Set up (once)

1. Create an R2 bucket (no public access).
2. Create an R2 API token with Object Read & Write on that bucket only.
3. On the hub, create `~/.config/fleet/secrets/litestream.env` (mode 0600):

   ```
   LITESTREAM_ACCESS_KEY_ID=...
   LITESTREAM_SECRET_ACCESS_KEY=...
   R2_ACCOUNT_ID=...
   R2_BUCKET=...
   ```

4. `bin/fleet-backup install` writes `~/.config/fleet/litestream.yml` (no keys in it) and the
   `fleet-litestream` systemd service, and starts it. Run it again after moving the repo or
   upgrading Litestream; it restarts the service only when the config or unit changed.

Until the file exists, `bin/fleet-backup` prints these steps and exits 3, and the `backups`
node job answers "not set up" (one reminder a week).

## Keeping it honest

- The `backups` routine (every 6 hours) runs `bin/fleet-backup reconcile`, which adds a new
  ship's `ship.db` to the config and restarts the service, and checks `fleet-litestream` is
  active. A stopped service or a failed reconcile becomes a notice (once a day).
- `bin/fleet-backup status` shows the service and each database's latest snapshots and generations.
- `bin/fleet-backup drill` restores every database into a temp directory, runs
  `PRAGMA integrity_check`, compares row counts with the live databases (the live one may be a
  few writes ahead; that is reported, not a failure), prints seconds per database and in total,
  and deletes the temp files. It exits non-zero on an integrity error or a missing or empty
  restore. Run it after setup and now and then; the time it prints is the restore time to plan with.

## Restore onto a fresh hub

1. `bin/hub-install`, clone the repo, and recreate `~/.config/fleet/secrets/litestream.env`.
2. Stop the fleet: `sudo systemctl stop fleet-node fleet-dashboard` (and `fleet-litestream` if it runs).
3. For each database, restore to its original path (the config lists them; if the new hub has no
   ship folders yet, write the config by hand from the bucket's `fleet-hub/` prefixes):

   ```
   set -a; . ~/.config/fleet/secrets/litestream.env; set +a
   litestream restore -config ~/.config/fleet/litestream.yml fleet/inbox/.node/metrics.db
   ```

   `litestream restore` refuses to overwrite an existing file; move the old one aside first.
   Add `-timestamp <RFC3339>` to restore to a point in time.
4. `bin/fleet-backup install`, then `sudo systemctl start fleet-node fleet-dashboard`.
