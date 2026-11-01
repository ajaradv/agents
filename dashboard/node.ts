import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptCaptainLine,
  acceptCrewLine,
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
import { busPost, busRead } from "./lib/bus-api.ts";
import { cursorAtEnd, decodeCursor, encodeCursor, eventsAfter, sseFrame, streamShips } from "./lib/ship-stream.ts";
import { crewAddTask, crewCanvas, crewDockRequest, crewQueueRequest, crewHelper, crewLook, crewMessage, crewRequestRole, crewStartManeuver, crewUpdateTask, voyageStatus } from "./lib/crew-api.ts";
import { recoverManeuvers } from "./lib/crew-api.ts";
import { architectGitRead, gitRead } from "./lib/git-read.ts";
import { planCheck } from "./lib/plan-check.ts";
import { hasHelmsman, helmDigest, helmPropose } from "./lib/helm.ts";
import { handleIngest } from "./lib/ingest.ts";
import { backupDrillJob, backupsJob } from "./lib/backups.ts";
import { exeIdleJob, refreshGoldens } from "./lib/exe-pool.ts";
import { startRoutines, type Routine } from "./lib/routines.ts";
import { budgetRefusal, findShip } from "./lib/shipyard.ts";
import { materializeAllShips } from "./lib/ship-config.ts";
import { freeRegistryAge, refreshFreeModels } from "./lib/free-models.ts";
import { readShips } from "./lib/fleet-layers.ts";
import { SYNC_MS, syncRemoteMemory } from "./lib/memory-sync.ts";
import { approveProposal, dismissProposal } from "./lib/memory-queue.ts";
import { answerProposal, proactiveReport, runSweep } from "./lib/proactive.ts";
import { addQueueItem } from "./lib/decision-queue.ts";
import { designReview, specSubmit } from "./lib/decisions.ts";
import { agentChatRead, decideGo, fleetCallerAllowed, fleetChat, fleetStatus, onFleetChange, requestGo, runFleetAction, shipLog, shipManeuvers, shipTasks, recoverGos, needsChanged } from "./lib/fleet-api.ts";
import { startEventRouter } from "./lib/event-router.ts";
import { recoverDelegations, startDelegation } from "./lib/delegate.ts";
import { recoverSurveys, startReview } from "./lib/survey.ts";
import { askPublic } from "./lib/public-helper.ts";
import { toolText, VIEWS } from "./lib/tool-out.ts";
import { shipNext } from "./lib/roadmap.ts";
import { dueTasks, VAULT_FILTERS, vaultNextReport, vaultTasksReport, type VaultFilter } from "./lib/vault-tasks.ts";
import { doctorReport, scheduledVaultCheck } from "./lib/vault-doctor.ts";
import { fleetQuery } from "./lib/fleet-query.ts";
import { vaultNote } from "./lib/vault-note.ts";
import { vaultPatch } from "./lib/vault-patch.ts";
import { factGet, factSet, listObservations, logObservation } from "./lib/facts.ts";
import { remember } from "./lib/remember.ts";
import { writeSessionFacts } from "./lib/session-brief.ts";
import { startMemoryExtract } from "./lib/memory-extract.ts";
import { indexVault, searchVault, startVaultIndexer } from "./lib/vault-index.ts";
import { decideGate, judgeCall, recordLocalStop, screenResult } from "./lib/tool-gate.ts";
import { adviseCompaction, cutPoint } from "./lib/compaction-advisor.ts";
import { askAboutFiles } from "./lib/cheap-reads.ts";
import { dashLog } from "./lib/log.ts";
import { spawnTimed } from "./lib/proc.ts";
import { recall, startRecallIndexer } from "./lib/recall.ts";
import { backfillMetrics } from "./lib/metrics-backfill.ts";
import { notifyCaptain, onNoticesChange, startDigestClock, type NoticeKind } from "./lib/notify.ts";
import { captainWrote, checkOrderCall, kickOrders, orderFinish, orderStep, recordOrderCall, startOrderWatcher } from "./lib/orders.ts";
import { nodeToken, tokenMatches } from "./lib/node-auth.ts";
import { NODE_CODE_VERSION } from "./lib/node-version.ts";
import type { NodeAgentState, NodeState } from "./lib/node-client.ts";
import { HOST, NODE_PORT, nodeStateDir, ROOT } from "./lib/paths.ts";
import { requestRefusal } from "./lib/request-guard.ts";
import { logShipEvent, onShipLogWrite } from "./lib/ship-log.ts";
import { runCheck } from "./lib/ship-checks.ts";
import { recordToolFailure } from "./lib/tool-failures.ts";
import { newSession } from "./lib/session-rotate.ts";
import { OFFICER_SHIP } from "./lib/ship-events.ts";

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
 *   GET  /v1/ship-events     SSE: every ship's log, resumable (Last-Event-ID); docs/state-api.md
 *   POST /v1/survey         { mode, path, writer, ship?, depth?, lenses? }  a review the captain asks for (bin/survey)
 *   POST /v1/captain-line    { agentId, line }   a saved captain or crew line to run
 *   POST /v1/answer          { agentId, dialogId, value?, confirmed?, cancelled? }
 *   POST /v1/abort|stop|new-session  { agentId }
 *   POST /v1/refresh-targets after crew changes
 *   POST /v1/ingest          { source, events }  what a worker recorded offline; node token or a worker's ingest token (docs/metrics.md)
 * Crew API (extensions/crew.ts, crew token): /api/crew/<ship>/<status|tasks|message|maneuvers|check|git|fleet-query|vm|helm|look|helper|canvas|...>
 * Bus API (extensions/bus.ts, any agent's token): POST /api/bus/post, GET /api/bus/read
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
  return { api: NODE_API, pid: process.pid, startedAt, version: NODE_CODE_VERSION, agents };
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
function startStateLoop(): void {
  setInterval(stateChanged, 1000);
}

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
/**
 * Everything that works in the background (agent reaper, chat bridge, order
 * watcher, event router, recovery, digest clock) starts only once this node
 * owns the port. Two nodes running the background work at once would double
 * every wake, order, and digest.
 */
function startRuntime(): void {
  startStateLoop();
  startHostReaper();
  void startChatTargetRefresh(() => emit("rail", {})).then(() => {
  startChatBridge();
  // Orders tell the dashboard when they change, so the fleet deck and Needs you refresh.
  startOrderWatcher(() => emit("orders", {}));
  // Bus lines wake their owner (Firstmate through its TUI, live agents through their thread).
  startEventRouter();
  // The journal: finish Go decisions and re-attach maneuvers a restart interrupted (orders resume in the watcher).
  void recoverGos().catch((e) => console.error("[node] go recovery:", e));
  void recoverManeuvers().catch((e) => console.error("[node] maneuver recovery:", e));
  void recoverDelegations().catch((e) => console.error("[node] delegation recovery:", e));
  void recoverSurveys().catch((e) => console.error("[node] survey recovery:", e));
  // Captain notices: interruptions go to Needs you at once; the rest waits for the morning digest.
  onNoticesChange(() => emit("go", {}));
  startDigestClock();
  // recall: keep the full-text index of chats, helper results, digests, and notices current.
  startRecallIndexer();
  startVaultIndexer();
  startMemoryExtract();
  // Ship config (lib/ship-config.ts): the merged view of every ship, as JSON for bin/launch.
  void readShips().then((ships) => materializeAllShips(ships.map((s) => s.id))).catch((e) => console.error("[node] ship config:", e));
  // Routines (lib/routines.ts, fleet/config/routines.yaml): the jobs below and agent routines, on their schedules.
  // Free model lanes (lib/free-models.ts): refresh the registry when it is a day old.
  const freeRefresh = async (): Promise<string> => {
    const age = freeRegistryAge();
    if (age && Date.now() - Date.parse(age) < 20 * 3_600_000) return "registry is fresh";
    const n = await refreshFreeModels();
    return n ? `refreshed: ${JSON.stringify(n).slice(0, 200)}` : "refreshed";
  };
  // Vault doctor (lib/vault-doctor.ts): check the vault soon after start and every 6 hours; a notice only for new problems.
  const vaultCheck = (): string => {
    const { result, fresh } = scheduledVaultCheck();
    if (fresh.length) {
      notifyCaptain({ from: "vault-doctor", kind: "info", summary: `Vault doctor: ${fresh.length} new problem${fresh.length > 1 ? "s" : ""} (${result.problems.length} in all)`, detail: fresh.slice(0, 8).map((p) => `${p.note}: ${p.detail}`).join("\n"), ref: "health/diagnostics" });
    }
    return `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}${fresh.length ? `, ${fresh.length} new` : ""}`;
  };
  // Due vault tasks (lib/vault-tasks.ts): a notice the day a task with a due: date comes due, once per task and date.
  const dueCheck = (): string => {
    {
      const file = join(nodeStateDir(), "due-reminded.json");
      let sent: string[] = [];
      try {
        sent = JSON.parse(readFileSync(file, "utf8")) as string[];
      } catch {
        /* first run */
      }
      const today = new Date().toLocaleDateString("en-CA");
      const fresh = dueTasks(today).filter((t) => !sent.includes(`${t.id}@${t.due}`));
      for (const t of fresh) {
        notifyCaptain({ from: "vault", kind: "decision", summary: `Due ${t.due === today ? "today" : `since ${t.due}`}: ${t.title}`, detail: `${t.description}\n\nVault task tasks/${t.id}.md`, ref: `tasks/${t.id}.md` });
        sent.push(`${t.id}@${t.due}`);
      }
      if (fresh.length) writeFileSync(file, JSON.stringify(sent.slice(-500)), "utf8");
      return fresh.length ? `${fresh.length} reminder${fresh.length > 1 ? "s" : ""} sent` : "nothing due";
    }
  };
  // Helm review (lib/helm.ts): the ship's helmsman gets the review digest as a crew message, and a turn.
  const helmReview = async (r: Routine): Promise<string> => {
    const ship = r.ship ? await findShip(r.ship) : undefined;
    if (!ship) throw new Error(`no ship named ${r.ship ?? "(none)"}`);
    if (!hasHelmsman(ship)) return `skipped: ${ship.id} has no helmsman aboard`;
    await acceptCrewLine(`${ship.id}-helmsman`, "helm", helmDigest(ship, `scheduled review (${r.every})`).slice(0, 8000));
    return `review sent to ${ship.id}-helmsman; proposals appear in Needs you`;
  };
  // Code graphs (CodeGraph): keep each indexed ship repo current. Only repos that already have
  // .codegraph/ are synced; indexing a repo is the captain's decision.
  // Old agent sessions gzipped out of the way (lib/session-archive.ts); week-old screenshots deleted (lib/shots.ts); month-old canvas archives (lib/canvas-archive.ts).
  const sessionArchive = async (): Promise<string> => {
    const { archiveSessions } = await import("./lib/session-archive.ts");
    const { clearShots, SWEEP_DAYS } = await import("./lib/shots.ts");
    const { KEEP_DAYS, pruneCanvasArchive } = await import("./lib/canvas-archive.ts");
    const r = archiveSessions();
    const shots = clearShots(SWEEP_DAYS);
    const canvases = pruneCanvasArchive();
    const swept = (shots.files ? `; ${shots.files} screenshot(s) older than ${SWEEP_DAYS} days deleted` : "") + (canvases ? `; ${canvases} canvas archive(s) older than ${KEEP_DAYS} days deleted` : "");
    return (r.files ? `archived ${r.files} old session(s) (${(r.savedBytes / 1e6).toFixed(0)} MB saved): ${r.agents.join(", ")}` : "no old sessions to archive") + swept;
  };
  const codegraphSync = async (): Promise<string> => {
    const synced: string[] = [];
    for (const ship of await readShips()) {
      if (!existsSync(join(ship.path, ".codegraph"))) continue;
      const r = await spawnTimed(["codegraph", "sync", ship.path], { timeoutMs: 600_000, cwd: ship.path });
      synced.push(`${ship.id}${r.exitCode === 0 ? "" : " (failed)"}`);
    }
    return synced.length ? `synced ${synced.join(", ")}` : "skipped: no ship repo has a code graph yet";
  };
  // exe.dev pool (lib/exe-pool.ts): pause a quiet voyage VM; refresh the paused golden VMs at night.
  const exeIdle = exeIdleJob();
  const goldenRefresh = () => refreshGoldens();
  startRoutines({
    jobs: { backups: backupsJob(), "backup-drill": backupDrillJob(), "exe-idle": exeIdle, "golden-refresh": goldenRefresh, "vault-doctor": vaultCheck, "free-models": freeRefresh, "due-tasks": dueCheck, proactive: () => runSweep(acceptCrewLine), "helm-review": helmReview, "codegraph-sync": codegraphSync, "session-archive": sessionArchive },
    runAgent: async (agentId, text) => void (await acceptCrewLine(agentId, "routine", text)),
    agentExists: (agentId) => allChatTargetIds().includes(agentId),
    budgetRefusal: (ship, agentId) => budgetRefusal(ship, agentId),
  });
  // S3d (lib/memory-sync.ts): mirror the crew memory of voyages sailing on another host, so the deck is current.
  let mirroring = false;
  setInterval(() => {
    if (mirroring) return;
    mirroring = true;
    void readShips()
      .then((ships) => syncRemoteMemory(ships))
      .then((changed) => changed.forEach((id) => emit("ship", id)))
      .catch((e) => console.error("[node] memory sync:", e))
      .finally(() => (mirroring = false));
  }, SYNC_MS);
  // Fleet metrics (lib/metrics.ts): import history from ship logs and voyage notes once.
  setTimeout(() => {
    try {
      const n = backfillMetrics();
      if (n) console.error(`[node] metrics backfill: ${JSON.stringify(n)}`);
    } catch (e) {
      console.error("[node] metrics backfill:", e);
    }
  }, 3000);
  onFleetChange((what) => (what === "rail" ? emit("rail", {}) : what === "ship" ? emit("ship", "") : emit("go", {})));
  });
}

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

/**
 * GET /v1/ship-events: every ship's log as one stream (lib/ship-stream.ts), new
 * events by default, from the start with ?from=start, resumed from Last-Event-ID
 * (or ?after=<cursor>); ?ships=a,b narrows it. Polled once a second: other
 * processes (the dashboard) write ship logs too.
 */
async function shipEvents(server: ReturnType<typeof Bun.serve>, req: Request, url: URL): Promise<Response> {
  server.timeout(req, 0);
  const only = (url.searchParams.get("ships") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ships = await streamShips(only);
  const resume = req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "";
  let cursor = resume ? decodeCursor(resume) : url.searchParams.get("from") === "start" ? {} : cursorAtEnd(ships);
  let tick: ReturnType<typeof setInterval> | null = null;
  let quiet = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(`event: ready\ndata: ${JSON.stringify({ ships, cursor: encodeCursor(cursor) })}\n\n`));
      tick = setInterval(() => {
        try {
          const { events } = eventsAfter(cursor, ships);
          for (const e of events) {
            cursor = { ...cursor, [e.ship]: e.id };
            c.enqueue(enc.encode(sseFrame(e, cursor)));
          }
          if (events.length) quiet = 0;
          else if (++quiet >= 15) {
            quiet = 0;
            c.enqueue(enc.encode(": ping\n\n"));
          }
        } catch {
          if (tick) clearInterval(tick);
        }
      }, 1000);
    },
    cancel() {
      if (tick) clearInterval(tick);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** A crewmate's VM started, stopped, failed, or blocked a request (extensions/gondolin). */
function crewVmEvent(shipId: string, from: string, event: string, detail: string): { ok: boolean; message: string } {
  if (!["start", "stop", "blocked", "error"].includes(event)) return { ok: false, message: "unknown vm event" };
  const say = { start: "VM started", stop: "VM stopped", blocked: "VM blocked a request to", error: "VM did not start:" }[event as "start"];
  logShipEvent(shipId, from, "vm", `${say} ${detail}`.trim(), { event, detail });
  if (event === "blocked" || event === "error") recordToolFailure({ agent: from, tool: event === "blocked" ? "network" : "vm", args: event === "blocked" ? detail : "", error: event === "blocked" ? `blocked by the ship's allowlist: ${detail}` : detail });
  return { ok: true, message: "noted" };
}

async function crewApi(req: Request, shipId: string, what: string, num: string | undefined): Promise<Response> {
  // The caller is whoever holds the token its live process was given; a name
  // in the request ("from") is never trusted.
  const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
  if (!from) return Response.json({ ok: false, message: "Crew calls come from a crewmate's live session." }, { status: 403 });
  let res: { ok: boolean; message: string; [k: string]: unknown };
  if (what === "status" && req.method === "GET") {
    res = await voyageStatus(shipId, from);
    res = { ...res, text: toolText(res, VIEWS.voyage_status, { full: new URL(req.url).searchParams.get("full") === "true" }) };
  } else if (what === "fleet-query" && req.method === "GET") {
    // The helmsman's numbers (fleet_query in extensions/crew.ts): the officers' read, for the one role that reviews with data.
    if (from !== `${shipId}-helmsman`) return Response.json({ ok: false, message: "fleet_query aboard a ship is the helmsman's." }, { status: 403 });
    const q = new URL(req.url).searchParams;
    const full = q.get("full") === "true";
    res = fleetQuery(q.get("query") ?? "", { days: Number(q.get("days")) || undefined, by: q.get("by") ?? undefined, since: q.get("since") ?? undefined, until: q.get("until") ?? undefined, limit: Number(q.get("limit")) || undefined, full });
    res = { ...res, text: toolText(res, VIEWS.fleet_query, { full }) };
  } else if (req.method === "POST") {
    const b = await body(req);
    if (what === "tasks" && num) res = await crewUpdateTask(shipId, Number(num), { ...b, from } as never);
    else if (what === "tasks") res = await crewAddTask(shipId, { ...b, from } as never);
    else if (what === "message") res = await crewMessage(shipId, { ...b, from } as never);
    else if (what === "crew-request") res = await crewRequestRole(shipId, { ...b, from } as never);
    else if (what === "dock-request") res = await crewDockRequest(shipId, { ...b, from } as never);
    else if (what === "queue-request") res = await crewQueueRequest(shipId, { ...b, from } as never);
    else if (what === "look") res = await crewLook(shipId, { ...b, from } as never);
    else if (what === "helper") res = await crewHelper(shipId, { ...b, from });
    else if (what === "canvas") res = await crewCanvas(shipId, { ...b, from });
    else if (what === "maneuvers") res = await crewStartManeuver(shipId, { ...b, from } as never);
    else if (what === "check") res = await runCheck(shipId, from, String(b.name ?? ""));
    else if (what === "git") res = await gitRead(shipId, from, b);
    else if (what === "helm") res = await helmPropose(shipId, from, b as Record<string, unknown>);
    else if (what === "vm") res = crewVmEvent(shipId, from, String(b.event ?? ""), String(b.detail ?? ""));
    else res = { ok: false, message: "unknown crew call" };
    emit("ship", shipId);
  } else {
    return new Response("method not allowed", { status: 405 });
  }
  return Response.json(res, { status: res.ok ? 200 : 400 });
}

/** Route → the order tool it is, with the arguments exactly as the caller sent them. */
function fleetCall(what: string, method: string, q: URLSearchParams, b: Record<string, unknown>): { tool: string; read: boolean; args: Record<string, string> } | null {
  const pick = (src: (k: string) => unknown, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, src(k)]).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)]));
  const fromQ = (keys: string[]) => pick((k) => q.get(k), keys);
  if (method === "GET" && what === "status") return { tool: "fleet_status", read: true, args: fromQ(["detail"]) };
  if (method === "GET" && what === "log") return { tool: "ship_log", read: true, args: fromQ(["ship", "limit", "kind"]) };
  if (method === "GET" && what === "tasks") return { tool: "ship_tasks", read: true, args: fromQ(["ship"]) };
  if (method === "GET" && what === "maneuvers") return { tool: "ship_maneuvers", read: true, args: fromQ(["ship"]) };
  if (method === "GET" && what === "chat") return { tool: "agent_chat_read", read: true, args: fromQ(["agent", "n"]) };
  if (method === "GET" && what === "recall") return { tool: "recall", read: true, args: fromQ(["query", "limit"]) };
  if (method === "GET" && what === "vault-tasks") return { tool: "vault_tasks", read: true, args: fromQ(["filter", "id"]) };
  if (method === "GET" && what === "ship-next") return { tool: "ship_next", read: true, args: fromQ(["ship"]) };
  if (method === "GET" && what === "fleet-query") return { tool: "fleet_query", read: true, args: fromQ(["query", "days", "by", "since", "until", "limit"]) };
  if (method === "GET" && what === "vault-note") return { tool: "vault_note", read: true, args: fromQ(["path", "section", "full"]) };
  if (method === "GET" && what === "vault-search") return { tool: "vault_search", read: true, args: fromQ(["query", "type", "status", "ship", "path", "limit"]) };
  if (method === "GET" && what === "vault-doctor") return { tool: "vault_doctor", read: true, args: {} };
  if (method === "GET" && what === "fact-get") return { tool: "fact_get", read: true, args: fromQ(["subject", "key", "history", "observations", "limit"]) };
  // Writes: held back while an order runs, like fleet_chat. The edit itself is the tier 1 vault filing Alice's authority names.
  if (method === "POST" && what === "vault-doctor") return { tool: "vault_doctor", read: false, args: pick((k) => b[k], ["fix"]) };
  if (method === "POST" && what === "vault-patch") return { tool: "vault_patch", read: false, args: { ...pick((k) => b[k], ["path", "check", "uncheck"]), ...(b.set ? { set: JSON.stringify(b.set) } : {}) } };
  // Alice's memory (lib/facts.ts, lib/remember.ts): facts and observations in journal.db, the captain's profile in the vault.
  if (method === "POST" && what === "fact-set") return { tool: "fact_set", read: false, args: pick((k) => b[k], ["subject", "key", "value", "source", "retire", "observation"]) };
  if (method === "POST" && what === "remember") return { tool: "remember", read: false, args: pick((k) => b[k], ["section", "line", "replaces", "create", "observation"]) };
  if (method === "POST" && what === "log-observation") return { tool: "log_observation", read: false, args: pick((k) => b[k], ["text", "subject", "ttl_days"]) };
  // Alice's proactive proposals (lib/proactive.ts): they show in Needs you, so a write like the others.
  if (method === "POST" && what === "proactive-report") return { tool: "proactive_report", read: false, args: { items: JSON.stringify(b.items ?? []), dropped: JSON.stringify(b.dropped ?? []) } };
  if (method === "POST" && what === "chat") return { tool: "fleet_chat", read: false, args: pick((k) => b[k], ["to", "text"]) };
  return null;
}

async function fleetApi(req: Request, what: string, q: URLSearchParams): Promise<Response> {
  const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
  if (!fleetCallerAllowed(from)) return Response.json({ ok: false, message: "Fleet calls come from an officer's live session." }, { status: 403 });
  const b = req.method === "POST" ? await body(req) : {};
  const reply = (res: { ok: boolean; message: string }) => Response.json(res, { status: res.ok ? 200 : 400 });

  if (what === "order-step" && req.method === "POST") {
    return reply(await orderStep(String(b.order ?? ""), Number(b.step), b.ok === true, String(b.result ?? ""), String(b.evidence ?? "")));
  }
  if (what === "order-finish" && req.method === "POST") {
    return reply(await orderFinish(String(b.order ?? ""), b.status === "done" ? "done" : "blocked", String(b.why ?? "")));
  }

  if (what === "delegate" && req.method === "POST") {
    return reply(await startDelegation(from, String(b.task ?? ""), String(b.where ?? "vault")));
  }

  if (what === "public" && req.method === "POST") {
    return reply(await askPublic(from, String(b.question ?? ""), String(b.text ?? "")));
  }

  if (what === "queue" && req.method === "POST") {
    // The captain's decision queue (lib/decision-queue.ts): a request, not an action; the captain starts it.
    const r = addQueueItem({ kind: String(b.kind ?? ""), ship: String(b.ship ?? ""), title: String(b.title ?? ""), request: String(b.request ?? ""), by: from });
    if (r.ok) emit("ship", OFFICER_SHIP);
    return reply(r.ok ? { ok: true, message: `Queued for the captain: ${r.item.title} (${r.item.kind} on ${r.item.ship}). It shows on the flagship's Decision queue; the captain starts it.` } : r);
  }

  if (what === "notify" && req.method === "POST") {
    // Communication, not a fleet action: allowed during an order too.
    const n = notifyCaptain({ from, kind: String(b.kind ?? "info") as NoticeKind, summary: String(b.summary ?? "").trim(), detail: String(b.detail ?? ""), ref: String(b.ref ?? "") });
    if (!n.summary) return reply({ ok: false, message: "Give the notice a summary." });
    const where = n.delivery === "interrupt" ? "shown to the captain now" : n.delivery === "held" ? "held: the captain is snoozed; it shows when they wake" : "saved for the morning digest";
    return reply({ ok: true, message: `Notice ${n.id} (${n.kind}) ${where}. Do not repeat it in chat.` });
  }

  if (what === "action" && req.method === "POST") {
    // Tier 2: inside an approved order it runs as that step; otherwise it waits for the captain's Go.
    const tool = String(b.tool ?? "");
    const raw = (b.args ?? {}) as Record<string, unknown>;
    const args = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
    const ctx = { order: String(b.order ?? "") || undefined, step: Number(b.step) || undefined };
    const gate = await checkOrderCall(tool, args, false, ctx);
    if (!gate.ok) return reply({ ok: false, message: gate.message });
    if (!gate.step) return reply(await requestGo(from, tool, args));
    const res = await runFleetAction(tool, args);
    recordOrderCall(gate.step, tool, args, res.message);
    return reply({ ...res, message: `${res.message} (Step ${gate.step} call recorded; now check its expect line and call order_step.)` });
  }

  const call = fleetCall(what, req.method, q, b);
  if (!call) return Response.json({ ok: false, message: "unknown fleet call" }, { status: 404 });
  // While an order runs, calls that are part of it must be its current step, literally (lib/orders.ts).
  const ctx = { order: String(q.get("order") ?? b.order ?? "") || undefined, step: Number(q.get("step") ?? b.step) || undefined };
  const gate = await checkOrderCall(call.tool, call.args, call.read, ctx);
  if (!gate.ok) return reply({ ok: false, message: gate.message });

  const a = call.args;
  let res: { ok: boolean; message: string; [k: string]: unknown };
  if (call.tool === "fleet_status") res = await fleetStatus(a.detail === "true");
  else if (call.tool === "ship_log") res = shipLog(a.ship ?? "", Number(a.limit) || 40, a.kind || undefined);
  else if (call.tool === "ship_tasks") res = await shipTasks(a.ship ?? "");
  else if (call.tool === "ship_maneuvers") res = await shipManeuvers(a.ship ?? "");
  else if (call.tool === "agent_chat_read") res = await agentChatRead(a.agent ?? "", Number(a.n) || 12);
  else if (call.tool === "fleet_query") res = fleetQuery(a.query ?? "", { days: Number(a.days) || undefined, by: a.by, since: a.since, until: a.until, limit: Number(a.limit) || undefined, full: q.get("full") === "true" });
  else if (call.tool === "vault_note") res = vaultNote(a.path ?? "", { section: a.section, full: a.full === "true" });
  else if (call.tool === "vault_search") res = searchVault({ query: a.query, type: a.type, status: a.status, ship: a.ship, path: a.path, limit: Number(a.limit) || undefined });
  else if (call.tool === "vault_doctor") res = doctorReport(a.fix === "true");
  else if (call.tool === "vault_patch") {
    res = vaultPatch({ path: a.path ?? "", set: b.set as Record<string, unknown> | undefined, check: a.check, uncheck: a.uncheck });
    if (res.ok && res.changed) indexVault(); // so vault_search sees the edit at once
  }
  else if (call.tool === "fact_get") res = a.observations === "true" ? listObservations({ subject: a.subject, limit: Number(a.limit) || undefined }) : factGet({ subject: a.subject, key: a.key, history: a.history === "true", limit: Number(a.limit) || undefined });
  else if (call.tool === "fact_set") {
    res = factSet({ subject: a.subject, key: a.key, value: a.value, source: a.source, retire: String(a.retire) === "true", by: from, observation: a.observation ? Number(a.observation) : undefined });
    if (res.ok) writeSessionFacts(); // her next session starts with it
  }
  else if (call.tool === "remember") res = remember({ section: a.section ?? "", line: a.line ?? "", replaces: a.replaces, create: a.create === "true", observation: a.observation ? Number(a.observation) : undefined });
  else if (call.tool === "proactive_report") {
    const list = (v: string | undefined) => {
      try {
        const x = JSON.parse(v ?? "[]");
        return Array.isArray(x) ? x : [];
      } catch {
        return [];
      }
    };
    res = proactiveReport(list(a.items), list(a.dropped));
    if (res.ok) needsChanged();
  }
  else if (call.tool === "log_observation") res = logObservation({ text: a.text, subject: a.subject, ttlDays: Number(a.ttl_days) || undefined, by: from });
  else if (call.tool === "vault_tasks" && a.filter === "next") res = vaultNextReport(a.id ?? "");
  else if (call.tool === "vault_tasks") res = vaultTasksReport((VAULT_FILTERS as string[]).includes(a.filter ?? "") ? (a.filter as VaultFilter) : "ready", a.id ?? "");
  else if (call.tool === "ship_next") res = await shipNext(a.ship ?? "", q.get("full") === "true");
  else if (call.tool === "recall") {
    const hits = recall(a.query ?? "", Number(a.limit) || 8);
    res = { ok: true, message: hits.length ? `${hits.length} match(es), best first.` : "No matches. Try other words, or delegate a deeper search.", hits };
  }
  else res = await fleetChat(from, a.to ?? "", a.text ?? "");
  if (gate.step) {
    recordOrderCall(gate.step, call.tool, call.args, res.message);
    res = { ...res, message: `${res.message} (Step ${gate.step} call recorded; now check its expect line and call order_step.)` };
  }
  // Read tools: what the agent sees (lib/tool-out); the JSON stays for anything else that reads it.
  const view = call.tool === "vault_tasks" && a.filter === "next" ? "vault_next" : call.tool;
  if (call.read && VIEWS[view]) res = { ...res, text: toolText(res, VIEWS[view], { full: q.get("full") === "true" && call.tool !== "vault_note" }) };
  // vault_doctor fix=true is a write, but its report is a view like the read.
  if (call.tool === "vault_doctor" && !call.read) res = { ...res, text: toolText(res, VIEWS.vault_doctor) };
  return reply(res);
}

async function handle(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // The tool gate's second layer (lib/tool-gate.ts): any live agent may ask, by its token.
  if (path === "/api/gate/stopped" && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ ok: false }, { status: 403 });
    const b = await body(req);
    const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
    recordLocalStop({ agent: from, tool: String(b.tool ?? ""), input, cwd: String(b.cwd ?? ""), why: String(b.why ?? "").slice(0, 200) });
    return Response.json({ ok: true });
  }
  // Cheap reads (an experiment, lib/cheap-reads.ts): answers about files instead of the files.
  if (path === "/api/jev/files" && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ error: "calls come from a live agent session" }, { status: 403 });
    const b = await body(req);
    const files = Array.isArray(b.files) ? (b.files as { path?: unknown; content?: unknown }[]).map((f) => ({ path: String(f.path ?? ""), content: String(f.content ?? "") })) : [];
    return Response.json(await askAboutFiles((b.question ?? {}) as Record<string, unknown>, files));
  }
  // The compaction advisor (lib/compaction-advisor.ts), asked by context-guard after a settled run.
  if ((path === "/api/compaction/advise" || path === "/api/compaction/cut") && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ ok: false }, { status: 403 });
    const b = await body(req);
    if (path === "/api/compaction/cut") return Response.json({ instructions: await cutPoint(Array.isArray(b.requests) ? b.requests.map(String) : []) });
    const st = (b.state ?? {}) as Record<string, unknown>;
    const state = { current_request: String(st.current_request ?? ""), previous_work: String(st.previous_work ?? ""), recent_turn: String(st.recent_turn ?? ""), tools_this_turn: Array.isArray(st.tools_this_turn) ? st.tools_this_turn.map(String) : [] };
    return Response.json(await adviseCompaction({ agent: from, mode: String(b.mode ?? "observe"), tokens: Number(b.tokens) || 0, percent: Number(b.percent) || 0, state }));
  }
  if (path === "/api/gate/screen" && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ flagged: false }, { status: 403 });
    const b = await body(req);
    const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
    return Response.json(await screenResult({ agent: from, tool: String(b.tool ?? ""), input, text: String(b.text ?? ""), why: String(b.why ?? "").slice(0, 200) }));
  }
  if (path === "/api/gate" && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ decision: "stop", message: "Tool gate: calls come from a live agent session." }, { status: 403 });
    const b = await body(req);
    const input = b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {};
    const writable = Array.isArray(b.writable) ? b.writable.map(String).slice(0, 8) : [];
    const r = await judgeCall({ agent: from, tool: String(b.tool ?? ""), input, cwd: String(b.cwd ?? ""), why: String(b.why ?? "").slice(0, 200), writable }, undefined, { observe: b.mode === "observe" });
    if (r.decision === "hold") needsChanged();
    return Response.json(r);
  }

  // Agents' buses (lib/bus-api.ts, extensions/bus.ts): any live agent, by its token.
  const bus = path.match(/^\/api\/bus\/(post|read)$/);
  if (bus) {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ ok: false, message: "Bus calls come from a live agent session." }, { status: 403 });
    if (bus[1] === "post" && req.method === "POST") return Response.json(await busPost(from, await body(req), known));
    if (bus[1] === "read" && req.method === "GET") return Response.json(await busRead(from, url.searchParams.get("since") ?? "", Number(url.searchParams.get("limit")) || 30));
  }

  // The flagship officers' decisions (lib/decisions.ts, extensions/decisions.ts): spec_submit, design_review, survey.
  const decision = path.match(/^\/api\/decisions\/(spec|design-review|plan-check|git|survey)$/);
  if (decision && req.method === "POST") {
    const from = crewCaller(req.headers.get("x-fleet-crew-token") ?? "");
    if (!from) return Response.json({ ok: false, message: "Decision calls come from a live agent session." }, { status: 403 });
    const b = await body(req);
    if (decision[1] === "plan-check") return Response.json(from === "architect" ? planCheck(String(b.path ?? "")) : { ok: false, message: "plan_check is the architect's." });
    if (decision[1] === "git") return Response.json(await architectGitRead(from, b));
    if (decision[1] === "survey") {
      if (from !== "architect") return Response.json({ ok: false, message: "survey is the architect's." });
      return Response.json(await startReview("architect", { mode: String(b.mode ?? ""), path: String(b.path ?? ""), ship: b.ship ? String(b.ship) : undefined, depth: b.depth ? String(b.depth) : undefined, lenses: b.lenses ? String(b.lenses) : undefined }));
    }
    const r = decision[1] === "spec" ? specSubmit(from, b) : designReview(from, b);
    if (r.ok) emit("ship", OFFICER_SHIP);
    return Response.json(r);
  }

  const fleet = path.match(/^\/api\/fleet\/(status|log|tasks|maneuvers|chat|order-step|order-finish|action|notify|queue|delegate|public|recall|vault-tasks|ship-next|fleet-query|vault-note|vault-search|vault-patch|vault-doctor|fact-get|fact-set|remember|log-observation|proactive-report)$/);
  if (fleet) return fleetApi(req, fleet[1]!, url.searchParams);

  const crew = path.match(/^\/api\/crew\/([a-z][a-z0-9_-]{0,40})\/(status|tasks|message|maneuvers|check|git|fleet-query|vm|helm|look|helper|canvas|crew-request|dock-request|queue-request)(?:\/(\d+))?$/);
  if (crew) return crewApi(req, crew[1]!, crew[2]!, crew[3]);

  if (!path.startsWith("/v1/")) return new Response("not found", { status: 404 });
  // Workers' outboxes (lib/ingest.ts): the node token or the worker's own ingest token, so it checks before the token gate.
  if (path === "/v1/ingest") return handleIngest(req, { nodeToken: token });
  const auth = req.headers.get("authorization") ?? "";
  if (!tokenMatches(auth.replace(/^Bearer\s+/i, ""), token)) return new Response("unauthorized", { status: 401 });

  if (path === "/v1/health") return Response.json({ api: NODE_API, pid: process.pid, startedAt, version: NODE_CODE_VERSION, root: ROOT });
  if (path === "/v1/state") return Response.json(snapshot());
  if (path === "/v1/events" && req.method === "GET") return events(server, req);
  if (path === "/v1/ship-events" && req.method === "GET") return shipEvents(server, req, url);
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const b = await body(req);
  const agentId = String(b.agentId ?? "");
  if (path === "/v1/gate") {
    const r = await decideGate(String(b.id ?? ""), b.decision === "allow");
    needsChanged();
    return Response.json(r, { status: r.ok ? 200 : 409 });
  }
  if (path === "/v1/memory") {
    // Here, not in the dashboard: approving posts a line to Alice, and only this process hosts her.
    const id = Number(b.id);
    const opts = typeof b.label === "string" ? { label: b.label } : {};
    const r = b.action === "approve" ? await approveProposal(id, opts) : b.action === "dismiss" ? dismissProposal(id, opts) : { ok: false, message: "action must be approve or dismiss" };
    needsChanged();
    return Response.json(r, { status: r.ok ? 200 : 409 });
  }
  if (path === "/v1/proactive") {
    // Here too: Go posts a line to Alice.
    const action = b.action === "go" || b.action === "snooze" || b.action === "done" ? b.action : null;
    const r = action ? await answerProposal(Number(b.id), action) : { ok: false, message: "action must be go, snooze or done" };
    needsChanged();
    return Response.json(r, { status: r.ok ? 200 : 409 });
  }
  if (path === "/v1/go") {
    const r = await decideGo(String(b.id ?? ""), b.decision === "go");
    return Response.json(r, { status: r.ok ? 200 : 409 });
  }
  // A review the captain asks for from a shell (bin/survey): the node token proves it is the captain, so the depth is theirs.
  if (path === "/v1/survey") {
    const r = await startReview("captain", { mode: String(b.mode ?? ""), path: String(b.path ?? ""), ship: b.ship ? String(b.ship) : undefined, writer: String(b.writer ?? ""), depth: b.depth ? String(b.depth) : undefined, lenses: b.lenses ? String(b.lenses) : undefined });
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  if (path === "/v1/orders/kick") {
    await kickOrders();
    return Response.json({ ok: true });
  }
  // The dashboard's vault reader search: the node owns the index (startVaultIndexer), so the dashboard asks it.
  if (path === "/v1/vault-search") return Response.json(searchVault({ query: String(b.query ?? ""), limit: Number(b.limit) || undefined }));
  if (path === "/v1/refresh-targets") {
    await refreshAgentTargets();
    return Response.json({ ok: true });
  }
  if (!(await known(agentId))) return Response.json({ ok: false, error: `${agentId || "That agent"} is not on the rail.` }, { status: 404 });

  if (path === "/v1/captain-line") {
    const line = b.line as ChatLine | undefined;
    if (!line?.ts || typeof line.text !== "string") return Response.json({ ok: false, error: "bad line" }, { status: 400 });
    captainWrote(agentId);
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

function serve() {
  return Bun.serve({
  hostname: HOST,
  port: NODE_PORT,
  idleTimeout: 0,
  async fetch(req, srv) {
    // Browsers never talk to the node: a page in the captain's browser could
    // otherwise reach loopback. Only local processes holding a token get in.
    if (req.headers.get("origin") || requestRefusal(req, NODE_PORT, { tagged: true })) return new Response("forbidden", { status: 403 });
    try {
      return await handle(req, srv);
    } catch (e) {
      console.error("[node] request error:", e);
      return new Response("internal error", { status: 500 });
    }
  },
  });
}

/** Own the port, then start the runtime. If another node holds it, wait and retry instead of half-running. */
async function claimPort(): Promise<ReturnType<typeof Bun.serve>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return serve();
    } catch (e) {
      if (attempt === 0) await dashLog("node", `port ${NODE_PORT} is taken (${e instanceof Error ? e.message : e}); waiting for it, retrying every 10s`);
      await Bun.sleep(10_000);
    }
  }
}

const server = await claimPort();
writeFileSync(join(nodeStateDir(), "node.json"), JSON.stringify({ pid: process.pid, port: NODE_PORT, startedAt, api: NODE_API }) + "\n");
void dashLog("node", `fleet node http://${HOST}:${NODE_PORT} pid=${process.pid} (repo ${ROOT})`);
startRuntime();

export default server;
