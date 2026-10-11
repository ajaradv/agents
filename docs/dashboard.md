# Fleet dashboard

Local control surface for agent status, subscription usage, and captain chat. Binds **`127.0.0.1`** only (default port **8787**).

```bash
just dashboard
# open http://127.0.0.1:8787
```

## Talk vs watch (TUI)

| Surface | What runs | UI badges |
|---|---|---|
| **Headless chat** | `bin/launch headless <agent>` (`pi -p`) per message — every `type: assistant` in `agents/*/agent.yaml` | **chat ready** / **chat thinking** / **chat error** |
| **Firstmate chat** | **`fm-send`** into the **one** running Firstmate TUI (no second Pi) | **chat → TUI** when TUI is up |
| **Optional TUI** | Herdr session **`fleet`**, workspace **`fleet-firstmate`** | **TUI off** / **TUI open** / **TUI error** |

Alice chat works without TUI. **Firstmate** chat requires that single TUI (`just firstmate` or **Start TUI**). **Start TUI** will not launch a second Firstmate if `session.json` pid is already alive.

**Waiting on you:** formal captain holds from `fm-fleet-snapshot` (`captain_actionable`, including `hold_reason`) plus **`captain-wait`** lines on `fleet/inbox/firstmate/events.jsonl` (see [roles/firstmate.md](../roles/firstmate.md)). The mast and Fleet leaf show the hold reason. A live hold with no matching wait gets a `captain-wait` line from the dashboard, cleared when the hold closes. The Fleet leaf answers the hold in place: `fm-captain-hold.sh answer --release` plus `An` lines on the linked plan. That write does not need a live Firstmate pane. `bin/plan-ship-gate.ts` refuses `fm-promote.sh` while any `Qn` in that plan still lacks `An`.

**Start TUI** / **Stop TUI** apply to **Firstmate** only. Alice and Architect stay headless. Attach: **`herdr session attach fleet`**.

Restarting **`just dashboard`** does not start Herdr, TUI workspaces, or headless daemons. Only **Start TUI** may spawn Herdr and `bin/launch`.

Captain messages append to **`fleet/inbox/<agent>/captain-chat.jsonl`**. Replies are appended by the chat bridge and pushed over WebSocket. Debug: **`fleet/inbox/dashboard.log`** (`chat-turn` lines), sidebar **Last chat turn** details, **`GET /api/chat-turns`**.

Firstmate crew workers (`fm-spawn` panes) are unchanged — not started from this UI.

## Chat rail

A right-edge rail holds one portrait per chat target, with one drawer and one composer. Tapping a face swaps the thread. On a phone the rail collapses to one **Chat** button; the drawer then shows the faces in a strip under its header.

| Row | Source | Send path |
|---|---|---|
| Agents | `agents/*/agent.yaml` (`type: assistant`, plus `firstmate`) | Assistants: headless turn. Firstmate: `fm-send` into the one TUI. |
| Crew | Non-terminal tasks in `fm-fleet-snapshot --json` | `fm-send <task-id>` into that worker's steering inbox |

- A new agent appears on the rail with no dashboard change. Agents without art in `lib/agent-art.ts` use the captain portrait; workers show initials.
- Threads stay `fleet/inbox/<id>/captain-chat.jsonl`. One turn per thread at a time; later messages queue in order.
- A failed send appends `{"from":"dashboard","kind":"error","reason":"…","ref":"<captain line ts>"}`. The drawer draws it under the message it failed.
- Worker threads carry a `.task` marker. When the task leaves the snapshot (landed or retired), the folder moves to `fleet/inbox/archive/<id>-<date>/`. Archiving is skipped when the snapshot fails.
- Active task rows on the Fleet leaf have a **Chat** button that opens that worker's thread.

## Lifecycle (TUI only)

**TUI starting / open / stopping / error** reflect Herdr pane state. A failed Start can show **TUI error** while **chat ready** stays available. When the pane is live, **TUI open** overrides a stale Start timeout error.

## Transport

| Channel | Use |
|---|---|
| **SSE** `/events` | Usage (every 10 min after boot) and agent sidebar |
| **GET** `/api/agents` | Chat + TUI status JSON |
| **GET** `/api/chat-turns` | Last headless turn per agent |
| **GET** `/api/chat-targets` | Rail faces: `agents` and `workers`, with thinking + last turn |
| **SSE** `rail` event | Rail membership changed (checked every 20s) |
| **WebSocket** `/ws/chat/:id` | Text chat |
| **POST** `/agents/:id/start` · `/stop` | Firstmate TUI only |

Stack: htmx 4 and Alpine.js. Health, Fleet, and Agents are leaves; chat is the rail and its drawer. On a phone, the three leaves sit in a bottom dock. Live updates use `EventSource` on `/events`, then `htmx.ajax` refreshes the partial in that leaf.

## Usage metrics

**`quota-axi --json --max-age 15m`** runs once at dashboard boot, then every **10 minutes** (20s timeout). **Subscription usage** cards list subscribed providers only. **Configured API lanes** poll vendor endpoints with keys from `fleet/home/.env`: DeepSeek `GET /user/balance`, OpenRouter `GET /api/v1/key` (month spend + remaining). Hugging Face stays key presence only (no personal remaining-credits API). API-lane cards still render when quota-axi is empty. Providers quota knows about but you have not signed into appear under a collapsed “without an account” section. Quota refresh pauses 30s when you click **Start TUI**.

**Fleet overview** polls read-only `fm-fleet-snapshot --json` plus `state/home-summary.json` and `data/projects.md`: a Firstmate status card (home state, summary validity, heartbeat, TUI attach) and one card per registered project (active, queued, waiting). Extra work without a registered ship still gets a card. It does not start workers.

The leaf has three layers, drawn separately because they can overlap:

| Layer | Source | Notes |
|---|---|---|
| Projects | `fleet/home/data/projects.md` | Firstmate's registry. The dashboard reads it, never writes it. |
| Ships | `fleet/ships/*.yaml` | Path, mode, factory, and the ADW chains found in `<ship>/adws/adw_*.py`. Flags ships not registered with Firstmate. |
| Initiatives | `{ALICE_VAULT}/fleet/initiatives/*.md` | Vault-only. Frontmatter `title`, `status` (`active`/`paused`/`done`), `ships`, `projects`, `plans`. Hidden when the folder is missing; `bin/setup-alice-vault` creates it. |

SSE **`/events`** sends comment heartbeats every 15s to keep the chunked stream alive.

## Hermes

Alice and Architect headless launches use vault Hermes under **`{ALICE_VAULT}/.pi/agent/pi-hermes-memory/`**.

## Prerequisites

- **pi** on PATH (Cursor auth for configured models)
- **herdr** on PATH for optional TUI Start/Stop
- **quota-axi** optional for usage cards

## Future

- Gemini Live on `/ws/voice/alice` (same jsonl path)
- Impeccable visual pass and avatar slot
