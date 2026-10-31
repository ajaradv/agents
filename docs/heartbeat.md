# Hub heartbeat

An outside alert for when the hub goes down. `bin/fleet-heartbeat` is a dead-man's
switch on [healthchecks.io](https://healthchecks.io): the hub pings a private check URL every
5 minutes, but only while the fleet is healthy. If the pings stop, healthchecks.io alerts the
captain's phone.

## Why

The hub's own push notices cannot fire when the hub is down, and the 2026-10-27 backup stall
showed how long a failure can stay silent. The hub is only on the tailnet, so nothing
outside can poll it; instead it calls out. The check is a systemd timer, not a node routine,
so it still runs when fleet-node is the thing that died.

## What is checked

Each run (`bin/fleet-heartbeat run`, every 5 minutes):

- fleet-node answers `GET /v1/health` on 127.0.0.1:8786 with the token from `fleet/inbox/.node/token`
- the dashboard answers 200 on 127.0.0.1:8787
- `fleet-litestream` is active, when that unit exists

All good: a plain ping. Any problem: the problem lines are POSTed to `<url>/fail`, and
healthchecks.io shows them in the alert.

## Setup

1. On healthchecks.io, create a check with period 5 minutes and grace 10 minutes.
2. Add the phone integration (the healthchecks app, ntfy, or email).
3. Copy the check's ping URL (`https://hc-ping.com/<uuid>`).
4. On the hub: `bin/fleet-heartbeat url` (hidden prompt; never an argument), then
   `bin/fleet-heartbeat install`. From the laptop: `bin/hub fleet-heartbeat url`.

The URL is the secret: it lives in `~/.config/fleet/secrets/heartbeat.env` (mode 0600) and is
never printed. `bin/fleet-heartbeat status` shows the timer and the last runs.
`bin/hub-install` runs `install` when the env file exists.

## Reading an alert

- **A /fail ping with lines**: the hub is up and reachable but something is wrong (node,
  dashboard, or Litestream). The body says which.
- **No pings (check goes down after the grace)**: the hub, its network, or the timer is dead.
  Nothing more is known; check the exe.dev VM.

## Pausing

Pause the check on healthchecks.io, or `sudo systemctl stop fleet-heartbeat.timer` during
maintenance (start it again after). A normal `bin/hub-deploy` restart takes well under the
10-minute grace, so it needs no pause.
