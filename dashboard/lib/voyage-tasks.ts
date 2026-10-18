import { appendFile } from "node:fs/promises";
import { shipDb, logShipEvent } from "./ship-log.ts";

/**
 * A voyage's task list, kept in the ship's database (tasks table) and echoed
 * into the voyage note's Log so the vault record shows what happened.
 * The lead adds and assigns tasks; crewmates report on theirs.
 *
 * Dependencies (borrowed from beads, vault research note axi-evaluation): a
 * task may wait on others (`blockedBy`). It is ready when it is open and every
 * task it waits on is done; a crewmate can claim a ready task in one step.
 */

export type TaskStatus = "open" | "working" | "done" | "blocked";
export const TASK_STATUSES: TaskStatus[] = ["open", "working", "done", "blocked"];

export type VoyageTask = {
  id: number;
  voyage: string;
  title: string;
  detail: string;
  assignee: string | null;
  kind: "crew" | "maneuver";
  adwId: string | null;
  status: TaskStatus;
  note: string;
  /** Task ids this one waits on (same voyage). */
  blockedBy: number[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: number; voyage: string; title: string; detail: string; assignee: string | null; kind: string; adw_id: string | null;
  status: string; note: string; blocked_by: string | null; created_by: string; created_at: string; updated_at: string;
};

export function parseIds(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,#]+/);
  return [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}

function toTask(r: Row): VoyageTask {
  return {
    id: r.id, voyage: r.voyage, title: r.title, detail: r.detail, assignee: r.assignee,
    kind: r.kind === "maneuver" ? "maneuver" : "crew", adwId: r.adw_id,
    status: (TASK_STATUSES as string[]).includes(r.status) ? (r.status as TaskStatus) : "open",
    note: r.note, blockedBy: parseIds(r.blocked_by), createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function echo(voyageFile: string, text: string): Promise<void> {
  try {
    await appendFile(voyageFile, `- ${new Date().toISOString()} ${text.replace(/\s+/g, " ").slice(0, 400)}\n`, "utf8");
  } catch {
    /* the voyage note moved; the ship's db still has it */
  }
}

export function listTasks(ship: string, voyage: string, opts: { root?: string } = {}): VoyageTask[] {
  const db = shipDb(ship, opts.root);
  if (!db) return [];
  return (db.query("SELECT * FROM tasks WHERE voyage = ? ORDER BY id").all(voyage) as Row[]).map(toTask);
}

export function getTask(ship: string, id: number, opts: { root?: string } = {}): VoyageTask | null {
  const r = shipDb(ship, opts.root)?.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row | null | undefined;
  return r ? toTask(r) : null;
}

export async function addTask(
  ship: string,
  t: { voyage: string; title: string; detail?: string; assignee?: string | null; kind?: "crew" | "maneuver"; adwId?: string | null; status?: TaskStatus; blockedBy?: number[]; createdBy: string },
  opts: { root?: string } = {},
): Promise<VoyageTask> {
  const db = shipDb(ship, opts.root);
  if (!db) throw new Error("bad ship");
  const now = new Date().toISOString();
  const r = db
    .query(
      "INSERT INTO tasks (voyage, title, detail, assignee, kind, adw_id, status, blocked_by, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(t.voyage, t.title.slice(0, 200), (t.detail ?? "").slice(0, 4000), t.assignee ?? null, t.kind ?? "crew", t.adwId ?? null, t.status ?? "open", (t.blockedBy ?? []).join(","), t.createdBy, now, now) as Row;
  const task = toTask(r);
  const after = task.blockedBy.length ? ` (after ${task.blockedBy.map((n) => `#${n}`).join(", ")})` : "";
  logShipEvent(ship, t.createdBy, "task", `#${task.id} ${task.title}${task.assignee ? ` → ${task.assignee}` : ""}${after}`, { task: task.id, assignee: task.assignee, kind: task.kind, blockedBy: task.blockedBy }, opts);
  if (!opts.root) await echo(t.voyage, `task #${task.id} added by ${t.createdBy}: ${task.title}${task.assignee ? ` (→ ${task.assignee})` : ""}`);
  return task;
}

export async function updateTask(
  ship: string,
  id: number,
  change: { status?: TaskStatus; note?: string; assignee?: string | null; blockedBy?: number[]; by: string },
  opts: { root?: string } = {},
): Promise<VoyageTask | null> {
  const db = shipDb(ship, opts.root);
  const cur = getTask(ship, id, opts);
  if (!db || !cur) return null;
  const status = change.status ?? cur.status;
  const note = change.note !== undefined ? change.note.slice(0, 4000) : cur.note;
  const assignee = change.assignee !== undefined ? change.assignee : cur.assignee;
  const blockedBy = change.blockedBy ?? cur.blockedBy;
  db.query("UPDATE tasks SET status = ?, note = ?, assignee = ?, blocked_by = ?, updated_at = ? WHERE id = ?").run(status, note, assignee, blockedBy.join(","), new Date().toISOString(), id);
  const summary = `#${id} ${cur.title}: ${status}${change.note ? ` — ${change.note}` : ""}`;
  logShipEvent(ship, change.by, "task", summary, { task: id, status }, opts);
  if (!opts.root) await echo(cur.voyage, `task #${id} ${status} (${change.by})${change.note ? `: ${change.note}` : ""}`);
  return getTask(ship, id, opts);
}

export function taskProgress(tasks: VoyageTask[]): { done: number; total: number; blocked: number } {
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length, blocked: tasks.filter((t) => t.status === "blocked").length };
}

/** The tasks `t` still waits on: those it names that are not done (a missing task counts as done). */
export function waitingOn(t: VoyageTask, all: VoyageTask[]): number[] {
  return t.blockedBy.filter((id) => {
    const b = all.find((x) => x.id === id);
    return b !== undefined && b.status !== "done";
  });
}

/** Open tasks with nothing left to wait on. */
export function readyTasks(all: VoyageTask[]): VoyageTask[] {
  return all.filter((t) => t.status === "open" && waitingOn(t, all).length === 0);
}

/**
 * Why `blockedBy` cannot be set on task `self` (null when it can): every id
 * must be another task of the same voyage, and no chain may lead back to it.
 */
export function blockersRefusal(all: VoyageTask[], blockedBy: number[], self?: number): string | null {
  for (const id of blockedBy) {
    if (id === self) return `Task #${id} cannot wait on itself.`;
    if (!all.some((t) => t.id === id)) return `There is no task #${id} on this voyage.`;
  }
  if (self === undefined) return null;
  // Would any blocker (transitively) wait on `self`?
  const seen = new Set<number>();
  const stack = [...blockedBy];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === self) return `That makes a loop: task #${self} would end up waiting on itself.`;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(all.find((t) => t.id === id)?.blockedBy ?? []));
  }
  return null;
}

/**
 * Claim a task in one step: it becomes `who`'s and working, only if it is open,
 * unassigned or already `who`'s, and waits on nothing. The check and the write
 * are one transaction, so two crewmates cannot both claim it.
 */
export async function claimTask(ship: string, id: number, who: string, opts: { root?: string } = {}): Promise<{ task: VoyageTask } | { refusal: string }> {
  const db = shipDb(ship, opts.root);
  if (!db) return { refusal: "bad ship" };
  const result = db.transaction((): { task: VoyageTask } | { refusal: string } => {
    const t = getTask(ship, id, opts);
    if (!t) return { refusal: `No task #${id}.` };
    if (t.assignee && t.assignee !== who) return { refusal: `Task #${id} is ${t.assignee}'s.` };
    if (t.status !== "open") return { refusal: `Task #${id} is ${t.status}, not open.` };
    const waits = waitingOn(t, listTasks(ship, t.voyage, opts));
    if (waits.length) return { refusal: `Task #${id} still waits on ${waits.map((n) => `#${n}`).join(", ")}.` };
    db.query("UPDATE tasks SET assignee = ?, status = 'working', updated_at = ? WHERE id = ?").run(who, new Date().toISOString(), id);
    return { task: getTask(ship, id, opts)! };
  })();
  if ("task" in result) {
    logShipEvent(ship, who, "task", `#${id} ${result.task.title}: claimed by ${who}`, { task: id, status: "working" }, opts);
    if (!opts.root) await echo(result.task.voyage, `task #${id} claimed by ${who}`);
  }
  return result;
}

/** Tasks of the voyage that waited on `doneId` and now wait on nothing. */
export function unblockedBy(ship: string, voyage: string, doneId: number, opts: { root?: string } = {}): VoyageTask[] {
  const all = listTasks(ship, voyage, opts);
  return all.filter((t) => t.status === "open" && t.blockedBy.includes(doneId) && waitingOn(t, all).length === 0);
}
