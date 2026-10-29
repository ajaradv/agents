# agents (the fleet)

- **Fleet orders**: when the next move is a short, exact sequence of fleet
  actions rather than code work, queue an order for Alice instead of
  describing it: `bin/order format` for the body and the tools, `bin/order check`
  then `bin/order new --by claude-code`. Details in `docs/orders.md`.
- **The fleet from a shell**: `bin/fleet-axi` (ships, voyages, vault tasks, Jev, gate); `next` for the remaining steps of the active vault tasks, `query spend|tool_failures|jev|gate|voyages` for fleet numbers, `note` and `search` for the vault.
- **Tests**: `just test` (the dashboard suite plus the strict typecheck).
