import { readShips } from "./fleet-layers.ts";
import { ingestMetrics } from "./metrics.ts";
import { tokenMatches } from "./node-auth.ts";
import { readSecret } from "./secret-store.ts";
import { insertShipEvents } from "./ship-log.ts";
import { validEventKey } from "./ulid.ts";
import { voyageWorktree } from "./voyage-worktree.ts";
import { INGEST_SOURCE } from "./worker-host.ts";

/**
 * POST /v1/ingest on the node: what a worker (the laptop, a voyage VM) recorded
 * while the hub could not hear it. Every event carries an event_key, and a key
 * the hub already has adds nothing, so a worker may send a batch again and
 * again until it is told it arrived (lib/outbox.ts).
 *
 * Body { source, events: [{ table, event_key, data }] }, at most 500 events and
 * 1 MB. Answer { accepted, duplicates, rejected: [{ event_key, reason }] }; a
 * rejected event was invalid and will never succeed, the rest of the batch
 * stands. Tables: runs, turns, handoffs (lib/metrics.ts) and ship_events (a
 * ship's log, lib/ship-log.ts). `data` uses the table's column names; the hub
 * derives the rest (project_id, role, mode, the voyage under sail).
 *
 * Auth: the node token, or the worker's own ingest token (hub secret
 * ingest-<source>) in X-Fleet-Ingest-Token, which opens this route and no other.
 */

export const INGEST_LIMITS = { events: 500, bytes: 1_000_000 } as const;
export const INGEST_TABLES = ["runs", "turns", "handoffs", "ship_events"] as const;
export type IngestTable = (typeof INGEST_TABLES)[number];
export type IngestEvent = { table: IngestTable; event_key: string; data: Record<string, unknown> };
export type IngestResult = { accepted: number; duplicates: number; rejected: { event_key: string; reason: string }[] };

type ColType = "text" | "bool" | "int" | "real" | "json";
type Col = { type: ColType; required?: boolean; max?: number; oneOf?: readonly string[] };

/** The columns a worker may set, by table. Everything else is derived here or refused. */
const COLUMNS: Record<IngestTable, Record<string, Col>> = {
  runs: {
    ship: { type: "text", required: true, max: 64 },
    agent: { type: "text", required: true, max: 120 },
    kind: { type: "text", required: true, oneOf: ["check", "maneuver"] },
    name: { type: "text", required: true, max: 120 },
    ok: { type: "bool", required: true },
    ms: { type: "int", required: true },
    cost: { type: "real" },
    deterministic: { type: "bool" },
    detail: { type: "text", max: 300 },
    commit_sha: { type: "text", max: 64 },
    dirty: { type: "bool" },
    ts: { type: "text", max: 40 },
  },
  turns: {
    agent: { type: "text", required: true, max: 120 },
    ship: { type: "text", max: 64 },
    model: { type: "text", max: 200 },
    ok: { type: "bool", required: true },
    ms: { type: "int", required: true },
    cost: { type: "real" },
    tokens: { type: "int" },
    cache_read: { type: "int" },
    prompt: { type: "int" },
    error: { type: "text", max: 300 },
    ts: { type: "text", max: 40 },
  },
  handoffs: {
    ship: { type: "text", required: true, max: 64 },
    from_agent: { type: "text", required: true, max: 120 },
    to_agent: { type: "text", max: 120 },
    kind: { type: "text", required: true, max: 60 },
    size: { type: "int" },
    ts: { type: "text", max: 40 },
  },
  ship_events: {
    ship: { type: "text", required: true, max: 64 },
    actor: { type: "text", required: true, max: 120 },
    kind: { type: "text", required: true, max: 60 },
    summary: { type: "text", max: 2000 },
    payload: { type: "json" },
    ts: { type: "text", max: 40 },
  },
};

type Row = Record<string, string | number | boolean | Record<string, unknown> | null>;

/** The checked, trimmed columns of an event, or why it cannot be taken. */
function checkData(table: IngestTable, data: unknown): { row: Row } | { reason: string } {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { reason: "data must be an object" };
  const cols = COLUMNS[table];
  const d = data as Record<string, unknown>;
  for (const k of Object.keys(d)) if (!cols[k]) return { reason: `unknown column ${k} for ${table}` };
  const row: Row = {};
  for (const [name, col] of Object.entries(cols)) {
    const v = d[name];
    if (v === undefined || v === null) {
      if (col.required) return { reason: `${name} is required` };
      continue;
    }
    switch (col.type) {
      case "text":
        if (typeof v !== "string") return { reason: `${name} must be text` };
        if (col.oneOf && !col.oneOf.includes(v)) return { reason: `${name} must be one of ${col.oneOf.join(", ")}` };
        if (col.required && !v) return { reason: `${name} is required` };
        row[name] = col.max ? v.slice(0, col.max) : v;
        break;
      case "bool":
        if (typeof v === "boolean") row[name] = v;
        else if (v === 0 || v === 1) row[name] = v === 1;
        else return { reason: `${name} must be true or false` };
        break;
      case "int":
      case "real":
        if (typeof v !== "number" || !Number.isFinite(v)) return { reason: `${name} must be a number` };
        if (col.type === "int" && !Number.isInteger(v)) return { reason: `${name} must be a whole number` };
        row[name] = v;
        break;
      case "json":
        if (typeof v !== "object" || Array.isArray(v)) return { reason: `${name} must be an object` };
        row[name] = v as Record<string, unknown>;
        break;
    }
  }
  if (typeof row.ts === "string" && !Number.isFinite(Date.parse(row.ts))) return { reason: "ts must be an ISO time" };
  return { row };
}

/** Take a batch: validate each event, write the valid ones (one transaction per table), count the rest. */
export async function ingest(events: IngestEvent[], knownShips?: Set<string>, allowed: Set<string> | null = null): Promise<IngestResult> {
  const ships = knownShips ?? new Set((await readShips()).map((s) => s.id));
  const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [] };
  const reject = (event_key: string, reason: string) => result.rejected.push({ event_key, reason });
  const now = new Date().toISOString();
  const metrics: Record<"runs" | "turns" | "handoffs", { ts: string; row: never }[]> = { runs: [], turns: [], handoffs: [] };
  const logs = new Map<string, Parameters<typeof insertShipEvents>[1]>();

  for (const e of events) {
    const key = (e as { event_key?: unknown })?.event_key;
    if (!validEventKey(key)) {
      reject(typeof key === "string" ? key.slice(0, 80) : "", "event_key must be 1 to 80 characters of letters, digits, : _ -");
      continue;
    }
    if (!INGEST_TABLES.includes(e.table)) {
      reject(key, `unknown table ${String(e.table)}`);
      continue;
    }
    const checked = checkData(e.table, e.data);
    if ("reason" in checked) {
      reject(key, checked.reason);
      continue;
    }
    const r = checked.row;
    const ship = (r.ship as string | undefined) ?? "";
    // An empty ship is the officers' (project_id flagship); turns only.
    if (!ship && e.table !== "turns") {
      reject(key, "ship is required");
      continue;
    }
    if (ship && !ships.has(ship)) {
      reject(key, `unknown ship ${ship}`);
      continue;
    }
    if (allowed && !allowed.has(ship)) {
      reject(key, ship ? `this worker holds no voyage of ${ship}` : "this worker writes only for its voyage's ship");
      continue;
    }
    const ts = (r.ts as string | undefined) ?? now;
    switch (e.table) {
      case "ship_events": {
        const list = logs.get(ship) ?? [];
        list.push({ eventKey: key, ts, actor: r.actor as string, kind: r.kind as string, summary: (r.summary as string | undefined) ?? "", payload: (r.payload as Record<string, unknown> | undefined) ?? null });
        logs.set(ship, list);
        break;
      }
      case "runs":
        metrics.runs.push({ ts, row: { eventKey: key, ship, agent: r.agent, kind: r.kind, name: r.name, ok: r.ok, ms: r.ms, cost: r.cost, deterministic: r.deterministic, detail: r.detail, commit: r.commit_sha, dirty: r.dirty } as never });
        break;
      case "turns":
        metrics.turns.push({ ts, row: { eventKey: key, agent: r.agent, ship, model: r.model, ok: r.ok, ms: r.ms, cost: r.cost, tokens: r.tokens, cacheRead: r.cache_read, prompt: r.prompt, error: r.error } as never });
        break;
      case "handoffs":
        metrics.handoffs.push({ ts, row: { eventKey: key, ship, from: r.from_agent, to: r.to_agent, kind: r.kind, size: r.size } as never });
        break;
    }
  }

  for (const table of ["runs", "turns", "handoffs"] as const) {
    if (!metrics[table].length) continue;
    const r = ingestMetrics(table, metrics[table]);
    result.accepted += r.accepted;
    result.duplicates += r.duplicates;
  }
  for (const [ship, list] of logs) {
    const added = insertShipEvents(ship, list);
    result.accepted += added;
    result.duplicates += list.length - added;
  }
  return result;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The node token ("node"), or the worker's ingest token for the source the body names ("worker"); null when neither. */
async function authorized(req: Request, nodeToken: string, source: unknown, secret: (name: string) => Promise<string>): Promise<"node" | "worker" | null> {
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (bearer && tokenMatches(bearer, nodeToken)) return "node";
  const presented = req.headers.get("x-fleet-ingest-token") ?? "";
  if (!presented || typeof source !== "string" || !INGEST_SOURCE.test(source)) return null;
  const expected = await secret(`ingest-${source}`);
  return expected.length > 0 && tokenMatches(presented.trim(), expected) ? "worker" : null;
}

/**
 * The ships a worker's ingest token may write for. Runs feed the dock gates, so a voyage VM writes only for
 * the ship whose open voyage it holds; the laptop (the captain's machine) and the node token are not limited.
 */
export function shipsForSource(source: string, ships: string[], vmOf: (ship: string) => string | undefined = (s) => voyageWorktree(s)?.vm): Set<string> | null {
  if (source === "laptop") return null;
  return new Set(ships.filter((s) => vmOf(s) === source));
}

export async function handleIngest(req: Request, deps: { nodeToken: string; secret?: (name: string) => Promise<string>; ships?: Set<string>; allowedShips?: (source: string, ships: string[]) => Set<string> | null }): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!req.headers.get("authorization") && !req.headers.get("x-fleet-ingest-token")) return new Response("unauthorized", { status: 401 });
  if (Number(req.headers.get("content-length") ?? 0) > INGEST_LIMITS.bytes) return json({ error: "batch too large" }, 413);
  const text = await req.text();
  if (Buffer.byteLength(text) > INGEST_LIMITS.bytes) return json({ error: "batch too large" }, 413);
  // A body that is not JSON is refused below, after the caller is known: unauthorized callers learn nothing.
  const b = ((): { source?: unknown; events?: unknown } | null => {
    try {
      return JSON.parse(text) as { source?: unknown; events?: unknown } | null;
    } catch {
      return null;
    }
  })();
  const caller = await authorized(req, deps.nodeToken, b?.source, deps.secret ?? readSecret);
  if (!caller) return new Response("unauthorized", { status: 401 });
  if (!b || typeof b !== "object") return json({ error: "body must be a JSON object" }, 400);
  if (typeof b.source !== "string" || !INGEST_SOURCE.test(b.source)) return json({ error: "source must be laptop or a VM name" }, 400);
  if (!Array.isArray(b.events)) return json({ error: "events must be a list" }, 400);
  if (b.events.length > INGEST_LIMITS.events) return json({ error: `at most ${INGEST_LIMITS.events} events per batch` }, 413);
  const known = deps.ships ?? new Set((await readShips()).map((s) => s.id));
  const allowed = caller === "worker" ? (deps.allowedShips ?? shipsForSource)(b.source, [...known]) : null;
  return json(await ingest(b.events as IngestEvent[], known, allowed));
}
