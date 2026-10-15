import { hostRunning, hostWaiting } from "./agent-host.ts";
import { acceptCrewLine, FLEET_OFFICERS } from "./chat-bridge.ts";
import { readCaptainChat } from "./chat.ts";
import { chatAllowed, chatTarget, listChatTargets } from "./chat-targets.ts";
import { readShips } from "./fleet-layers.ts";
import { collectCaptainHolds, lastFleetSnapshot } from "./fleet-snapshot.ts";
import { humanizeError, plainSummary } from "./humanize.ts";
import { collectNeedsYou } from "./needs-you.ts";
import { OFFICER_SHIP, shipOf } from "./ship-events.ts";
import { recentShipEvents, shipTurnTotals } from "./ship-log.ts";
import { recentManeuvers } from "./ship-maneuvers.ts";
import { crewStatus } from "./ship-view.ts";
import { openVoyage } from "./shipyard.ts";
import { listTasks, taskProgress } from "./voyage-tasks.ts";

/**
 * The fleet API for officers (extensions/fleet.ts), served by the fleet node.
 * Phase 1 of the Alice omni plan: reads of the whole fleet plus fleet_chat
 * (messages to any agent on the rail). Fleet actions that change state
 * (voyages, crew, maneuvers) come in phase 3 behind a server-held captain Go.
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

/** One compact picture of the fleet: ships and voyages, who works, who waits on the captain, today's spend. */
export async function fleetStatus(): Promise<Res> {
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
  return {
    ok: true,
    message: `${ships.length} ships, ${working.length} agent(s) working, ${needs.length} item(s) waiting on the captain.`,
    ships: shipRows,
    officers: agents.filter((t) => !t.ship).map((t) => ({ id: t.id, model: t.model, working: hostRunning(t.id) })),
    firstmateWorkers: workers.map((w) => ({ id: w.id, title: w.label, state: w.state, project: w.project })),
    working,
    needsCaptain: needs.map((n) =>
      n.kind === "hold"
        ? { kind: n.kind, task: n.taskId, title: n.title, reason: n.reason }
        : n.kind === "question"
          ? { kind: n.kind, agent: n.agentId, asked: n.ts, question: n.questions.map((q) => q.question).join(" / ") }
          : n.kind === "order"
            ? { kind: n.kind, order: n.slug, title: n.title, status: n.status, ...(n.reason ? { reason: n.reason } : {}) }
            : { kind: n.kind, agent: n.agentId, at: n.ts, message: n.sentText.slice(0, 160), error: humanizeError(n.error) },
    ),
    spendTodayUsd: spend,
  };
}

export function shipLog(ship: string, limit: number, kind?: string): Res {
  if (!SHIP_RE.test(ship)) return { ok: false, message: "Bad ship id." };
  const events = recentShipEvents(ship, 400).filter((e) => !kind || e.kind === kind).slice(0, Math.max(1, Math.min(200, limit || 40)));
  return {
    ok: true,
    message: `${events.length} event(s) from the ${ship} log, newest first.`,
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts,
      actor: e.actor,
      kind: e.kind,
      summary: (e.kind === "turn-end" && e.payload?.error ? humanizeError(e.summary) : plainSummary(e.summary)).slice(0, 400),
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
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, kind: t.kind, status: t.status, note: t.note.slice(0, 300), adwId: t.adwId })),
  };
}

export async function shipManeuvers(ship: string): Promise<Res> {
  const row = (await readShips()).find((s) => s.id === ship);
  if (!row) return { ok: false, message: `No ship named ${ship}.` };
  const runs = recentManeuvers(row.path);
  return {
    ok: true,
    message: runs.length ? `${runs.length} recent maneuver(s) on ${ship}.` : `No maneuvers on ${ship}${row.adws.length ? "" : " (no factory)"}.`,
    adws: row.adws,
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
  const lines = await readCaptainChat(agent, Math.max(1, Math.min(60, n || 12)));
  return {
    ok: true,
    message: `Last ${lines.length} line(s) of the captain's thread with ${agent}.`,
    lines: lines.map((l) => ({ ts: l.ts, from: l.from, kind: l.kind, text: l.kind === "error" ? humanizeError(l.text) : l.text.slice(0, 2000) })),
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
