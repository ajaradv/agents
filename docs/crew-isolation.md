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
- `/ship-memory`: the ship's shared memory (`fleet/inbox/ships/<ship>/memory`:
  project memory and the voyage scratchpad).
- `/cache`: its cache folder (`fleet/inbox/<ship>-<role>/cache`).
  `PRE_COMMIT_HOME` points there, so pre-commit builds its hook environments
  once per crewmate rather than in every new VM. They are built for the guest
  (Alpine, musl), so this is never the Mac's pre-commit cache. Delete the folder
  to force a rebuild, for example after the VM image changes.
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

## Gates

A ship declares which checks must pass on the latest commit before a task is
done and before a voyage docks:

```yaml
gates:
  task:
    - pytest
  dock:
    - frontend
    - pytest
```

- A gate is green only when that check's latest run on the current commit,
  with no uncommitted changes, passed (runs record their commit in the
  metrics database).
- When a crewmate reports a task done, the helm runs the task gates itself:
  pass, and the task is done; fail, and it is blocked with the output, and the
  crewmate and the lead are told. The crew never marks a gated task done alone.
- Dock refuses until the dock gates are green on the branch's latest commit,
  and says which are missing, failing, or stale. `POST /api/ships/<ship>/gates`
  (stage `dock` or `task`) runs the ones that are not green and sends a notice
  with the result.
- `voyage_status` shows the gates to the crew; the lead's voyage brief names them.

## Maneuvers

A ship declares its maneuvers: what each one runs, who may launch it, and what
the ship needs before it unlocks:

```yaml
maneuvers:
  verify:                       # deterministic: the ship's checks in order
    checks: [lint, pytest, frontend]
    by: [lead, scout, designer] # who may launch it (default: the lead)
  build:                        # an SSSF ADW from the repo's adws/
    adw: adw_plan_build_test
    needs: [designer]           # roles that must be aboard
    gates: [task]               # gate stages the ship must declare
  release:
    adw: adw_ship
    go: true                    # only on the captain's Go
```

- **Locked** when a needed role is not aboard, a gate stage is not declared,
  a check is not one of the ship's checks, or the ADW is not in `adws/`.
  A locked maneuver never starts, even with a Go.
- **Who launches**: crewmates whose role is in `by` get the `maneuver_start`
  tool with those names (bin/launch); the node checks the role again. The
  captain's Go (Alice's `maneuver_start`) may launch any unlocked maneuver.
  ADWs in the repo that no declaration names stay the lead's.
- **Checks maneuvers** run on the host, in the voyage's worktree, stopping at
  the first failure. Each phase's output is saved under
  `fleet/inbox/ships/<ship>/maneuvers/<run>/`, with `handoff.json` as the
  envelope (commit, phases, verdicts, artifacts). A fleet node restart ends a
  running one; the crew is told to launch it again.
- **Gates** listed on a maneuver must pass before it counts as done, for an
  ADW too.
- Every run is a task and a `runs` row (kind `maneuver`) in the metrics
  database; `voyage_status` and the lead's voyage brief list the maneuvers
  and which are locked.

## The helmsman

A ship can take a **helmsman** aboard (shipyard, role `helmsman`): a read-only
crewmate that keeps the ship's process fit as the project grows.

- **When**: after every dock (with the voyage's ledger), or when the captain
  presses **Ask for a review** in the Helm section of the deck.
- **What it gets**: a digest the node builds (`dashboard/lib/helm.ts`): the
  ship's checks, gates, maneuvers, and VM allowlist; build files and justfile
  recipes at the repo root; the last 30 days of check and maneuver runs with
  pass rates, check sets run together voyage after voyage, declared maneuvers
  nobody runs, hosts the VMs blocked, and tool failures.
- **What it does**: reads the repo to confirm, then files proposals with
  `helm_propose`: a check, a gate, a maneuver, retiring a maneuver, allowing a
  host, or a note. Each says why. The node validates them against the ship.
- **Who decides**: the captain, on the deck. **Apply** edits the ship file
  (keeping comments and everything else); **Dismiss** drops it. Nothing
  changes the ship file without the captain. Crewmates pick up applied
  changes at their next start.
