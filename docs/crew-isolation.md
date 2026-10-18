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

## Screenshots in the VM (designers)

Agents with `vm_image: browser` in `agent.yaml` (the designer) get the browser
image: the fleet image plus Chromium, Noto fonts (with emoji and CJK), and
`shot`, which drives Chromium with playwright-core:

```
shot index.html                      # desktop 1440x900 and mobile 390x844
shot http://localhost:5173 --full    # a dev server started in the VM, whole page
shot page.html --mobile --dark --selector main
```

- PNGs go to `/cache/shots` (the crewmate's cache folder on the Mac, outside
  the repo, so screenshots never dirty a voyage's worktree). `shot` prints
  their paths, then the page's console errors and failed requests.
- The crewmate reads a PNG with its read tool to see it, and shows it with
  `canvas_show` (`kind: image`) using the same `/cache/shots/...` path: the
  canvas maps guest paths (`/workspace`, `/cache`, `/memory`,
  `/ship-memory`) to the Mac's folders.
- The VM keeps its network allowlist. Gondolin answers HTTPS for allowed hosts
  with its own certificate authority; `shot` tells Chromium to trust exactly
  that authority's key. A CDN the ship does not allow shows up under failed
  requests, and the page renders without it.
- A dev server started inside the VM is reachable at localhost; servers on the
  Mac (and the dashboard) are not.
- These VMs get 2 GB instead of 1 GB.
- Build the image once: `bin/fleet-vm-image browser` (about 1.6 GB). It is
  built from `fleet/vm/image.json` plus `fleet/vm/browser.json`, so rebuild it
  too after changing the base packages. Until it is built, designers get the
  plain image and the launcher says so.

## Skills inside the VM

Pi lists an agent's skills by their paths on the Mac (`skill_paths` in
`agent.yaml`, plus `~/.agents/skills` and `~/.pi/agent/skills` unless
`discover_skills: false`). Those folders are mounted **read-only** at the same
paths in the VM, so a crewmate can read a skill and run its scripts but never
change one. Nothing else under the home folder is mounted: the folders along
those paths exist in the guest only as empty parents of the mounts.

## Setup (once)

- `brew install qemu e2fsprogs` (e2fsprogs is keg-only and only used to build images).
- `bin/fleet-vm-image` builds the guest image from `fleet/vm/image.json` into
  `fleet/home/gondolin/fleet-assets` (about 20 s, 630 MB). Add Alpine packages
  there and rebuild when a ship needs more tools.
- `bin/fleet-vm-image browser` builds the designers' browser image (above).

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
- **Who decides**: the captain, on the deck. **Apply** writes the change to the
  ship's live overlay (docs/ship-config.md), never the committed file;
  **Dismiss** drops it. Nothing changes without the captain. Crewmates pick up applied
  changes at their next start.

## Tool gate (R4f)

Every agent's tool calls pass through `extensions/tool-gate.ts` (loaded for
every assistant by `bin/launch`). Two layers:

1. **Local rules** (`extensions/tool-gate/rules.ts`), instant, nothing sent:
   - **allow**: fleet and crew tools, reads, routine project commands (git,
     just, tests, builds, linters, file edits inside the agent's folders),
     and everything a crewmate's own tools do inside its VM;
   - **stop**: secrets (`~/.ssh`, `.env`, 1Password, pi's logins, private
     keys), downloading and running code, pushing to main or forcing,
     `sudo`, deleting home or root folders, erasing disks;
   - **ask**: anything else, inline code (`python3 - <<EOF`, `node -e`),
     writes outside the agent's folders, unfamiliar tools, and messages that
     ask another agent to push, merge, or reveal secrets.
2. **Jev** (`dashboard/lib/tool-gate.ts`), for the asked calls: one choice
   question with secrets redacted, about 0.1–0.3 s. safe → allowed;
   stop → blocked and logged (ship log, Health tool failures); inspect or
   unsure (under 60%) → held in Needs you with **Allow once** / **Deny**. With
   no answer from Jev or the node, the call is held or blocked, never allowed.

**Mode** (`FLEET_TOOL_GATE`, default `observe`): `observe` enforces the local
stops and judges everything else in the background, logging what the gate would
have done without blocking; `enforce` makes holds and stops take effect; `off`
disables the gate. Health > Diagnostics shows the gate's last day. Switch to
`enforce` once the would-hold rate on real traffic is low.

Measured on last week's 985 fleet tool calls: the local rules decide 89%
(allow) and send 11% to Jev; none stopped. Before calibration Jev would have
held 14 of 20 sampled asked calls, mostly harmless scratch edits, which is why
the gate starts in observe mode.

Not covered yet: Firstmate (an orchestrator with its own pipeline) does not load
the gate; Cursor agents started by the `cursor` tool run their own tools,
which the gate cannot see (only the prompt sent to them is screened).
