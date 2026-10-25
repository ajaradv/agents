# Fleet State API (v1)

The fleet node (`dashboard/node.ts`, port 8786) is the one place the fleet's state is read and changed from outside its process. An agent on the laptop or in a VM, the dashboard, or a script uses it instead of the hub's files. This is step S3 of the architecture plan (vault `fleet/plans/feature/s3-fleet-state-api.md`).

The node listens on 127.0.0.1. Tailscale Serve publishes it on the tailnet (`https://fleet-hub.<tailnet>.ts.net:8786`) for agents on other hosts; the request guard (`dashboard/lib/request-guard.ts`) admits a tailnet name only with Tailscale's identity header.

## Who calls it, and how they prove it

| Caller | Proof | Routes |
|---|---|---|
| A client (the dashboard, a script on the hub) | `Authorization: Bearer <node token>` (`fleet/inbox/.node/token`, 0600) | `/v1/*` |
| A crewmate (extensions/crew.ts, canvas.ts) | `x-fleet-crew-token`: its live process's token | `/api/crew/<ship>/*` |
| An officer (extensions/fleet.ts) | the same header | `/api/fleet/*` |
| Any agent (extensions/bus.ts) | the same header | `/api/bus/*` |

An agent's token is made when the node starts its process and names that agent: a name in the request body is never trusted.

## Client routes (`/v1/`, node token)

| Route | What |
|---|---|
| `GET /v1/health` | `{ api, pid, startedAt, version, root }` |
| `GET /v1/state` | Who is running, waiting, alive |
| `GET /v1/events` | SSE: `state`, `line`, `host`, `turn`, `ship`, `rail`: the live session view the dashboard draws |
| `GET /v1/ship-events` | SSE: every ship's log as one stream (below) |
| `POST /v1/captain-line`, `/v1/answer`, `/v1/abort`, `/v1/stop`, `/v1/new-session`, `/v1/gate`, `/v1/go`, `/v1/refresh-targets` | Act on a session or a held decision |

## The ship-event stream

`GET /v1/ship-events` streams the ship logs (each ship's `events` table, plus `fleet` for the officers): voyage starts and docks, tasks, checks, crew messages, helpers, turns. It is the fleet's event log, readable without the hub's disk.

- **Start:** new events only (default); `?from=start` for the whole log; `?ships=pochteca,kinwork` to narrow it.
- **Resume:** each event's SSE `id` is a cursor of the last id seen per ship (`fleet:1720,pochteca:617`). A client that drops reconnects with `Last-Event-ID` (EventSource does this by itself) or `?after=<cursor>`, and misses nothing.
- **Frames:** `event: ready` first (`{ships, cursor}`), then `event: ship-event` with `{ship, id, ts, actor, kind, summary, payload}`, oldest first; `: ping` every 15 quiet seconds.

```sh
curl -N -H "Authorization: Bearer $(cat fleet/inbox/.node/token)" \
  "http://127.0.0.1:8786/v1/ship-events?ships=pochteca"
```

## Agent routes (agent token)

| Route | Tool |
|---|---|
| `GET /api/crew/<ship>/status` | `voyage_status` |
| `POST /api/crew/<ship>/tasks`, `/tasks/<n>` | `task_add`, `task_update`, `task_claim`, `task_report` |
| `POST /api/crew/<ship>/message` | `crew_message` |
| `POST /api/crew/<ship>/check`, `/maneuvers` | `run_check`, `maneuver_start` |
| `POST /api/crew/<ship>/look` | `look` (images inline from another host) |
| `POST /api/crew/<ship>/helper` | `helper` (dashboard/lib/helpers.ts) |
| `POST /api/crew/<ship>/canvas` | `canvas_show`, `canvas_clear` from another host |
| `POST /api/crew/<ship>/crew-request`, `/dock-request`, `/helm`, `/vm` | the lead's requests, helm proposals, VM events |
| `GET\|POST /api/fleet/*` | officers' fleet tools (status, log, tasks, chat, actions) |
| `POST /api/bus/post`, `GET /api/bus/read` | `bus_post`, `bus_read` |

## Not through the API yet

The vault (agents on the hub read and write it directly; it syncs through git), a TUI session's captain chat and bus files (no token), and ship memory on a remote host between voyage start and dock (vault S3d).
