# Crew isolation (R4)

A ship can run its crewmates' built-in tools (read, write, edit, bash, grep,
find, ls) inside a local Gondolin micro-VM instead of on the Mac. Officers
(Alice, the Architect, Firstmate) are not affected. Plan and measurements:
vault `fleet/plans/feature/r4-crew-isolation.md`.

## Turn it on for a ship

In `fleet/ships/<ship>.yaml`:

```yaml
isolation: vm          # crewmates' tools run in a VM ("host" or absent: as before)
vm_allow:              # hosts the VM may reach over HTTP/HTTPS; omit for the default
  - pypi.org           # list (package registries, GitHub and raw.githubusercontent.com over HTTPS); [] for no network
checks:                # host commands crewmates may run by name (run_check)
  pytest: just pytest
  lint: just lint
```

Crewmates pick up the change when they next start (New session, or a services
restart).

## What a crewmate in a VM sees

- `/workspace`: the ship's repo (read-write; commits land in the real repo).
- `/memory`: its memory folder (`fleet/inbox/<ship>-<role>/memory`).
- Nothing else from the Mac, no provider keys, no fleet tokens.
- Network: only `vm_allow` hosts, HTTP and HTTPS only; blocked hosts are
  logged on the ship log (kind `vm`) and on Health under Tool failures
  (tool `network`), so a missing host is easy to spot and add.
- Tests that need Docker (or anything else the VM cannot run): `run_check`
  with one of the ship's `checks`. It runs on the Mac in the ship's repo with a
  15 minute limit (`FLEET_CHECK_TIMEOUT_SECS`); the crewmate never writes the
  command.

If the VM cannot start, its tools fail with "Isolation is unavailable"; they
never fall back to running on the Mac.

## Setup (once)

- `brew install qemu e2fsprogs` (e2fsprogs is keg-only and only used to build images).
- `bin/fleet-vm-image` builds the guest image from `fleet/vm/image.json` into
  `fleet/home/gondolin/fleet-assets` (about 20 s, 630 MB). Add Alpine packages
  there and rebuild when a ship needs more tools.

## Voyages work in their own worktree

For ships the fleet's crew sails (`orchestrator: lead`), every voyage gets its
own git worktree, leased from [treehouse](https://github.com/kunchenguid/treehouse)'s
pool the way Firstmate does it (`treehouse get --lease`):

- On **Set sail**, the fleet leases a worktree, checks it is a real linked
  worktree (not your checkout) and clean, and creates a conventional branch (`<type>/<words>`, see `skills/git-conventions`) from
  the default branch (origin's HEAD, else main or master). The record is
  `fleet/inbox/ships/<ship>/worktree.json`; the voyage note shows the branch.
- Crewmates start in the worktree (a crewmate already running restarts on its
  next message); a VM mounts it at `/workspace`, plus the repo's `.git` at its
  own path so commits work. `run_check` runs there too.
- Your own checkout is never touched.
- On **Dock**, the fleet refuses while the worktree has uncommitted work;
  otherwise it returns the worktree to the pool (`treehouse return --force`),
  keeps the branch, tells you how many commits it has to review and merge,
  and warns if your checkout's branch moved during the voyage.

Ships Firstmate runs are unchanged: Firstmate manages worktrees itself.
