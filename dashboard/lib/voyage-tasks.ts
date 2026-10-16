import { appendFile } from "node:fs/promises";
import { shipDb, logShipEvent } from "./ship-log.ts";

/**
 * A voyage's task list, kept in the ship's database (tasks table) and echoed
 * into the voyage note's Log so the vault record shows what happened.
 * The lead adds and assigns tasks; crewmates report on theirs.
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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: number; voyage: string; title: string; detail: string; assignee: string | null; kind: string; adw_id: string | null;
  status: string; note: string; created_by: string; created_at: string; updated_at: string;
};

function toTask(r: Row): VoyageTask {
  return {
    id: r.id, voyage: r.voyage, title: r.title, detail: r.detail, assignee: r.assignee,
    kind: r.kind === "maneuver" ? "maneuver" : "crew", adwId: r.adw_id,
    status: (TASK_STATUSES as string[]).includes(r.status) ? (r.status as TaskStatus) : "open",
    note: r.note, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
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
  t: { voyage: string; title: string; detail?: string; assignee?: string | null; kind?: "crew" | "maneuver"; adwId?: string | null; status?: TaskStatus; createdBy: string },
  opts: { root?: string } = {},
): Promise<VoyageTask> {
  const db = shipDb(ship, opts.root);
  if (!db) throw new Error("bad ship");
  const now = new Date().toISOString();
  const r = db
    .query(
      "INSERT INTO tasks (voyage, title, detail, assignee, kind, adw_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(t.voyage, t.title.slice(0, 200), (t.detail ?? "").slice(0, 4000), t.assignee ?? null, t.kind ?? "crew", t.adwId ?? null, t.status ?? "open", t.createdBy, now, now) as Row;
  const task = toTask(r);
  logShipEvent(ship, t.createdBy, "task", `#${task.id} ${task.title}${task.assignee ? ` → ${task.assignee}` : ""}`, { task: task.id, assignee: task.assignee, kind: task.kind }, opts);
  if (!opts.root) await echo(t.voyage, `task #${task.id} added by ${t.createdBy}: ${task.title}${task.assignee ? ` (→ ${task.assignee})` : ""}`);
  return task;
}

export async function updateTask(
  ship: string,
  id: number,
  change: { status?: TaskStatus; note?: string; assignee?: string | null; by: string },
  opts: { root?: string } = {},
): Promise<VoyageTask | null> {
  const db = shipDb(ship, opts.root);
  const cur = getTask(ship, id, opts);
  if (!db || !cur) return null;
  const status = change.status ?? cur.status;
  const note = change.note !== undefined ? change.note.slice(0, 4000) : cur.note;
  const assignee = change.assignee !== undefined ? change.assignee : cur.assignee;
  db.query("UPDATE tasks SET status = ?, note = ?, assignee = ?, updated_at = ? WHERE id = ?").run(status, note, assignee, new Date().toISOString(), id);
  const summary = `#${id} ${cur.title}: ${status}${change.note ? ` — ${change.note}` : ""}`;
  logShipEvent(ship, change.by, "task", summary, { task: id, status }, opts);
  if (!opts.root) await echo(cur.voyage, `task #${id} ${status} (${change.by})${change.note ? `: ${change.note}` : ""}`);
  return getTask(ship, id, opts);
}

export function taskProgress(tasks: VoyageTask[]): { done: number; total: number; blocked: number } {
  return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length, blocked: tasks.filter((t) => t.status === "blocked").length };
}
