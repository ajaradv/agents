import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostRunning } from "./agent-host.ts";
import { postBus } from "./bus-post.ts";
import { getWorkflow, listWorkflows, once, updateWorkflow, upsertWorkflow } from "./journal.ts";
import { pidAlive } from "./session.ts";
import { acceptCrewLine } from "./chat-bridge.ts";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";
import { recentManeuvers, shipTraceDb } from "./ship-maneuvers.ts";
import { logShipEvent, recentShipEvents } from "./ship-log.ts";
import { recordHandoff, recordRun } from "./metrics.ts";
import { describeGates, gateFolder, gateStatus, runGates } from "./gates.ts";
import { describeManeuver, findManeuver, launchRefusal, maneuverAvailability, type ManeuverAvailability } from "./maneuvers.ts";
import { runCheck, tail, treeState } from "./ship-checks.ts";
import { openVoyage, type Voyage } from "./shipyard.ts";
import { addTask, blockersRefusal, claimTask, getTask, listTasks, parseIds, readyTasks, taskProgress, TASK_STATUSES, unblockedBy, updateTask, waitingOn, type TaskStatus, type VoyageTask } from "./voyage-tasks.ts";
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
    tasks: tasks.map((t) => {
      const waits = waitingOn(t, tasks);
      return { id: t.id, title: t.title, assignee: t.assignee, kind: t.kind, status: t.status, note: t.note.slice(0, 300), adwId: t.adwId, ...(t.role ? { role: t.role } : {}), ...(t.blockedBy.length ? { blockedBy: t.blockedBy } : {}), ...(waits.length ? { waitingOn: waits } : {}) };
    }),
    // Open tasks that wait on nothing: unassigned ones can be claimed (task_claim), assigned ones are being sent.
    ready: readyTasks(tasks).map((t) => ({ id: t.id, title: t.title, assignee: t.assignee, ...(t.role ? { role: t.role } : {}) })),
    crew,
    lead: leadOf(a.ship),
    maneuvers: maneuverAvailability(a.ship, a.role).map((m) => ({ name: m.name, yours: m.yours, about: describeManeuver(m) })),
    gates: {
      task: a.ship.gates.task.length ? describeGates(await gateStatus(a.ship, "task")) : "none",
      dock: a.ship.gates.dock.length ? describeGates(await gateStatus(a.ship, "dock")) : "none",
    },
  };
}

// ---------------------------------------------------------------- tasks

export async function crewAddTask(shipId: string, b: { from: string; title?: string; detail?: string; assignee?: string | null; blockedBy?: unknown; role?: unknown }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  if (a.role !== "lead") return { ok: false, message: "Only the ship's lead adds tasks. Message the lead with crew_message instead." };
  const v = await needVoyage(a.ship);
  if ("ok" in v) return v;
  const title = String(b.title ?? "").trim();
  if (title.length < 3) return { ok: false, message: "A task needs a title." };
  const assignee = b.assignee ? String(b.assignee) : null;
  if (assignee && !crewIds(a.ship).includes(assignee)) return { ok: false, message: `${assignee} is not aboard. Crew: ${crewIds(a.ship).join(", ")}.` };
  const role = b.role ? String(b.role) : null;
  if (role && !a.ship.crew.includes(role)) return { ok: false, message: `No ${role} aboard ${shipId}. Roles: ${a.ship.crew.join(", ")}.` };
  if (role && assignee && assignee !== `${shipId}-${role}`) return { ok: false, message: `Task is for the ${role}; assign it to ${shipId}-${role} or leave it unassigned.` };
  const blockedBy = parseIds(b.blockedBy);
  const existing = listTasks(shipId, v.file);
  const refusal = blockersRefusal(existing, blockedBy);
  if (refusal) return { ok: false, message: refusal };
  // A task that waits on unfinished work is held: its brief goes out when the last of them is done.
  const waits = blockedBy.filter((id) => existing.find((t) => t.id === id)?.status !== "done");
  const sendNow = Boolean(assignee && assignee !== b.from && !waits.length);
  const t = await addTask(shipId, { voyage: v.file, title, detail: String(b.detail ?? ""), assignee, blockedBy, role, createdBy: b.from, status: sendNow ? "working" : "open" });
  if (sendNow && assignee) await acceptCrewLine(assignee, b.from, taskBrief(t, a.ship));
  recordHandoff({ ship: shipId, from: b.from, to: assignee ?? "", kind: "task-assigned", size: title.length + String(b.detail ?? "").length });
  const after = waits.length ? ` It waits on ${waits.map((n) => `#${n}`).join(", ")}${assignee ? `; ${assignee} gets it when they are done` : "; it becomes claimable when they are done"}.` : "";
  return { ok: true, message: `Task #${t.id} added${sendNow ? ` and sent to ${assignee}` : ""}.${after}`, task: t.id };
}

export async function crewUpdateTask(shipId: string, id: number, b: { from: string; status?: string; note?: string; assignee?: string | null; blockedBy?: unknown; claim?: unknown }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  const t = getTask(shipId, id);
  if (!t) return { ok: false, message: `No task #${id} on ${shipId}.` };
  if (b.claim === true) return claim(a.ship, t, b.from);
  const isLead = a.role === "lead";
  let blockedBy: number[] | undefined;
  if (b.blockedBy !== undefined) {
    if (!isLead) return { ok: false, message: "Only the lead changes what a task waits on." };
    blockedBy = parseIds(b.blockedBy);
    const refusal = blockersRefusal(listTasks(shipId, t.voyage), blockedBy, id);
    if (refusal) return { ok: false, message: refusal };
  }
  if (!isLead && t.assignee !== b.from) return { ok: false, message: `Task #${id} is ${t.assignee ?? "unassigned"}'s. Report on your own tasks, or message the lead.` };
  const status = b.status ? String(b.status) : undefined;
  if (status && !(TASK_STATUSES as string[]).includes(status)) return { ok: false, message: `Status is one of ${TASK_STATUSES.join(", ")}.` };
  let assignee: string | null | undefined;
  if (b.assignee !== undefined) {
    if (!isLead) return { ok: false, message: "Only the lead reassigns tasks." };
    assignee = b.assignee ? String(b.assignee) : null;
    if (assignee && !crewIds(a.ship).includes(assignee)) return { ok: false, message: `${assignee} is not aboard.` };
    if (assignee && t.role && assignee !== `${shipId}-${t.role}`) return { ok: false, message: `Task #${id} is for the ${t.role}.` };
  }
  const reassigned = assignee !== undefined && assignee !== t.assignee;
  // A reassigned task that still waits on others stays open; its brief goes out when they are done.
  const waits = waitingOn({ ...t, blockedBy: blockedBy ?? t.blockedBy }, listTasks(shipId, t.voyage));
  const sendOnAssign = reassigned && Boolean(assignee) && waits.length === 0 && t.status !== "done";
  // Declared task gates: "done" is earned. The helm runs them in the background; the task stays
  // working until they pass (then done) or fail (then blocked, with the output).
  const gated = status === "done" && a.ship.gates.task.length > 0;
  if (gated) {
    await updateTask(shipId, id, { status: "working", note: `${b.note ? `${String(b.note)}\n\n` : ""}Verifying: running task gates (${a.ship.gates.task.join(", ")}).`, by: b.from });
    recordHandoff({ ship: shipId, from: b.from, to: "helm", kind: "task-verify", size: String(b.note ?? "").length });
    void verifyTask(a.ship, id, b.from, String(b.note ?? ""));
    return { ok: true, message: `Task #${id}: running its gates (${a.ship.gates.task.join(", ")}) before it counts as done. You and the lead hear the result; carry on or end your turn.` };
  }
  const updated = await updateTask(shipId, id, {
    ...(status ? { status: status as TaskStatus } : sendOnAssign ? { status: "working" as TaskStatus } : {}),
    ...(b.note !== undefined ? { note: String(b.note) } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(blockedBy !== undefined ? { blockedBy } : {}),
    by: b.from,
  });
  if (!updated) return { ok: false, message: "Update failed." };
  if (updated.status === "done") await releaseDependents(a.ship, updated);
  recordHandoff({ ship: shipId, from: b.from, to: reassigned ? (assignee ?? "") : isLead ? (t.assignee ?? "") : (leadOf(a.ship) ?? ""), kind: reassigned ? "task-reassigned" : `task-${updated.status}`, size: String(b.note ?? "").length });
  if (sendOnAssign && assignee && assignee !== b.from) await acceptCrewLine(assignee, b.from, taskBrief(updated, a.ship));
  const lead = leadOf(a.ship);
  if (!isLead && lead && lead !== b.from) {
    await acceptCrewLine(lead, b.from, `Task #${id} (${t.title}) is ${updated.status}.${b.note ? `\n\n${b.note}` : ""}`);
  }
  return { ok: true, message: `Task #${id} is ${updated.status}${!isLead && lead ? "; the lead has been told" : ""}.` };
}

/** Run a task's gates; mark it done when they pass, blocked (with the failures) when they do not. */
async function verifyTask(ship: ShipRow, id: number, reporter: string, note: string): Promise<void> {
  try {
    const { report, failures } = await runGates(ship, "task", "helm");
    const t = getTask(ship.id, id);
    if (!t) return;
    const lead = leadOf(ship);
    const tell = async (text: string) => {
      for (const who of new Set([reporter, lead].filter((x): x is string => Boolean(x)))) await acceptCrewLine(who, "helm", text);
    };
    if (report.green) {
      const done = await updateTask(ship.id, id, { status: "done", note: `${note ? `${note}\n\n` : ""}${describeGates(report)}`, by: "helm" });
      recordHandoff({ ship: ship.id, from: "helm", to: reporter, kind: "task-done", size: 0 });
      await tell(`Task #${id} (${t.title}) is done: ${describeGates(report)}`);
      if (done) await releaseDependents(ship, done);
    } else {
      await updateTask(ship.id, id, { status: "blocked", note: `${note ? `${note}\n\n` : ""}${describeGates(report)}`, by: "helm" });
      recordHandoff({ ship: ship.id, from: "helm", to: reporter, kind: "task-blocked", size: failures.length });
      await tell(`Task #${id} (${t.title}) is not done yet: ${describeGates(report)}${failures ? `\n\n${failures}` : ""}\n\nFix it, commit, and report the task done again.`);
    }
  } catch (e) {
    logShipEvent(ship.id, "helm", "notice", `Task #${id} gates could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A crewmate takes a ready task (lib/voyage-tasks claimTask); the lead is told. */
async function claim(ship: ShipRow, t: VoyageTask, who: string): Promise<Res> {
  const r = await claimTask(ship.id, t.id, who);
  if ("refusal" in r) return { ok: false, message: `${r.refusal} voyage_status lists ready tasks.` };
  recordHandoff({ ship: ship.id, from: who, to: who, kind: "task-claimed", size: 0 });
  const lead = leadOf(ship);
  if (lead && lead !== who) await acceptCrewLine(lead, who, `I claimed task #${t.id} (${t.title}).`);
  return { ok: true, message: `Task #${t.id} is yours and working.\n\n${taskBrief(r.task, ship)}` };
}

/**
 * A task is done: send each task that was waiting only on finished work to its
 * assignee, and tell the lead about ready ones nobody has.
 */
async function releaseDependents(ship: ShipRow, done: VoyageTask): Promise<void> {
  const lead = leadOf(ship);
  const free: VoyageTask[] = [];
  for (const t of unblockedBy(ship.id, done.voyage, done.id)) {
    if (t.assignee) {
      const sent = await updateTask(ship.id, t.id, { status: "working", by: "helm" });
      if (sent) await acceptCrewLine(t.assignee, t.createdBy, taskBrief(sent, ship));
      recordHandoff({ ship: ship.id, from: "helm", to: t.assignee, kind: "task-released", size: 0 });
    } else free.push(t);
  }
  if (free.length && lead) {
    await acceptCrewLine(lead, "helm", `Task #${done.id} is done, so ${free.map((t) => `#${t.id} (${t.title}${t.role ? `, for the ${t.role}` : ""})`).join(", ")} ${free.length > 1 ? "are" : "is"} ready and unassigned. Assign with task_update, or a crewmate can take it with task_claim.`);
  }
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
  recordHandoff({ ship: shipId, from: b.from, to, kind: "message", size: text.length });
  return { ok: true, message: `Sent to ${to}. Its reply comes back to you as a crew message only if it writes to you; check voyage_status for task reports.` };
}

// ---------------------------------------------------------------- maneuvers

const running = new Map<string, { taskId: number; ship: string }>();

function maneuverLogDir(shipId: string): string {
  return join(fleetInboxRoot(), "ships", shipId, "maneuvers");
}

/**
 * Launch a declared maneuver (lib/maneuvers): the caller's role must be given
 * it (`by`), unless the captain gave a Go (fleet tool maneuver_start), and a
 * locked one never starts. `withGo` comes from the node, never from a crewmate's
 * request body.
 */
export async function crewStartManeuver(shipId: string, b: { from: string; maneuver?: string; adw?: string; prompt?: string }, opts: { withGo?: boolean } = {}): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  const v = await needVoyage(a.ship);
  if ("ok" in v) return v;
  const all = maneuverAvailability(a.ship, a.role);
  const name = String(b.maneuver ?? b.adw ?? "").trim();
  const m = findManeuver(all, name);
  if (!m) {
    const yours = all.filter((x) => x.yours).map((x) => x.name);
    return { ok: false, message: all.length ? `No maneuver ${name || "(none named)"} on ${shipId}. ${yours.length ? `Yours: ${yours.join(", ")}.` : "None is yours to launch."} voyage_status lists them all.` : `${shipId} has no maneuvers; assign the work to a crewmate instead.` };
  }
  const refusal = launchRefusal(m, a.role, Boolean(opts.withGo));
  if (refusal) return { ok: false, message: refusal };
  const prompt = String(b.prompt ?? "").trim();
  if (m.kind === "adw" && prompt.length < 10) return { ok: false, message: "Give the maneuver a full prompt: the intent, the files, and what done means." };
  const runId = randomBytes(4).toString("hex");
  const task = await addTask(shipId, { voyage: v.file, title: `${m.name}: ${(prompt || m.checks.join(" → ")).slice(0, 120)}`, detail: prompt || describeManeuver(m), kind: "maneuver", adwId: runId, status: "working", createdBy: b.from });
  mkdirSync(maneuverLogDir(shipId), { recursive: true });
  recordHandoff({ ship: shipId, from: b.from, to: `maneuver:${m.name}`, kind: "maneuver-start", size: prompt.length });
  if (m.kind === "checks") {
    upsertWorkflow("maneuver", runId, { ship: shipId, taskId: task.id, maneuver: m.name, kind: "checks", by: b.from }, { trace: `maneuver-${runId}` });
    logShipEvent(shipId, b.from, "maneuver", `${m.name} launched (${runId}): ${m.checks.join(" → ")}`, { maneuver: m.name, adwId: runId, task: task.id, trace: `maneuver-${runId}` });
    void runCheckManeuver(a.ship, m, runId, task.id, b.from);
    return { ok: true, message: `Maneuver ${m.name} (${m.checks.join(" → ")}) launched as ${runId} (task #${task.id}). It stops at the first failure. End your turn now (do not wait or sleep): the result arrives as a crew message from the helm.`, adwId: runId, task: task.id };
  }
  const adw = m.adw!;
  const log = join(maneuverLogDir(shipId), `${runId}.log`);
  const fd = openSync(log, "a");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Detached (its own process group): a fleet node restart must not take the maneuver down with it.
    proc = Bun.spawn(["uv", "run", `adws/${adw}.py`, prompt, "--adw-id", runId], { cwd: a.ship.path, stdout: fd, stderr: fd, stdin: "ignore", detached: true });
  } finally {
    // The child has its own copy of the log descriptor; keeping ours leaks one per maneuver.
    closeSync(fd);
  }
  running.set(runId, { taskId: task.id, ship: shipId });
  // A journal workflow, so a restarted node can find it again by pid and settle it.
  upsertWorkflow("maneuver", runId, { ship: shipId, taskId: task.id, adw, maneuver: m.name, pid: proc.pid, log, by: b.from }, { trace: `maneuver-${runId}` });
  logShipEvent(shipId, b.from, "maneuver", `${m.name} launched (${runId})`, { adw, maneuver: m.name, adwId: runId, task: task.id, log, trace: `maneuver-${runId}` });
  void proc.exited.then(async (code) => {
    running.delete(runId);
    await settleOnce(a.ship, task.id, runId, code);
  });
  return { ok: true, message: `Maneuver ${m.name} (${adw}) launched as ${runId} (task #${task.id}).${m.gates.length ? ` When it passes, the ${m.gates.join(" and ")} gates run before it counts as done.` : ""} End your turn now (do not wait or sleep): you get a crew message when it finishes; voyage_status shows its phases meanwhile.`, adwId: runId, task: task.id };
}

/**
 * A deterministic maneuver: the ship's checks in order, on the voyage's
 * worktree, stopping at the first failure. Each phase's output is an artifact
 * (fleet/inbox/ships/<ship>/maneuvers/<run>/<n>-<check>.log), and handoff.json
 * is the envelope the next step reads (SSSF shape: phases, verdicts, artifacts).
 */
async function runCheckManeuver(ship: ShipRow, m: ManeuverAvailability, runId: string, taskId: number, by: string): Promise<void> {
  const dir = join(maneuverLogDir(ship.id), runId);
  const started = Date.now();
  const phases: { name: string; ok: boolean; ms: number; artifact: string }[] = [];
  let ok = true;
  let failure = "";
  try {
    await mkdir(dir, { recursive: true });
    const tree = await treeState(gateFolder(ship));
    for (const [i, check] of m.checks.entries()) {
      const t0 = Date.now();
      const res = await runCheck(ship.id, by, check);
      const artifact = join(dir, `${i + 1}-${check}.log`);
      await writeFile(artifact, res.message, "utf8");
      phases.push({ name: check, ok: res.ok, ms: Date.now() - t0, artifact });
      if (!res.ok) {
        ok = false;
        failure = tail(res.message, 3000);
        break;
      }
    }
    if (ok && m.gates.length) {
      for (const stage of m.gates) {
        const g = await runGates(ship, stage, "helm");
        phases.push({ name: `${stage} gates`, ok: g.report.green, ms: 0, artifact: "" });
        if (!g.report.green) {
          ok = false;
          failure = `${describeGates(g.report)}${g.failures ? `\n\n${g.failures}` : ""}`;
          break;
        }
      }
    }
    const envelope = { maneuver: m.name, run: runId, ship: ship.id, task: taskId, by, commit: tree.commit, dirty: tree.dirty, ok, failedAt: ok ? null : (phases.at(-1)?.name ?? null), ms: Date.now() - started, phases, skipped: m.checks.slice(phases.length) };
    await writeFile(join(dir, "handoff.json"), `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    recordRun({ ship: ship.id, agent: by, kind: "maneuver", name: m.name, ok, ms: Date.now() - started, deterministic: true, detail: ok ? `passed: ${phases.map((p) => p.name).join(" → ")}` : `failed at ${envelope.failedAt}`, commit: tree.commit, dirty: tree.dirty });
  } catch (e) {
    ok = false;
    failure = `The maneuver could not run: ${e instanceof Error ? e.message : String(e)}`;
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const note = ok
    ? `Maneuver ${m.name} passed in ${secs}s: ${phases.map((p) => p.name).join(" → ")}. Artifacts: ${dir}`
    : `Maneuver ${m.name} failed${phases.length ? ` at ${phases.at(-1)!.name}` : ""} after ${secs}s. Artifacts: ${dir}\n\n${failure}`;
  await finishManeuverTask(ship, taskId, runId, ok, note, by);
  updateWorkflow(runId, { status: ok ? "done" : "failed" });
}

/** Settle a maneuver's task and tell whoever launched it, the lead, and Alice. */
async function finishManeuverTask(ship: ShipRow, taskId: number, runId: string, ok: boolean, note: string, by: string, actor = "helm"): Promise<void> {
  const settled = await updateTask(ship.id, taskId, { status: ok ? "done" : "blocked", note, by: actor });
  recordHandoff({ ship: ship.id, from: actor, to: by, kind: ok ? "maneuver-done" : "maneuver-failed", size: note.length });
  if (ok && settled) await releaseDependents(ship, settled);
  for (const who of new Set([by, leadOf(ship)].filter((x): x is string => Boolean(x) && crewIds(ship).includes(x!)))) {
    await acceptCrewLine(who, actor, `Maneuver ${runId} (task #${taskId}) ${ok ? "finished" : "failed"}. ${note}`);
  }
  // Alice keeps the fleet picture: the event router wakes her with this (batched).
  await postBus("alice", { from: actor, kind: ok ? "maneuver-finished" : "maneuver-failed", ship: ship.id, summary: `Maneuver ${runId} (task #${taskId}) on ${ship.id} ${ok ? "finished" : "failed"}. ${note}`.slice(0, 400), ref: runId });
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
  let ok = exitCode === 0 && !failed && run?.status !== "fail";
  let note = ok
    ? `Maneuver passed${run ? `: ${run.phases.map((p) => p.name).join(" → ")}` : ""}.`
    : `Maneuver failed${failed ? ` at ${failed.name}${failed.error ? `: ${failed.error.slice(0, 300)}` : ""}` : exitCode !== null ? ` (exit ${exitCode})` : ""}. Log: fleet/inbox/ships/${ship.id}/maneuvers/${adwId}.log`;
  const w = getWorkflow(adwId)?.data as { maneuver?: string; by?: string } | undefined;
  const decl = w?.maneuver ? findManeuver(maneuverAvailability(ship, "lead"), w.maneuver) : undefined;
  // Success is earned: a maneuver that declares gates passes only when they do.
  if (ok && decl?.gates.length) {
    for (const stage of decl.gates) {
      const g = await runGates(ship, stage, "helm");
      if (!g.report.green) {
        ok = false;
        note = `The ADW passed, but its gates did not: ${describeGates(g.report)}${g.failures ? `\n\n${g.failures}` : ""}`;
        break;
      }
    }
    if (ok) note += ` Gates green: ${decl.gates.join(", ")}.`;
  }
  recordRun({ ship: ship.id, agent: w?.by ?? `${ship.id}-lead`, kind: "maneuver", name: w?.maneuver ?? run?.adwName ?? "adw", ok, ms: run?.startedAt ? Date.now() - Date.parse(run.startedAt) : 0, cost: run?.cost ?? 0, deterministic: false, detail: note.slice(0, 300) });
  await finishManeuverTask(ship, taskId, adwId, ok, note, w?.by ?? `${ship.id}-lead`, "sssf");
}

/** After a dashboard restart the exit callback is gone; settle from the trace db. */
/** Settle at most once (the exit handler and a restarted node's watcher can both get here). */
async function settleOnce(ship: ShipRow, taskId: number, adwId: string, exitCode: number | null): Promise<void> {
  await once(adwId, "settle", async () => {
    await settleManeuver(ship, taskId, adwId, exitCode);
    return { exitCode };
  });
  updateWorkflow(adwId, { status: exitCode === 0 ? "done" : "failed" });
}

/**
 * After a node restart: maneuvers still running are watched by pid until they
 * end; ones that ended while the node was down are settled from their trace.
 */
export async function recoverManeuvers(): Promise<void> {
  const ships = await readShips();
  for (const w of listWorkflows<{ ship: string; taskId: number; pid: number; kind?: string; maneuver?: string; by?: string }>("maneuver", "running")) {
    const ship = ships.find((s) => s.id === w.data.ship);
    if (!ship) {
      updateWorkflow(w.id, { status: "failed", data: { error: "ship no longer registered" } });
      continue;
    }
    // Check maneuvers run inside the node, so a restart ended them: say so and let the crew launch it again.
    if (w.data.kind === "checks") {
      await once(w.id, "settle", async () => {
        await finishManeuverTask(ship, w.data.taskId, w.id, false, `Maneuver ${w.data.maneuver ?? ""} was interrupted by a fleet node restart. Launch it again.`, w.data.by ?? `${ship.id}-lead`);
        return { interrupted: true };
      });
      updateWorkflow(w.id, { status: "failed" });
      continue;
    }
    running.set(w.id, { taskId: w.data.taskId, ship: ship.id });
    const settleFromTrace = async () => {
      running.delete(w.id);
      const t = traceStatus(ship.path, w.id);
      const ok = t.status === "pass" || t.status === "ok" || t.status === "done";
      await settleOnce(ship, w.data.taskId, w.id, ok ? 0 : t.ended ? 1 : null);
    };
    if (w.data.pid && pidAlive(w.data.pid)) {
      const timer = setInterval(() => {
        if (pidAlive(w.data.pid)) return;
        clearInterval(timer);
        void settleFromTrace();
      }, 15_000);
    } else await settleFromTrace();
  }
}

async function reconcileManeuvers(ship: ShipRow, v: Voyage): Promise<void> {
  for (const t of listTasks(ship.id, v.file)) {
    if (t.kind !== "maneuver" || t.status !== "working" || !t.adwId || running.has(t.adwId)) continue;
    const s = traceStatus(ship.path, t.adwId);
    if (s.ended) await settleOnce(ship, t.id, t.adwId, s.status === "pass" || s.status === "ok" || s.status === "done" ? 0 : 1);
  }
}

/**
 * The lead asks for a role that is not aboard (a builder for code, say). It
 * becomes a Go request for the captain (crew_change add, with the lead's
 * reason); on Go the role comes aboard and the lead is told.
 */
export async function crewRequestRole(shipId: string, b: { from: string; role?: string; why?: string }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  if (a.role !== "lead") return { ok: false, message: "Only the ship's lead requests crew. Message the lead with crew_message instead." };
  const role = String(b.role ?? "").trim();
  const { crewRoles } = await import("./shipyard.ts");
  const roles = (await crewRoles()).map((r) => r.id);
  if (!roles.includes(role)) return { ok: false, message: `${role || "That"} is not a crew role. Roles: ${roles.join(", ")}.` };
  if (a.ship.crew.includes(role)) return { ok: false, message: `A ${role} is already aboard: ${shipId}-${role}.` };
  const why = String(b.why ?? "").trim();
  if (why.length < 8) return { ok: false, message: "Say why the voyage needs this role (one sentence the captain reads with the request)." };
  const { requestGo } = await import("./fleet-api.ts");
  return requestGo(b.from, "crew_change", { ship: shipId, add: role }, why);
}

/** The lead asks to dock the voyage (with its summary): a Go request for the captain, never a direct API call. */
export async function crewDockRequest(shipId: string, b: { from: string; summary?: string }): Promise<Res> {
  const a = await aboard(shipId, b.from);
  if ("error" in a) return a.error;
  if (a.role !== "lead") return { ok: false, message: "Only the ship's lead asks to dock. Message the lead with crew_message instead." };
  const v = await needVoyage(a.ship);
  if ("ok" in v) return v;
  const summary = String(b.summary ?? "").trim().replace(/\s+/g, " ").slice(0, 600);
  if (summary.length < 10) return { ok: false, message: "Give the dock a summary: what the voyage delivered and how it was checked." };
  const { requestGo } = await import("./fleet-api.ts");
  return requestGo(b.from, "voyage_dock", { ship: shipId, summary });
}
