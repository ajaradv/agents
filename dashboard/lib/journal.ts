import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nodeStateDir } from "./paths.ts";

/**
 * The fleet journal (resilient fleet runtime, R2): durable state for the
 * node's long-running work, so a restart resumes instead of forgetting.
 *
 * - workflows: one row per order run, Go request, or maneuver, with its
 *   status, a trace id, and its data.
 * - steps: checkpoints inside a workflow, keyed per side effect. A step marked
 *   done is never run again (its stored result is returned); a step marked
 *   started but never finished was cut off by a crash and is "uncertain": safe
 *   to redo when it only reads, a decision for the captain when it acts.
 * - events: an append-only log with the trace id, for following one piece of
 *   work across the fleet.
 *
 * SQLite in WAL mode at fleet/inbox/.node/journal.db: the node writes, the
 * dashboard may read. A small, right-sized take on the durable-workflow
 * pattern; Pi Durable can replace or extend it once it is released.
 */

export type WorkflowKind = "order" | "go" | "maneuver" | "delegation" | "gate";
export type WorkflowStatus = "waiting" | "running" | "done" | "failed" | "cancelled";
export type Workflow<T = Record<string, unknown>> = { id: string; kind: WorkflowKind; status: WorkflowStatus; trace: string; data: T; created: string; updated: string };
export type Step = { workflow: string; key: string; status: "started" | "done" | "failed"; result: unknown; started: string; ended: string | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, trace TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflows_kind ON workflows(kind, status);
CREATE TABLE IF NOT EXISTS steps (
  workflow TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT,
  started TEXT NOT NULL, ended TEXT, PRIMARY KEY (workflow, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, trace TEXT NOT NULL,
  workflow TEXT, kind TEXT NOT NULL, data_json TEXT
);
CREATE INDEX IF NOT EXISTS events_trace ON events(trace, id);
`;

let db: Database | null = null;
let dbPath = "";

function open(): Database {
  const path = join(nodeStateDir(), "journal.db");
  if (db && dbPath === path) return db;
  mkdirSync(nodeStateDir(), { recursive: true });
  db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  dbPath = path;
  return db;
}

const now = () => new Date().toISOString();

type Row = { id: string; kind: string; status: string; trace: string; data_json: string; created: string; updated: string };
const toWorkflow = (r: Row): Workflow => ({ id: r.id, kind: r.kind as WorkflowKind, status: r.status as WorkflowStatus, trace: r.trace, data: JSON.parse(r.data_json || "{}"), created: r.created, updated: r.updated });

/** Create a workflow, or return it unchanged when it already exists (idempotent by id). */
export function upsertWorkflow<T extends Record<string, unknown>>(kind: WorkflowKind, id: string, data: T, opts: { status?: WorkflowStatus; trace?: string } = {}): Workflow<T> {
  const d = open();
  const existing = d.query("SELECT * FROM workflows WHERE id = ?").get(id) as Row | null;
  if (existing) return toWorkflow(existing) as Workflow<T>;
  const t = now();
  const trace = opts.trace ?? id;
  d.query("INSERT INTO workflows (id, kind, status, trace, data_json, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, kind, opts.status ?? "running", trace, JSON.stringify(data), t, t);
  journalEvent(trace, `${kind}-created`, { id }, id);
  return { id, kind, status: opts.status ?? "running", trace, data, created: t, updated: t };
}

export function getWorkflow<T = Record<string, unknown>>(id: string): Workflow<T> | null {
  const r = open().query("SELECT * FROM workflows WHERE id = ?").get(id) as Row | null;
  return r ? (toWorkflow(r) as Workflow<T>) : null;
}

export function listWorkflows<T = Record<string, unknown>>(kind: WorkflowKind, status?: WorkflowStatus): Workflow<T>[] {
  const d = open();
  const rows = (status ? d.query("SELECT * FROM workflows WHERE kind = ? AND status = ? ORDER BY created").all(kind, status) : d.query("SELECT * FROM workflows WHERE kind = ? ORDER BY created").all(kind)) as Row[];
  return rows.map((r) => toWorkflow(r) as Workflow<T>);
}

/** Change a workflow's status and merge fields into its data. */
export function updateWorkflow(id: string, patch: { status?: WorkflowStatus; data?: Record<string, unknown> }): Workflow | null {
  const w = getWorkflow(id);
  if (!w) return null;
  const data = patch.data ? { ...w.data, ...patch.data } : w.data;
  const status = patch.status ?? w.status;
  open().query("UPDATE workflows SET status = ?, data_json = ?, updated = ? WHERE id = ?").run(status, JSON.stringify(data), now(), id);
  if (patch.status && patch.status !== w.status) journalEvent(w.trace, `${w.kind}-${patch.status}`, { id }, id);
  return { ...w, status, data };
}

/** Start a fresh run of a workflow: drop its old steps (an order retried from scratch, for example). */
export function resetSteps(workflow: string, keepBelow?: (key: string) => boolean): void {
  const d = open();
  for (const s of steps(workflow)) if (!keepBelow || !keepBelow(s.key)) d.query("DELETE FROM steps WHERE workflow = ? AND key = ?").run(workflow, s.key);
}

export function steps(workflow: string): Step[] {
  return (open().query("SELECT * FROM steps WHERE workflow = ? ORDER BY started").all(workflow) as { workflow: string; key: string; status: string; result_json: string | null; started: string; ended: string | null }[]).map((r) => ({
    workflow: r.workflow,
    key: r.key,
    status: r.status as Step["status"],
    result: r.result_json ? JSON.parse(r.result_json) : null,
    started: r.started,
    ended: r.ended,
  }));
}

export function step(workflow: string, key: string): Step | null {
  return steps(workflow).find((s) => s.key === key) ?? null;
}

/** Mark a step started (before its side effect). */
export function stepStarted(workflow: string, key: string): void {
  open().query("INSERT INTO steps (workflow, key, status, started) VALUES (?, ?, 'started', ?) ON CONFLICT(workflow, key) DO UPDATE SET status = 'started', started = excluded.started, ended = NULL, result_json = NULL").run(workflow, key, now());
}

/** Mark a step done or failed (after its side effect), with what it returned. */
export function stepFinished(workflow: string, key: string, result: unknown, ok = true): void {
  open().query("UPDATE steps SET status = ?, result_json = ?, ended = ? WHERE workflow = ? AND key = ?").run(ok ? "done" : "failed", JSON.stringify(result ?? null), now(), workflow, key);
}

export type OnceResult<T> = { ran: true; result: T } | { ran: false; result: T } | { ran: false; uncertain: true };

/**
 * Run a side effect at most once per (workflow, key). Already done: returns the
 * stored result without running. Started but never finished (a crash cut it
 * off): returns uncertain, so the caller decides (redo a read, ask about an
 * action). Otherwise runs it between started/done checkpoints.
 */
export async function once<T>(workflow: string, key: string, fn: () => Promise<T>, ok: (r: T) => boolean = () => true): Promise<OnceResult<T>> {
  const s = step(workflow, key);
  if (s?.status === "done") return { ran: false, result: s.result as T };
  if (s?.status === "started") return { ran: false, uncertain: true };
  stepStarted(workflow, key);
  const result = await fn();
  stepFinished(workflow, key, result, ok(result));
  return { ran: true, result };
}

export function journalEvent(trace: string, kind: string, data: Record<string, unknown> = {}, workflow?: string): void {
  try {
    open().query("INSERT INTO events (ts, trace, workflow, kind, data_json) VALUES (?, ?, ?, ?, ?)").run(now(), trace, workflow ?? null, kind, JSON.stringify(data));
  } catch {
    /* the journal is best effort for events; workflows and steps throw */
  }
}

export function traceEvents(trace: string): { ts: string; kind: string; workflow: string | null; data: Record<string, unknown> }[] {
  return (open().query("SELECT ts, kind, workflow, data_json FROM events WHERE trace = ? ORDER BY id").all(trace) as { ts: string; kind: string; workflow: string | null; data_json: string }[]).map((r) => ({ ts: r.ts, kind: r.kind, workflow: r.workflow, data: JSON.parse(r.data_json || "{}") }));
}

/** The journal's database, for neighbours that keep their own tables in it (lib/notify.ts). */
export function journalDb(): Database {
  return open();
}

/** For tests: forget the open handle (a new FLEET_INBOX opens a new file). */
export function _closeJournal(): void {
  db?.close();
  db = null;
  dbPath = "";
}
