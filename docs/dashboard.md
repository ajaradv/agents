# Fleet dashboard

Local control surface for agent status, subscription usage, and captain chat. Binds **`127.0.0.1`** only (default port **8787**).

```bash
just dashboard
# open http://127.0.0.1:8787
```

## Talk vs watch (TUI)

| Surface | What runs | UI badges |
|---|---|---|
| **Headless chat** | `bin/launch headless <agent>` (`pi -p`) per message — **alice** and **architect** only | **chat ready** / **chat thinking** / **chat error** |
| **Firstmate chat** | **`fm-send`** into the **one** running Firstmate TUI (no second Pi) | **chat → TUI** when TUI is up |
| **Optional TUI** | Herdr session **`fleet`**, workspace **`fleet-<agent>`** | **TUI off** / **TUI open** / **TUI error** |

Alice chat works without TUI. **Firstmate** chat requires that single TUI (`just firstmate` or **Start TUI**). **Start TUI** will not launch a second Firstmate if `session.json` pid is already alive.

**Waiting on you:** formal captain holds from `fm-fleet-snapshot` (`captain_actionable`) plus **`captain-wait`** lines on `fleet/inbox/firstmate/events.jsonl` (see [roles/firstmate.md](../roles/firstmate.md)).

**Start TUI** / **Stop TUI** apply to **alice**, **firstmate**, and **architect**. Attach: **`herdr session attach fleet`**.

Restarting **`just dashboard`** does not start Herdr, TUI workspaces, or headless daemons. Only **Start TUI** may spawn Herdr and `bin/launch`.

Captain messages append to **`fleet/inbox/<agent>/captain-chat.jsonl`**. Replies are appended by the chat bridge and pushed over WebSocket. Debug: **`fleet/inbox/dashboard.log`** (`chat-turn` lines), sidebar **Last chat turn** details, **`GET /api/chat-turns`**.

Firstmate crew workers (`fm-spawn` panes) are unchanged — not started from this UI.

## Lifecycle (TUI only)

**TUI starting / open / stopping / error** reflect Herdr pane state. A failed Start can show **TUI error** while **chat ready** stays available. When the pane is live, **TUI open** overrides a stale Start timeout error.

## Transport

| Channel | Use |
|---|---|
| **SSE** `/events` | Usage (every 10 min after boot) and agent sidebar |
| **GET** `/api/agents` | Chat + TUI status JSON |
| **GET** `/api/chat-turns` | Last headless turn per agent |
| **WebSocket** `/ws/chat/:id` | Text chat |
| **POST** `/agents/:id/start` · `/stop` | TUI only (alice, firstmate, architect) |

Stack: htmx 4 and Alpine.js. Health, Fleet, and Agents are leaves. Alice is a full-height panel from the right. On a phone, those four sit in a bottom dock. Live updates use `EventSource` on `/events`, then `htmx.ajax` refreshes the partial in that leaf.

## Usage metrics

**`quota-axi --json --max-age 15m`** runs once at dashboard boot, then every **10 minutes** (20s timeout). **Subscription usage** cards list subscribed providers only. **Configured API lanes** poll vendor endpoints with keys from `fleet/home/.env`: DeepSeek `GET /user/balance`, OpenRouter `GET /api/v1/key` (month spend + remaining). Hugging Face stays key presence only (no personal remaining-credits API). API-lane cards still render when quota-axi is empty. Providers quota knows about but you have not signed into appear under a collapsed “without an account” section. Quota refresh pauses 30s when you click **Start TUI**.

**Fleet overview** polls read-only `fm-fleet-snapshot --json` on agent SSE refresh: in-flight tasks grouped by project, plus **Firstmate heartbeat** lines (`kind: heartbeat` on the bus from Pi extension `fleet-dashboard-heartbeat`).

SSE **`/events`** sends comment heartbeats every 15s to keep the chunked stream alive.

## Hermes

Alice and Architect headless/TUI launches use vault Hermes under **`{ALICE_VAULT}/.pi/agent/pi-hermes-memory/`**.

## Prerequisites

- **pi** on PATH (Cursor auth for configured models)
- **herdr** on PATH for optional TUI Start/Stop
- **quota-axi** optional for usage cards

## Future

- Gemini Live on `/ws/voice/alice` (same jsonl path)
- Impeccable visual pass and avatar slot
