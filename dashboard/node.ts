import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptCaptainLine,
  getAllLastChatTurns,
  getHeadlessChatState,
  registerChatBroadcaster,
  registerChatEventBroadcaster,
  setChatTurnEmitter,
  startChatBridge,
} from "./lib/chat-bridge.ts";
import { abortHost, answerDialog, crewCaller, hostAlive, hostIds, hostRunning, hostWaiting, startHostReaper, stopHost } from "./lib/agent-host.ts";
import { allChatTargetIds, chatAllowed, chatTarget, refreshAgentTargets, startChatTargetRefresh } from "./lib/chat-targets.ts";
import type { ChatLine } from "./lib/chat.ts";
import { crewAddTask, crewMessage, crewStartManeuver, crewUpdateTask, voyageStatus } from "./lib/crew-api.ts";
import { agentChatRead, fleetCallerAllowed, fleetChat, fleetStatus, shipLog, shipManeuvers, shipTasks } from "./lib/fleet-api.ts";
import { dashLog } from "./lib/log.ts";
import { nodeToken, tokenMatches } from "./lib/node-auth.ts";
import type { NodeAgentState, NodeState } from "./lib/node-client.ts";
import { HOST, NODE_PORT, nodeStateDir, ROOT } from "./lib/paths.ts";
import { requestRefusal } from "./lib/request-guard.ts";
import { onShipLogWrite } from "./lib/ship-log.ts";
import { newSession } from "./lib/session-rotate.ts";

/**
 * The fleet node: the long-lived local process that runs the fleet's agents.
 *
 * It owns everything that must outlive a dashboard restart: live Pi sessions
 * (agent host), chat turns of every kind (chat bridge), open ask_captain
 * dialogs, and the crew API crewmates call back into. The dashboard is its
 * first client: it appends captain lines, then hands them here, and mirrors
 * agent state from the event stream.
 *
 * API (loopback, bearer token from fleet/inbox/.node/token; versioned):
 *   GET  /v1/health          { api, pid, startedAt }
 *   GET  /v1/state           NodeState (who is running, waiting, alive)
 *   GET  /v1/events          SSE: line, host, state, turn, ship, rail
 *   POST /v1/captain-line    { agentId, line }   a saved captain or crew line to run
 *   POST /v1/answer          { agentId, dialogId, value?, confirmed?, cancelled? }
 *   POST /v1/abort|stop|new-session  { agentId }
 *   POST /v1/refresh-targets after crew changes
 * Crew API (extensions/crew.ts, crew token): /api/crew/<ship>/<status|tasks|message|maneuvers>
 * Fleet API (extensions/fleet.ts, officers' crew token): GET /api/fleet/<status|log|tasks|maneuvers|chat>, POST /api/fleet/chat
 */

export const NODE_API = 1;
const startedAt = new Date().toISOString();
const token = nodeToken();

type Sub = ReadableStreamDefaultController<Uint8Array>;
const subs = new Set<Sub>();
const enc = new TextEncoder();

function emit(event: string, data: unknown): void {
  const frame = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const s of subs) {
    try {
      s.enqueue(frame);
    } catch {
      subs.delete(s);
    }
  }
}

function snapshot(): NodeState {
  const agents: Record<string, NodeAgentState> = {};
  const turns = getAllLastChatTurns();
  for (const id of new Set([...allChatTargetIds(), ...hostIds()])) {
    const h = getHeadlessChatState(id);
    agents[id] = { running: hostRunning(id), waiting: hostWaiting(id), alive: hostAlive(id), thinking: h.thinking, lastTurn: turns[id] ?? h.lastTurn };
  }
  return { api: NODE_API, pid: process.pid, startedAt, agents };
}

// State goes out whenever it changes: right after host activity, and on a 1s
// check that catches headless turns starting (they have no hook of their own).
let lastState = "";
let stateTimer: ReturnType<typeof setTimeout> | null = null;
function stateChanged(): void {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const s = snapshot();
    const key = JSON.stringify(s.agents);
    if (key === lastState) return;
    lastState = key;
    emit("state", s);
  }, 50);
}
setInterval(stateChanged, 1000);

registerChatBroadcaster((agentId, line) => {
  emit("line", { agentId, line });
  stateChanged();
});
registerChatEventBroadcaster((agentId, ev) => {
  emit("host", { agentId, ev });
  if (ev.kind === "running") stateChanged();
});
setChatTurnEmitter(() => {
  emit("turn", {});
  stateChanged();
});
onShipLogWrite((ship) => emit("ship", ship));
startHostReaper();
void startChatTargetRefresh(() => emit("rail", {})).then(() => startChatBridge());

process.on("unhandledRejection", (reason) => console.error("[node] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[node] uncaughtException:", err));

async function shutdown(signal: string): Promise<void> {
  await dashLog("node", `${signal}: stopping ${hostIds().length} agent(s)`);
  await Promise.all(hostIds().map((id) => stopHost(id)));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function body(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

/** An agent the node knows; a crewmate added a moment ago gets one re-read. */
async function known(agentId: string): Promise<boolean> {
  if (chatAllowed(agentId)) return true;
  await refreshAgentTargets();
  return chatAllowed(agentId);
}

function events(server: ReturnType<typeof Bun.serve>, req: Request): Response {
  server.timeout(req, 0);
  let ctrl: Sub | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      subs.add(c);
      c.enqueue(enc.encode(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`));
      ping = setInterval(() => {
        try {
          c.enqueue(enc.encode(": ping\n\n"));
        } catch {
          subs.delete(c);
          if (ping) clearInterval(ping);
        }
      }, 15_000);
    },
    cancel() {
      if (ping) clearInterval(ping);
      if (ctrl) subs.delete(ctrl);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

async function crewApi(req: Request, shipId: string, what: string, num: string | undefined): Promise<Response> {
  // The caller is whoever holds the token its live process was given; a name
  // in the request ("from") is never trusted.
  const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
  if (!from) return Response.json({ ok: false, message: "Crew calls come from a crewmate's live session." }, { status: 403 });
  let res: { ok: boolean; message: string };
  if (what === "status" && req.method === "GET") {
    res = await voyageStatus(shipId, from);
  } else if (req.method === "POST") {
    const b = await body(req);
    if (what === "tasks" && num) res = await crewUpdateTask(shipId, Number(num), { ...b, from } as never);
    else if (what === "tasks") res = await crewAddTask(shipId, { ...b, from } as never);
    else if (what === "message") res = await crewMessage(shipId, { ...b, from } as never);
    else if (what === "maneuvers") res = await crewStartManeuver(shipId, { ...b, from } as never);
    else res = { ok: false, message: "unknown crew call" };
    emit("ship", shipId);
  } else {
    return new Response("method not allowed", { status: 405 });
  }
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

async function fleetApi(req: Request, what: string, q: URLSearchParams): Promise<Response> {
  const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
  if (!fleetCallerAllowed(from)) return Response.json({ ok: false, message: "Fleet calls come from an officer's live session." }, { status: 403 });
  const ship = q.get("ship") ?? "";
  let res: { ok: boolean; message: string };
  if (req.method === "GET" && what === "status") res = await fleetStatus();
  else if (req.method === "GET" && what === "log") res = shipLog(ship, Number(q.get("limit")) || 40, q.get("kind") || undefined);
  else if (req.method === "GET" && what === "tasks") res = await shipTasks(ship);
  else if (req.method === "GET" && what === "maneuvers") res = await shipManeuvers(ship);
  else if (req.method === "GET" && what === "chat") res = await agentChatRead(q.get("agent") ?? "", Number(q.get("n")) || 12);
  else if (req.method === "POST" && what === "chat") {
    const b = await body(req);
    res = await fleetChat(from, String(b.to ?? ""), String(b.text ?? ""));
  } else return Response.json({ ok: false, message: "unknown fleet call" }, { status: 404 });
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

async function handle(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  const fleet = path.match(/^\/api\/fleet\/(status|log|tasks|maneuvers|chat)$/);
  if (fleet) return fleetApi(req, fleet[1]!, url.searchParams);

  const crew = path.match(/^\/api\/crew\/([a-z][a-z0-9_-]{0,40})\/(status|tasks|message|maneuvers)(?:\/(\d+))?$/);
  if (crew) return crewApi(req, crew[1]!, crew[2]!, crew[3]);

  if (!path.startsWith("/v1/")) return new Response("not found", { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  if (!tokenMatches(auth.replace(/^Bearer\s+/i, ""), token)) return new Response("unauthorized", { status: 401 });

  if (path === "/v1/health") return Response.json({ api: NODE_API, pid: process.pid, startedAt, root: ROOT });
  if (path === "/v1/state") return Response.json(snapshot());
  if (path === "/v1/events" && req.method === "GET") return events(server, req);
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const b = await body(req);
  const agentId = String(b.agentId ?? "");
  if (path === "/v1/refresh-targets") {
    await refreshAgentTargets();
    return Response.json({ ok: true });
  }
  if (!(await known(agentId))) return Response.json({ ok: false, error: `${agentId || "That agent"} is not on the rail.` }, { status: 404 });

  if (path === "/v1/captain-line") {
    const line = b.line as ChatLine | undefined;
    if (!line?.ts || typeof line.text !== "string") return Response.json({ ok: false, error: "bad line" }, { status: 400 });
    await acceptCaptainLine(agentId, line);
    stateChanged();
    return Response.json({ ok: true });
  }
  if (path === "/v1/answer") {
    const r = await answerDialog(agentId, String(b.dialogId ?? ""), {
      value: typeof b.value === "string" ? b.value.slice(0, 4000) : undefined,
      confirmed: typeof b.confirmed === "boolean" ? b.confirmed : undefined,
      cancelled: b.cancelled === true,
    });
    stateChanged();
    return Response.json(r, { status: r.ok ? 200 : 409 });
  }
  if (path === "/v1/abort") {
    if (chatTarget(agentId)?.runtime !== "rpc") return Response.json({ ok: false, message: "not a live agent" }, { status: 404 });
    return Response.json({ ok: await abortHost(agentId) });
  }
  if (path === "/v1/stop") {
    await stopHost(agentId);
    stateChanged();
    return Response.json({ ok: true });
  }
  if (path === "/v1/new-session") return Response.json(await newSession(agentId));
  return new Response("not found", { status: 404 });
}

const server = Bun.serve({
  hostname: HOST,
  port: NODE_PORT,
  idleTimeout: 0,
  async fetch(req, srv) {
    // Browsers never talk to the node: a page in the captain's browser could
    // otherwise reach loopback. Only local processes holding a token get in.
    if (req.headers.get("origin") || requestRefusal(req, NODE_PORT)) return new Response("forbidden", { status: 403 });
    try {
      return await handle(req, srv);
    } catch (e) {
      console.error("[node] request error:", e);
      return new Response("internal error", { status: 500 });
    }
  },
});

writeFileSync(join(nodeStateDir(), "node.json"), JSON.stringify({ pid: process.pid, port: NODE_PORT, startedAt, api: NODE_API }) + "\n");
void dashLog("node", `fleet node http://${HOST}:${NODE_PORT} pid=${process.pid} (repo ${ROOT})`);

export default server;
