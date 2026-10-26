import { abortHost, hostRunning, hostWaiting, stopHost } from "./agent-host.ts";
import { acceptCrewLine, FLEET_OFFICERS, postCaptainLine, postLine } from "./chat-bridge.ts";
import { readCaptainChat } from "./chat.ts";
import { chatAllowed, chatTarget, listChatTargets, refreshAgentTargets } from "./chat-targets.ts";
import { crewStartManeuver } from "./crew-api.ts";
import { describeManeuver, maneuverAvailability } from "./maneuvers.ts";
import { describeAction, holdGoRequest, tier2ArgError, type GoRequest } from "./go-gate.ts";
import { getWorkflow, journalEvent, listWorkflows, once, updateWorkflow } from "./journal.ts";
import { gateFolder } from "./gates.ts";
import { treeState } from "./ship-checks.ts";
import { voyageHost } from "./voyage-worktree.ts";
import { newSession } from "./session-rotate.ts";
import { readShips } from "./fleet-layers.ts";
import { collectCaptainHolds, lastFleetSnapshot } from "./fleet-snapshot.ts";
import { humanizeError, plainSummary } from "./humanize.ts";
import { collectNeedsYou, type NeedItem } from "./needs-you.ts";
import { OFFICER_SHIP, shipOf } from "./ship-events.ts";
import { recentShipEvents, shipTurnTotals } from "./ship-log.ts";
import { recentManeuvers } from "./ship-maneuvers.ts";
import { crewStatus } from "./ship-view.ts";
import { dockVoyage, findShip, openVoyage, setCrew, setOrchestrator, startVoyage, voyageBrief } from "./shipyard.ts";
import { listTasks, taskProgress, waitingOn, readyTasks } from "./voyage-tasks.ts";

/**
 * The fleet API for officers (extensions/fleet.ts), served by the fleet node.
 * Reads of the whole fleet, fleet_chat (messages to any agent on the rail),
 * and tier 2 fleet actions (voyages, crew, orchestrator, maneuvers, stopping
 * an agent, new sessions), which run only after the captain's Go
 * (lib/go-gate.ts) or as a step of an order the captain approved.
 *
 * The caller is the officer whose live process holds the crew token; a name
 * in the request is never trusted (same as the crew API).
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

const SHIP_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function midnightIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Who may call: an officer on the list (Alice in phase 1). */
export function fleetCallerAllowed(from: string | null): from is string {
  return Boolean(from && FLEET_OFFICERS.has(from));
}

/**
 * One "waiting on the captain" item for fleet_status. Every kind carries the
 * same id, kind and summary (the columns the tool view shows), then its own details.
 */
export function needLine(n: NeedItem): Record<string, unknown> {
  switch (n.kind) {
    case "hold":
      return { id: n.id, kind: n.kind, summary: `Task ${n.taskId} held: ${n.title} (${n.reason})`, task: n.taskId, title: n.title, reason: n.reason };
    case "go":
      return { id: n.id, kind: n.kind, summary: `${n.agentId} asks for a Go: ${n.summary}`, from: n.agentId, action: n.summary };
    case "gate":
      return { id: n.id, kind: n.kind, summary: `The tool gate held ${n.agentId}: ${n.summary} (${n.why})`, from: n.agentId, held: n.summary, why: n.why };
    case "helm":
      return { id: n.id, kind: n.kind, summary: `${n.ship} helmsman proposes ${n.what}`, ship: n.ship, proposal: n.what };
    case "question": {
      const question = n.questions.map((q) => q.question).join(" / ");
      return { id: n.id, kind: n.kind, summary: `${n.agentId} asks: ${question}`, agent: n.agentId, asked: n.ts, question };
    }
    case "notice":
      return { id: n.id, kind: n.kind, summary: `${n.from}: ${n.summary}`, from: n.from, notice: n.noticeKind };
    case "order":
      return { id: n.id, kind: n.kind, summary: `Order ${n.slug} (${n.status}): ${n.title}${n.reason ? `; ${n.reason}` : ""}`, order: n.slug, title: n.title, status: n.status, ...(n.reason ? { reason: n.reason } : {}) };
    case "failed": {
      const error = humanizeError(n.error);
      return { id: n.id, kind: n.kind, summary: `A message to ${n.agentId} failed: ${error}`, agent: n.agentId, at: n.ts, message: n.sentText.slice(0, 160), error };
    }
  }
}


/** One compact picture of the fleet: ships and voyages, who works, who waits on the captain, today's spend. */
/**
 * One compact picture of the fleet. The default is a summary sized for an
 * orchestrator's context (ships in a line each, what waits on the captain, who
 * works, spend); `detail` adds each crewmate's activity, officers, and
 * Firstmate's workers. Keeping the default small keeps Alice's context sparse.
 */
export async function fleetStatus(detail = false): Promise<Res> {
  const ships = await readShips();
  const since = midnightIso();
  const shipRows = await Promise.all(
    ships.map(async (ship) => {
      const v = await openVoyage(ship.id);
      const events = recentShipEvents(ship.id, 200);
      const members = listChatTargets().agents.filter((t) => t.ship === ship.id);
      return {
        id: ship.id,
        orchestrator: ship.orchestrator,
        mode: ship.mode,
        voyage: v ? { goal: v.goal, to: v.to, started: v.started, progress: taskProgress(listTasks(ship.id, v.file)) } : null,
        crew: members.map((t) => {
          const s = crewStatus(t.id, events, hostRunning(t.id));
          return { id: t.id, status: s.status, activity: plainSummary(s.activity).slice(0, 160), last: s.lastAt };
        }),
        factory: ship.adws.length > 0,
      };
    }),
  );
  const { agents, workers } = listChatTargets();
  const working = agents.concat(workers).filter((t) => hostRunning(t.id)).map((t) => t.id);
  const snap = lastFleetSnapshot();
  const needs = await collectNeedsYou({ waiting: hostWaiting, holds: snap ? collectCaptainHolds(snap) : [] });
  const spend: Record<string, number> = {};
  for (const id of new Set(ships.map((s) => s.id).concat(OFFICER_SHIP))) {
    for (const [agent, t] of Object.entries(shipTurnTotals(id, since))) spend[agent] = Math.round(((spend[agent] ?? 0) + t.cost) * 1000) / 1000;
  }
  const needsCaptain = needs.map(needLine);
  const message = `${ships.length} ships, ${working.length} agent(s) working, ${needs.length} item(s) waiting on the captain.`;
  if (!detail) {
    const total = Object.values(spend).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      message,
      ships: shipRows.map((s) => {
        const busy = s.crew.filter((c) => c.status === "working" || c.status === "waiting").map((c) => `${c.id} ${c.status}`);
        return `${s.id}: ${s.voyage ? `under sail "${s.voyage.goal.slice(0, 90)}" ${s.voyage.progress.done}/${s.voyage.progress.total} tasks` : "no voyage"}; ${s.crew.length} crew${busy.length ? ` (${busy.join(", ")})` : s.crew.length ? " idle" : ""}; orchestrator ${s.orchestrator}`;
      }),
      working,
      needsCaptain,
      spendTodayUsd: Math.round(total * 100) / 100,
      more: "fleet_status with detail=true adds each crewmate's activity, officers, Firstmate's workers, and spend per agent.",
    };
  }
  return {
    ok: true,
    message,
    ships: shipRows,
    officers: agents.filter((t) => !t.ship).map((t) => ({ id: t.id, model: t.model, working: hostRunning(t.id) })),
    firstmateWorkers: workers.map((w) => ({ id: w.id, title: w.label, state: w.state, project: w.project })),
    working,
    needsCaptain,
    spendTodayUsd: spend,
  };
}

export function shipLog(ship: string, limit: number, kind?: string): Res {
  if (!SHIP_RE.test(ship)) return { ok: false, message: "Bad ship id." };
  const events = recentShipEvents(ship, 400).filter((e) => !kind || e.kind === kind).slice(0, Math.max(1, Math.min(200, limit || 20)));
  return {
    ok: true,
    message: `${events.length} event(s) from the ${ship} log, newest first.`,
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      actor: e.actor,
      kind: e.kind,
      summary: (e.kind === "turn-end" && e.payload?.error ? humanizeError(e.summary) : plainSummary(e.summary)).slice(0, 200),
      ...(typeof e.payload?.cost === "number" ? { cost: e.payload.cost } : {}),
    })),
  };
}

export async function shipTasks(ship: string): Promise<Res> {
  const v = await openVoyage(ship);
  if (!v) return { ok: true, message: `${ship} is not under sail.`, voyage: null, tasks: [] };
  const tasks = listTasks(ship, v.file);
  return {
    ok: true,
    message: `${ship} under sail: ${v.goal}`,
    voyage: { goal: v.goal, to: v.to, started: v.started, record: v.file },
    progress: taskProgress(tasks),
    tasks: tasks.map((t) => {
      const waits = waitingOn(t, tasks);
      return { id: t.id, title: t.title, assignee: t.assignee, kind: t.kind, status: t.status, note: t.note.slice(0, 300), adwId: t.adwId, ...(waits.length ? { waitingOn: waits } : {}) };
    }),
    ready: readyTasks(tasks).map((t) => t.id),
  };
}

export async function shipManeuvers(ship: string): Promise<Res> {
  const row = (await readShips()).find((s) => s.id === ship);
  if (!row) return { ok: false, message: `No ship named ${ship}.` };
  const runs = recentManeuvers(row.path);
  return {
    ok: true,
    message: runs.length ? `${runs.length} recent SSSF run(s) on ${ship}.` : `No SSSF runs on ${ship}.`,
    adws: row.adws,
    declared: maneuverAvailability(row, "lead").map(describeManeuver),
    maneuvers: runs.map((m) => ({
      adwId: m.adwId,
      adw: m.adwName,
      status: m.status,
      request: m.request.slice(0, 200),
      started: m.startedAt,
      cost: m.cost,
      phases: m.phases.map((p) => ({ name: p.name, status: p.status, ...(p.error ? { error: p.error.slice(0, 200) } : {}) })),
    })),
  };
}

export async function agentChatRead(agent: string, n: number): Promise<Res> {
  if (!chatAllowed(agent)) return { ok: false, message: `${agent} is not on the rail.` };
  const lines = await readCaptainChat(agent, Math.max(1, Math.min(60, n || 8)));
  return {
    ok: true,
    message: `Last ${lines.length} line(s) of the captain's thread with ${agent}.`,
    lines: lines.map((l) => ({ ts: l.ts, from: l.from, kind: l.kind, text: l.kind === "error" ? humanizeError(l.text) : l.text.length > 600 ? `${l.text.slice(0, 600)}… (${l.text.length} chars; ask for fewer lines to see more)` : l.text })),
  };
}

/** A message from an officer to any agent on the rail; it starts that agent's turn like a crew message. */
export async function fleetChat(from: string, to: string, text: string): Promise<Res> {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, message: "Empty message." };
  if (to === from) return { ok: false, message: "That is you." };
  if (!chatAllowed(to)) return { ok: false, message: `${to} is not on the rail. fleet_status lists who is.` };
  const t = chatTarget(to);
  if (t?.kind === "task") return { ok: false, message: `${to} is a Firstmate worker; message Firstmate instead.` };
  const line = await acceptCrewLine(to, from, body.slice(0, 8000));
  return { ok: true, message: `Sent to ${to} at ${line.ts}${shipOf(to) ? ` (logged on the ${shipOf(to)} ship log)` : ""}. Its reply lands in its own thread; read it with agent_chat_read.` };
}

// ---------------------------------------------------------------- tier 2 actions

let fleetChanged: (what: "rail" | "ship" | "go") => void = () => {};

/** The node tells the dashboard when an action changed crews, ships, or pending Gos. */
export function onFleetChange(fn: (what: "rail" | "ship" | "go") => void): void {
  fleetChanged = fn;
}

/** Needs you changed (a held call, a decision): the dashboard refreshes it. */
export function needsChanged(): void {
  fleetChanged("go");
}

/** Run a fleet action now: the captain said Go, or it is an approved order's step. */
export async function runFleetAction(tool: string, a: Record<string, string>): Promise<Res> {
  const bad = tier2ArgError(tool, a);
  if (bad) return { ok: false, message: bad };
  const ship = a.ship ? await findShip(a.ship) : undefined;
  if (a.ship && !ship) return { ok: false, message: `No ship named ${a.ship}.` };
  let res: Res;
  switch (tool) {
    case "voyage_start": {
      const allowed = (ship!.orchestrator === "firstmate" ? ["firstmate"] : []).concat(ship!.crew.map((r) => `${ship!.id}-${r}`));
      if (!allowed.includes(a.to!)) return { ok: false, message: `Send the voyage to ${allowed.join(" or ") || "a crewmate aboard (none yet)"}.` };
      const started = await startVoyage(ship!.id, a.goal!, a.to!, a.on, { deliver: async (to, text) => void (await postCaptainLine(to, text)), stop: stopHost, spec: a.spec || undefined, chore: a.chore === "true" });
      res = started;
      if (started.ok && started.voyage && !started.rigging) {
        const line = await postCaptainLine(a.to!, voyageBrief(ship!, started.voyage));
        res = { ok: true, message: `${ship!.id} set sail; the brief went to ${a.to} at ${line.ts}.`, voyage: started.voyage.file };
      }
      break;
    }
    case "voyage_dock":
      res = await dockVoyage(ship!.id, a.summary ?? "");
      break;
    case "crew_change": {
      if (a.remove) {
        const ashore = `${ship!.id}-${a.remove}`;
        if (hostRunning(ashore)) return { ok: false, message: `${ashore} is mid-task. Stop it or let it finish first.` };
        await stopHost(ashore);
      }
      const budget = a.budget === undefined ? undefined : a.budget === "" || a.budget === "none" ? null : Number(a.budget);
      if (budget !== undefined && budget !== null && !(budget >= 0)) return { ok: false, message: "budget is a number of dollars, or none." };
      res = await setCrew(ship!.id, {
        ...(a.add ? { add: a.add } : {}),
        ...(a.remove ? { remove: a.remove } : {}),
        ...(budget !== undefined ? { budget: { role: a.role!, usd: budget } } : {}),
        ...(a.model !== undefined ? { model: { role: a.role!, model: a.model === "" || a.model === "default" ? null : a.model } } : {}),
      });
      if (res.ok) {
        await refreshAgentTargets();
        fleetChanged("rail");
      }
      break;
    }
    case "orchestrator_set":
      res = await setOrchestrator(ship!.id, a.orchestrator!);
      break;
    case "maneuver_start": {
      if (!ship!.crew.includes("lead")) return { ok: false, message: `${ship!.id} has no lead aboard to run a maneuver; crew the ship first.` };
      // The captain's Go authorises it (any role), but a locked maneuver stays locked.
      res = await crewStartManeuver(ship!.id, { from: `${ship!.id}-lead`, maneuver: a.adw, prompt: a.prompt }, { withGo: true });
      break;
    }
    case "agent_abort":
      if (chatTarget(a.agent!)?.runtime !== "rpc") return { ok: false, message: `${a.agent} is not a live agent.` };
      res = (await abortHost(a.agent!)) ? { ok: true, message: `${a.agent} was stopped mid-turn.` } : { ok: false, message: `${a.agent} was not working.` };
      break;
    case "agent_new_session":
      if (!chatTarget(a.agent!)?.persistentSession) return { ok: false, message: `${a.agent} has no shared session.` };
      res = await newSession(a.agent!);
      break;
    default:
      return { ok: false, message: `${tool} is not a fleet action.` };
  }
  if (a.ship) fleetChanged("ship");
  return res;
}

/** The voyage branch's commit (null when it cannot be read). Tests replace it. */
let dockHead = async (shipId: string): Promise<string | null> => {
  const ship = await findShip(shipId);
  if (!ship) return null;
  const { commit } = await treeState(gateFolder(ship), voyageHost(shipId));
  return commit || null;
};
export function setDockHeadProbe(fn: ((shipId: string) => Promise<string | null>) | null): void {
  dockHead = fn ?? defaultDockHead;
}
const defaultDockHead = dockHead;

/** Cancel the ship's older dock asks still waiting (their cards go); returns the branch's commit now. */
async function supersedeDockAsks(shipId: string): Promise<string | undefined> {
  for (const w of listWorkflows<GoRequest>("go", "waiting")) {
    if (w.data.tool === "voyage_dock" && w.data.args?.ship === shipId) updateWorkflow(w.id, { status: "cancelled", data: { result: "superseded by a newer dock request" } });
  }
  return (await dockHead(shipId).catch(() => null)) ?? undefined;
}

/** Outside an order: hold the action for the captain's Go and ask in the officer's thread. */
export async function requestGo(from: string, tool: string, a: Record<string, string>, why = ""): Promise<Res> {
  const bad = tier2ArgError(tool, a);
  if (bad) return { ok: false, message: bad };
  const reason = why.trim().replace(/\s+/g, " ").slice(0, 300);
  const summary = `${describeAction(tool, a)}${reason ? ` Why: ${reason}` : ""}`;
  const id = crypto.randomUUID().slice(0, 12);
  // A dock ask replaces the ship's older one, and remembers what it asked about.
  const head = tool === "voyage_dock" && a.ship ? await supersedeDockAsks(a.ship) : undefined;
  const line = await postLine(from, {
    ts: new Date().toISOString(),
    from,
    kind: "question",
    text: `Go for this? ${summary}`,
    questions: [{ id: `go-${id}`, question: summary, options: ["Go", "No"] }],
    go: { id, tool },
  });
  holdGoRequest({ id, tool, args: a, from, ts: line.ts, lineTs: line.ts, summary, trace: `go-${id}`, ...(head ? { head } : {}) });
  fleetChanged("go");
  return { ok: true, message: `Waiting for the captain's Go on: ${summary} End your turn now; the result arrives as a message. Do not ask again or retry.` };
}

/** The captain's answer to a held action. Every side effect is a journal step, so it happens at most once. */
export async function decideGo(id: string, go: boolean): Promise<Res> {
  const w = getWorkflow<GoRequest>(id);
  if (!w || w.kind !== "go" || w.status !== "waiting") return { ok: false, message: "That request is no longer waiting." };
  // A Go is for the work as it was when asked: crew commits since then (fixes after a "not yet") need a fresh ask.
  if (go && w.data.tool === "voyage_dock" && w.data.head && w.data.args.ship) {
    const now = await dockHead(w.data.args.ship);
    if (now && now !== w.data.head) {
      const msg = `${w.data.args.ship}'s branch moved since the dock was asked (${w.data.head.slice(0, 7)} → ${now.slice(0, 7)}), so this Go would dock work nobody showed you. Nothing was docked; the lead was asked to summarise the new work and ask again.`;
      updateWorkflow(id, { status: "cancelled", data: { result: "stale: the branch moved" } });
      await acceptCrewLine(w.data.from, "go", `The captain pressed Go on your dock request, but the branch moved since you asked (${w.data.head.slice(0, 7)} → ${now.slice(0, 7)}). Nothing was docked. Check the new commits, make sure the dock gates are green, refresh the captain's canvas if screenshots changed, then ask to dock again with a summary that covers them.`).catch(() => {});
      fleetChanged("go");
      return { ok: false, message: msg };
    }
  }
  updateWorkflow(id, { status: "running", data: { decision: go ? "go" : "no" } });
  fleetChanged("go");
  return finishGo(id);
}

/** Carry a decided request through to the end; also what a restarted node calls for unfinished ones. */
export async function finishGo(id: string): Promise<Res> {
  const w = getWorkflow<GoRequest & { decision?: "go" | "no" }>(id);
  if (!w) return { ok: false, message: "No such request." };
  const req = w.data;
  // Already finished (done, failed, or declined): never run the action again, even when it failed.
  if (w.status !== "running") return { ok: w.status === "done", message: String((w.data as { result?: string }).result ?? `Already ${w.status}.`) };
  const go = req.decision === "go";
  await once(id, "answer", async () => (await postLine(req.from, { ts: new Date().toISOString(), from: "captain", kind: "answer", text: go ? "Go" : "No", ref: req.lineTs })).ts);
  if (!go) {
    await once(id, "tell", async () => (await acceptCrewLine(req.from, "go", `The captain said No to: ${req.summary} Nothing was done. Do not retry it unless the captain asks.`)).ts);
    updateWorkflow(id, { status: "cancelled" });
    return { ok: true, message: "Declined; Alice was told." };
  }
  const run = await once(id, "run", () => runFleetAction(req.tool, req.args), (r) => r.ok);
  if ("uncertain" in run) {
    // The node stopped in the middle of the action: it may or may not have happened. Never guess; never repeat.
    const msg = `The node restarted while running "${req.summary}", so it is not known whether it happened. Check before asking again.`;
    await once(id, "tell", async () => (await acceptCrewLine(req.from, "go", msg)).ts);
    updateWorkflow(id, { status: "failed", data: { error: "interrupted mid-action" } });
    journalEvent(w.trace, "go-uncertain", { id, tool: req.tool });
    return { ok: false, message: msg };
  }
  const res = run.result;
  await once(id, "tell", async () => (await acceptCrewLine(req.from, "go", `The captain said Go: ${req.summary}\nResult: ${res.ok ? "done" : "failed"}: ${res.message}`)).ts);
  updateWorkflow(id, { status: res.ok ? "done" : "failed", data: { result: res.message.slice(0, 500) } });
  return { ok: res.ok, message: res.message };
}

/** After a node restart: finish every request the captain had already decided. */
export async function recoverGos(): Promise<void> {
  for (const w of listWorkflows("go", "running")) {
    try {
      await finishGo(w.id);
    } catch (e) {
      console.error("[node] go recovery:", e);
    }
  }
}
