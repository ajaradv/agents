import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { hostRunning } from "./agent-host.ts";
import { postBus } from "./bus-post.ts";
import { acceptCrewLine } from "./chat-bridge.ts";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";
import { recentManeuvers, shipTraceDb } from "./ship-maneuvers.ts";
import { logShipEvent, recentShipEvents } from "./ship-log.ts";
import { openVoyage, type Voyage } from "./shipyard.ts";
import { addTask, getTask, listTasks, taskProgress, TASK_STATUSES, updateTask, type TaskStatus, type VoyageTask } from "./voyage-tasks.ts";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * What crewmates call (through extensions/crew.ts) to work as a crew:
 * the lead plans the voyage into tasks and assigns them, crewmates report on
 * theirs, anyone aboard can message anyone aboard, and the lead can launch
 * SSSF maneuvers. Every call names its caller (`from`); only crewmates of the
 * ship are accepted, and lead-only calls check the lead role.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

const ADW_RE = /^adw_[a-z0-9_]+$/;

async function aboard(shipId: string, from: string): Promise<{ ship: ShipRow; role: string } | { error: Res }> {
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return { error: { ok: false, message: `No ship named ${shipId}.` } };
  const role = from.startsWith(`${shipId}-`) ? from.slice(shipId.length + 1) : "";
  if (!role || !ship.crew.includes(role)) return { error: { ok: false, message: `${from} is not aboard ${shipId}.` } };
  return { ship, role };
}

function leadOf(ship: ShipRow): string | null {
  return ship.crew.includes("lead") ? `${ship.id}-lead` : null;
}

function crewIds(ship: ShipRow): string[] {
  return ship.crew.map((r) => `${ship.id}-${r}`);
}

async function needVoyage(ship: ShipRow): Promise<Voyage | Res> {
  const v = await openVoyage(ship.id);
  return v ?? { ok: false, message: `${ship.id} is not under sail. The captain sets a course from the ship's deck.` };
}

function taskBrief(t: VoyageTask, ship: ShipRow): string {
  return [
    `Task #${t.id} for you on the ${ship.id} voyage: ${t.title}`,
    t.detail ? `\n${t.detail}` : "",
    `\nWhen it is done or blocked, call task_report with id ${t.id} and a short summary (what changed, where, anything the lead must know). Ask the lead with crew_message if the task is unclear; ask the captain with ask_captain only for decisions that are the captain's.`,
  ].join("");
}

// ---------------------------------------------------------------- status

export async function voyageStatus(shipId: string, from: string): Promise<Res> {
  const a = await aboard(shipId, from);
  if ("error" in a) return a.error;
  const v = await openVoyage(shipId);
  if (v) await reconcileManeuvers(a.ship, v);
  const tasks = v ? listTasks(shipId, v.file) : [];
  const events = recentShipEvents(shipId, 200);
  const crew = crewIds(a.ship).map((id) => {
    const last = events.find((e) => e.actor === id && (e.kind === "chat-out" || e.kind === "tool" || e.kind === "question"));
    return { id, working: hostRunning(id), last: last ? `${last.kind}: ${last.summary.slice(0, 160)}` : "nothing yet" };
  });
  return {
    ok: true,
    message: v ? `${shipId} under sail: ${v.goal}` : `${shipId} is not under sail.`,
    voyage: v ? { goal: v.goal, started: v.started, record: v.file } : null,
    progress: taskProgress(tasks),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, kind: t.kind, status: t.status, note: t.note.slice(0, 300), adwId: t.adwId })),
    crew,
    lead: leadOf(a.ship),
    adws: a.ship.adws,
  };
}

// ---------------------------------------------------------------- tasks

export async function crewAddTask(shipId: string, b: { from: string; title?: string; detail?: string; assignee?: string | null }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  if (a.role !== "lead") return { ok: false, message: "Only the ship's lead adds tasks. Message the lead with crew_message instead." };
  const v = await needVoyage(a.ship);
  if ("ok" in v) return v;
  const title = String(b.title ?? "").trim();
  if (title.length < 3) return { ok: false, message: "A task needs a title." };
  const assignee = b.assignee ? String(b.assignee) : null;
  if (assignee && !crewIds(a.ship).includes(assignee)) return { ok: false, message: `${assignee} is not aboard. Crew: ${crewIds(a.ship).join(", ")}.` };
  const t = await addTask(shipId, { voyage: v.file, title, detail: String(b.detail ?? ""), assignee, createdBy: b.from, status: assignee && assignee !== b.from ? "working" : "open" });
  if (assignee && assignee !== b.from) await acceptCrewLine(assignee, b.from, taskBrief(t, a.ship));
  return { ok: true, message: `Task #${t.id} added${assignee ? ` and sent to ${assignee}` : ""}.`, task: t.id };
}

export async function crewUpdateTask(shipId: string, id: number, b: { from: string; status?: string; note?: string; assignee?: string | null }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  const t = getTask(shipId, id);
  if (!t) return { ok: false, message: `No task #${id} on ${shipId}.` };
  const isLead = a.role === "lead";
  if (!isLead && t.assignee !== b.from) return { ok: false, message: `Task #${id} is ${t.assignee ?? "unassigned"}'s. Report on your own tasks, or message the lead.` };
  const status = b.status ? String(b.status) : undefined;
  if (status && !(TASK_STATUSES as string[]).includes(status)) return { ok: false, message: `Status is one of ${TASK_STATUSES.join(", ")}.` };
  let assignee: string | null | undefined;
  if (b.assignee !== undefined) {
    if (!isLead) return { ok: false, message: "Only the lead reassigns tasks." };
    assignee = b.assignee ? String(b.assignee) : null;
    if (assignee && !crewIds(a.ship).includes(assignee)) return { ok: false, message: `${assignee} is not aboard.` };
  }
  const reassigned = assignee !== undefined && assignee !== t.assignee;
  const updated = await updateTask(shipId, id, {
    ...(status ? { status: status as TaskStatus } : reassigned && assignee ? { status: "working" as TaskStatus } : {}),
    ...(b.note !== undefined ? { note: String(b.note) } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    by: b.from,
  });
  if (!updated) return { ok: false, message: "Update failed." };
  if (reassigned && assignee && assignee !== b.from) await acceptCrewLine(assignee, b.from, taskBrief(updated, a.ship));
  const lead = leadOf(a.ship);
  if (!isLead && lead && lead !== b.from) {
    await acceptCrewLine(lead, b.from, `Task #${id} (${t.title}) is ${updated.status}.${b.note ? `\n\n${b.note}` : ""}`);
  }
  return { ok: true, message: `Task #${id} is ${updated.status}${!isLead && lead ? "; the lead has been told" : ""}.` };
}

export async function crewMessage(shipId: string, b: { from: string; to?: string; text?: string }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  const to = String(b.to ?? "");
  if (to === b.from) return { ok: false, message: "That is you." };
  if (!crewIds(a.ship).includes(to)) return { ok: false, message: `${to} is not aboard. Crew: ${crewIds(a.ship).join(", ")}.` };
  const text = String(b.text ?? "").trim();
  if (!text) return { ok: false, message: "Say something." };
  await acceptCrewLine(to, b.from, text);
  return { ok: true, message: `Sent to ${to}. Its reply comes back to you as a crew message only if it writes to you; check voyage_status for task reports.` };
}

// ---------------------------------------------------------------- maneuvers

const running = new Map<string, { taskId: number; ship: string }>();

function maneuverLogDir(shipId: string): string {
  return join(fleetInboxRoot(), "ships", shipId, "maneuvers");
}

export async function crewStartManeuver(shipId: string, b: { from: string; adw?: string; prompt?: string }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  if (a.role !== "lead") return { ok: false, message: "Only the lead launches maneuvers." };
  const v = await needVoyage(a.ship);
  if ("ok" in v) return v;
  const adw = String(b.adw ?? "");
  if (!ADW_RE.test(adw) || !a.ship.adws.includes(adw)) {
    return { ok: false, message: a.ship.adws.length ? `Pick one of this ship's ADWs: ${a.ship.adws.join(", ")}.` : `${shipId} has no SSSF factory; assign the work to a crewmate instead.` };
  }
  const prompt = String(b.prompt ?? "").trim();
  if (prompt.length < 10) return { ok: false, message: "Give the maneuver a full prompt: the intent, the files, and what done means." };
  const adwId = randomBytes(4).toString("hex");
  const task = await addTask(shipId, { voyage: v.file, title: `${adw}: ${prompt.slice(0, 120)}`, detail: prompt, kind: "maneuver", adwId, status: "working", createdBy: b.from });
  mkdirSync(maneuverLogDir(shipId), { recursive: true });
  const log = join(maneuverLogDir(shipId), `${adwId}.log`);
  const fd = openSync(log, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["uv", "run", `adws/${adw}.py`, prompt, "--adw-id", adwId], { cwd: a.ship.path, stdout: fd, stderr: fd, stdin: "ignore" });
  } finally {
    // The child has its own copy of the log descriptor; keeping ours leaks one per maneuver.
    closeSync(fd);
  }
  running.set(adwId, { taskId: task.id, ship: shipId });
  logShipEvent(shipId, b.from, "maneuver", `${adw} launched (${adwId})`, { adw, adwId, task: task.id, log });
  void proc.exited.then(async (code) => {
    running.delete(adwId);
    await settleManeuver(a.ship, task.id, adwId, code);
  });
  return { ok: true, message: `Maneuver ${adw} launched as ${adwId} (task #${task.id}). You get a crew message when it finishes; voyage_status shows its phases meanwhile.`, adwId, task: task.id };
}

function traceStatus(shipPath: string, adwId: string): { status: string | null; ended: boolean } {
  const path = shipTraceDb(shipPath);
  if (!existsSync(path)) return { status: null, ended: false };
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const r = db.query("SELECT status, ended_at FROM sessions WHERE adw_id = ?").get(adwId) as { status: string | null; ended_at: string | null } | null;
    return { status: r?.status ?? null, ended: Boolean(r?.ended_at) };
  } catch {
    return { status: null, ended: false };
  } finally {
    db?.close();
  }
}

async function settleManeuver(ship: ShipRow, taskId: number, adwId: string, exitCode: number | null): Promise<void> {
  const t = getTask(ship.id, taskId);
  if (!t || t.status === "done" || t.status === "blocked") return;
  const run = recentManeuvers(ship.path, 20).find((m) => m.adwId === adwId);
  const failed = run?.phases.find((p) => p.status === "fail" || p.status === "error");
  const ok = exitCode === 0 && !failed && run?.status !== "fail";
  const note = ok
    ? `Maneuver passed${run ? `: ${run.phases.map((p) => p.name).join(" → ")}` : ""}.`
    : `Maneuver failed${failed ? ` at ${failed.name}${failed.error ? `: ${failed.error.slice(0, 300)}` : ""}` : exitCode !== null ? ` (exit ${exitCode})` : ""}. Log: fleet/inbox/ships/${ship.id}/maneuvers/${adwId}.log`;
  await updateTask(ship.id, taskId, { status: ok ? "done" : "blocked", note, by: "sssf" });
  const lead = leadOf(ship);
  if (lead) await acceptCrewLine(lead, "sssf", `Maneuver ${adwId} (task #${taskId}) ${ok ? "finished" : "failed"}. ${note}`);
  // Alice keeps the fleet picture: the event router wakes her with this (batched).
  await postBus("alice", { from: "sssf", kind: ok ? "maneuver-finished" : "maneuver-failed", ship: ship.id, summary: `Maneuver ${adwId} (task #${taskId}) on ${ship.id} ${ok ? "finished" : "failed"}. ${note}`.slice(0, 400), ref: adwId });
}

/** After a dashboard restart the exit callback is gone; settle from the trace db. */
async function reconcileManeuvers(ship: ShipRow, v: Voyage): Promise<void> {
  for (const t of listTasks(ship.id, v.file)) {
    if (t.kind !== "maneuver" || t.status !== "working" || !t.adwId || running.has(t.adwId)) continue;
    const s = traceStatus(ship.path, t.adwId);
    if (s.ended) await settleManeuver(ship, t.id, t.adwId, s.status === "pass" || s.status === "ok" || s.status === "done" ? 0 : 1);
  }
}
