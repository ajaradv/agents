# agents (the fleet)

- **Fleet orders**: when the next move is a short, exact sequence of fleet
  actions rather than code work, queue an order for Alice instead of
  describing it: `bin/order format` for the body and the tools, `bin/order check`
  then `bin/order new --by claude-code`. Details in `docs/orders.md`.
- **The fleet from a shell**: `bin/fleet-axi` (ships, voyages, vault tasks, Jev, gate); `next` for the remaining steps of the active vault tasks, `query spend|tool_failures|jev|gate|voyages` for fleet numbers, `note` and `search` for the vault.
- **Tests**: `just test` (the dashboard suite plus the strict typecheck).
- **Deploying to the hub**: after a merge to main, `bin/hub-deploy` (from the laptop) pulls on the
  hub, waits for idle agents, restarts fleet-node and fleet-dashboard, and checks both answer;
  `--check` for a dry run, `--new-session alice` when a role, tools, or the session brief changed.
- **Commands against the live fleet**: the hub's databases are the live ones; run read and label
  commands there with `bin/hub <script> ...` (e.g. `bin/hub fleet-axi extract --unlabelled`).
