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

- A new agent appears on the rail with no dashboard change. Agents without art in `lib/agent-art.ts` show initials on the rail and the captain portrait on agent cards. Workers get a portrait from `public/art/crew/` (secondmate tasks from `public/art/secondmate/`), chosen by task id and kept for the task's life; add faces with `bin/agent-portrait --pool`.
- Usage hearts: ten per meter, with the percent remaining beside them.
- Threads stay `fleet/inbox/<id>/captain-chat.jsonl`. One turn per thread at a time; later messages queue in order.
- **Live agents (`runtime: rpc` in `agent.yaml`, the Designer today):** the dashboard's agent host (`lib/agent-host.ts`) keeps one `bin/launch rpc <id>` process (`pi --mode rpc`) per agent. Replies stream into the drawer as they are written, the current step shows under the name, and **Stop** aborts. A message sent while it works is queued as a steer and read before its next step. Extension dialogs (`ask_captain`, Cursor's question tool, confirms) arrive as `kind: "question"` lines with a `dialog` id; the answer goes to `POST /api/dialog/<id>/<dialog-id>` while the tool waits, and is saved as `kind: "answer"` (never a new turn). Idle agents stop after 20 minutes; the session stays on disk. **Start TUI** releases the session from the host first (refused while it is working). Firstmate stays a TUI: it is vendored and runs as designed.
- **Canvas:** every assistant loads `extensions/canvas.ts` (`canvas_show`, `canvas_clear`). Items live in `fleet/inbox/<id>/canvas/<item>/` (`item.json` plus copied files): image sets (optional **Pick** per image, which replies in chat), html pages (sandboxed: scripts allowed, no network beyond the listed CDNs, opaque origin so they cannot call the dashboard), markdown and tables (rendered server-side with `Bun.markdown`, no scripts), and local URLs (`http://localhost` or `127.0.0.1` only, e.g. impeccable boards and dev servers). The drawer's **Canvas · n** button opens a pane beside the chat (full width under 900px); a new item opens it automatically. An html page may reply with `parent.postMessage({type: "fleet-canvas", text}, "*")`, accepted once per item version. Routes: `GET /api/canvas/<id>`, `/canvas/<id>/<item>/view`, `/canvas/<id>/<item>/<file>`.
- Cursor models run their own tools on Cursor's side, so those steps may not show as activity; the reply still streams.
- Agent turns run `bin/launch headless <id>` and stop after 120s, or `turn_timeout:` seconds from `agent.yaml` (the Designer has 900). Stopping a turn also stops its Pi process; the error line quotes anything the agent already reported on Firstmate's bus.
- `dashboard_session: persistent` in `agent.yaml` keeps one Pi session per agent (`fleet/inbox/<id>/sessions/`, id `dashboard-<id>`), shared by dashboard turns and the agent's TUI (`just <id>` or **Start TUI**), so the conversation carries across both. While the TUI is open, dashboard messages to that agent are refused with a pointer to the pane, because both would write the same session. Delete the folder to start the agent fresh. Other agents stay `--no-session`.
- **Start TUI** works for Firstmate and the Designer (`TUI_AGENT_IDS` in `lib/herdr.ts`). The Designer needs its TUI for impeccable live mode and other long poll loops.
- **Clarifying questions:** every assistant loads `extensions/ask-captain.ts` (`ask_captain` tool). In a dashboard turn it writes `fleet/inbox/<id>/pending-questions.json`; when the turn ends the bridge posts one `kind: "question"` line with `questions` (id, question, options, recommended), and the drawer draws each as option chips plus a free-text box. **Send answers** posts one captain message (`Answers:` and a line per question), which starts the next turn; the question then locks. Headless turns set `PI_CURSOR_ASK_QUESTION=false`, because pi-cursor-sdk's own question tool tells the model to pick a default when there is no UI.
- A failed send appends `{"from":"dashboard","kind":"error","reason":"…","ref":"<captain line ts>"}`. The drawer draws it under the message it failed.
- Worker threads carry a `.task` marker. When the task leaves the snapshot (landed or retired), the folder moves to `fleet/inbox/archive/<id>-<date>/`. Archiving is skipped when the snapshot fails.
- Active task rows on the Fleet leaf have a **Chat** button that opens that worker's thread.

## Groups and ADW labels

A group is a rail cluster saved in `fleet/inbox/dashboard-groups.json` (`id`, `name`, `lead`, `members`, optional `adw: {ship, chain}`). Create and delete groups on the Agents leaf.

- Members and the lead are registered assistants only. **Firstmate and its workers cannot join a group**; Firstmate runs its own flow.
- `lead` is required and must be a member. Work assigned to the group goes to the lead, who coordinates the members.
- Opening a group stacks the members' threads in one drawer, in time order. The **To** row picks the recipient and defaults to the lead. The dashboard never sends one message to every member.
- An ADW label is a ship plus one of its `adws/adw_*.py` chains. The Fleet leaf draws the chain's phases (parsed from `PhaseParams(name=...)`) as ordered chips. It does not launch the workflow and is not live status; a reader for `adws/adw_data/sssf.db` can come later.

| Channel | Use |
|---|---|
| **GET** `/api/groups` | Groups JSON |
| **POST** `/api/groups` | Create or replace (form or JSON: `name`, `lead`, `members`, `adwShip`/`adwChain` or form `adw=ship::chain`) |
| **POST** `/api/groups/:id/delete` | Delete |

## Auto routing (Jev)

The composer's **Auto** button lets Jev pick who owns a message: one registered assistant, one group (sent to its lead), or Firstmate. `POST /api/route {text}` runs [`bin/fleet-route-resolve.sh`](../bin/fleet-route-resolve.sh).

| Jev status | Drawer does |
|---|---|
| `clear` | Opens that thread (or the group with **To** on the lead) and sends |
| `ambiguous` (confidence < 0.6), `escalate` (Jev chose ask), `error` | Shows the top choices with probabilities; nothing is sent until you pick |
| `off` (no `TYPESAFE_API_KEY`, or the never-send list matched) | Says why and lists every agent and group to pick from |

Options come from role frontmatter `description:` lines and `dashboard-groups.json`, so keep descriptions to one concrete sentence. Jev is an outside API: the message text leaves the machine, and only when the key is set. `fleet/home/config/dispatch-never-send` applies here too. If Jev routes to Firstmate, Firstmate still runs its own dispatch resolver for the crew profile.

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
