# Hub backups

The hub keeps fleet state in SQLite. Litestream v0.5.17 replicates it, continuously,
to a Cloudflare R2 bucket, so losing the VM loses at most a few seconds of writes.
The hub is the exe.dev Linux VM. `bin/fleet-backup` sets the backup up and checks it.
`bin/hub-install` installs the pinned Litestream binary. Voyage VMs are not backed up.

The laptop is no longer the hub. A LaunchAgent that would read the Keychain on macOS
is a follow-up; `bin/fleet-backup` exits 2 there. `bin/hub-install --litestream` can
still install the binary on a Mac (the pin covers darwin-arm64 and darwin-x86_64).

`bin/hub-deploy` keeps the binary on the pin: when `fleet-litestream` exists and
`~/.local/bin/litestream version` differs from `LITESTREAM_VERSION` in
`bin/litestream-pin.sh`, it runs the pin script and restarts the unit (`--check` only
reports it). A v0.3 binary against the v0.5 config shows the unit as active while it
writes nothing, so `bin/fleet-backup drill` is the real check.

Nothing was replicated with Litestream 0.3, so this is a fresh 0.5 config. There is
no generation migration.

## What is replicated

Under `fleet/inbox/` on the hub: `.node/metrics.db`, `.node/journal.db`, and
`ships/<ship>/ship.db`. Skipped: test ships `zz-*`, ships named `fixture` or `rig`,
`sssf.db`, and anything under a `fixture/` or `rig/` directory. Each database goes
to `fleet-hub/<path without .db>` in the bucket (for example
`fleet-hub/ships/lineage_atria/ship`).

Litestream syncs every 10s. It takes a level-9 snapshot every 24h and keeps those
snapshots for 720h (30 days). Litestream deletes expired files itself. Level-0 files
keep Litestream's default 5 minute retention, so a point-in-time restore is
fine-grained for those few minutes and the daily snapshots cover the rest of the
30 days. Do not add an age-based delete on the bucket; that would fight retention.

A `ship.db` the fleet creates is added within a few seconds (`lib/ship-log.ts` runs
`bin/fleet-backup reconcile`). The `backups` routine (every 15 minutes) is the
backstop for a database created some other way. Reconcile restarts `fleet-litestream`
only when the set of databases changed and the service is already running.

`ship.db` connections set `busy_timeout` to 5 seconds so a Litestream checkpoint
does not surface as `SQLITE_BUSY`.

## Cloudflare (once)

1. Create a private R2 bucket named `ajaradv-fleet-hub-backups` in ENAM. No public
   access, no r2.dev URL.
2. Create an Account API token with Object Read & Write scoped to that bucket only.
   Litestream's retention deletes old files, so the token needs that write scope,
   and it must not be able to reach any other bucket.
3. Endpoint `https://<account_id>.r2.cloudflarestorage.com`, region `auto`.
   `bin/fleet-backup config` writes both into `litestream.yml` (`force-path-style`
   included). The account id and the bucket name are not secrets.
4. Lifecycle: one rule, abort incomplete multipart uploads after 1 day. No
   age-based expiration. Litestream's snapshot retention is what prunes old backups.

## Set up (once)

1. Do the Cloudflare steps above and copy the account id. Keep the token's access
   key id and secret off the command line, out of git, and out of the shell history.
2. On the hub, `bin/hub-install` (or `bin/hub-install --litestream` when the rest of
   the host is already installed). That downloads Litestream v0.5.17, checks the
   pinned SHA-256, and installs `~/.local/bin/litestream`.
3. Store the credentials. Either:

   ```
   bin/fleet-backup creds
   ```

   The access key id and the secret are read with echo off. The account id and the
   bucket are ordinary prompts (the bucket defaults to `ajaradv-fleet-hub-backups`).
   With no terminal, pipe four lines on stdin instead:

   ```
   LITESTREAM_ACCESS_KEY_ID=...
   LITESTREAM_SECRET_ACCESS_KEY=...
   R2_ACCOUNT_ID=...
   R2_BUCKET=ajaradv-fleet-hub-backups
   ```

   `creds` takes no arguments. It writes the two secrets through the secret store
   (`~/.config/fleet/secrets/`, directory 0700, files 0600) and writes
   `~/.config/fleet/secrets/litestream.env` (0600) with all four lines. It does not
   enable the service.

   Creating that env file by hand, mode 0600, is the same result. The systemd unit
   reads it as `EnvironmentFile`. The keys are not copied into the unit or the yml.

4. `bin/fleet-backup install` writes `~/.config/fleet/litestream.yml` (no keys) and
   the `fleet-litestream` systemd unit, then enables and starts it. Until the env
   file is complete this command exits 3 and does not install or start the unit.
   The unit also has `ConditionPathExists` on the env file, so a missing file does
   not crash-loop. Run install again after moving the repo or upgrading Litestream;
   it restarts the service only when the config or the unit changed.

## Keeping it honest

- `bin/fleet-backup status` shows whether `fleet-litestream` is active, each
  database's `litestream status`, and the latest level-9 snapshot (`litestream ltx
  -level 9`). v0.5 has no `snapshots` or `generations` commands.
- `bin/fleet-backup drill` restores every database into a temp directory, runs
  `PRAGMA integrity_check`, compares row counts with the live databases (the live
  one may be a few writes ahead; that is reported, not a failure), prints seconds
  per database and in total, and deletes the temp files. It exits non-zero on an
  integrity error or a missing or empty restore. Run it after setup and now and
  then; the time it prints is the restore time to plan with.
- The `backups` node job says "not set up" until the env file exists (one reminder
  a week) and, once it does, notices a stopped service or a failed reconcile (once
  a day).

## Restore

`bin/fleet-backup restore` stops `fleet-node`, `fleet-dashboard`, `fleet-browser`,
and `fleet-litestream` (a unit that is not installed is skipped), moves each
database and its `-wal`, `-shm`, and Litestream metadata directory aside, runs
`litestream restore`, checks `PRAGMA integrity_check`, and starts the fleet again.
A failure leaves the fleet stopped. The previous files are the `*.aside-<stamp>`
copies.

```
bin/fleet-backup restore
bin/fleet-backup restore --timestamp 2006-01-02T15:04:05Z
bin/fleet-backup restore /path/to/fleet/inbox/.node/metrics.db
```

`--timestamp` is UTC RFC3339. One database path limits the restore to that file;
it has to be a path already in the config.

On a fresh hub: `bin/hub-install`, clone the repo, `bin/fleet-backup creds` (or
recreate the env file), then `bin/fleet-backup restore` if the config already lists
the databases, or `bin/fleet-backup install` after the files are back. `litestream
restore` will not overwrite a file that is still in place; the `restore` subcommand
moves it aside first.
