import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

/**
 * The ship's log: one append-only SQLite file per ship at
 * fleet/inbox/ships/<ship>/ship.db (WAL, like SSSF's sssf.db), written by the
 * dashboard server as crewmates work. It exists so "where did it break?" has an
 * answer that does not live in a process's memory.
 *
 * kinds: chat-in (captain → crew), chat-out (crew → captain), question,
 * answer, turn-start, turn-end (ms, cost, tokens, error), tool, notice, canvas.
 */

export type ShipEvent = {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown> | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  payload_json  TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_actor ON events(actor, ts);
`;

const SHIP_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const dbs = new Map<string, Database>();
let onWrite: (ship: string) => void = () => {};

/** Told after every write (the server turns it into an SSE "ship" event). */
export function onShipLogWrite(fn: (ship: string) => void): void {
  onWrite = fn;
}

export function shipLogPath(ship: string, root = fleetInboxRoot()): string {
  return join(root, "ships", ship, "ship.db");
}

function open(ship: string, root?: string): Database | null {
  if (!SHIP_RE.test(ship)) return null;
  const key = `${root ?? ""}\u0000${ship}`;
  let db = dbs.get(key);
  if (!db) {
    const path = shipLogPath(ship, root);
    mkdirSync(join(path, ".."), { recursive: true });
    db = new Database(path, { create: true });
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    dbs.set(key, db);
  }
  return db;
}

export function logShipEvent(
  ship: string,
  actor: string,
  kind: string,
  summary: string,
  payload?: Record<string, unknown> | null,
  opts: { root?: string; ts?: string } = {},
): void {
  try {
    open(ship, opts.root)
      ?.query("INSERT INTO events (ts, actor, kind, summary, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run(opts.ts ?? new Date().toISOString(), actor, kind, summary.slice(0, 2000), payload ? JSON.stringify(payload) : null);
    if (!opts.root) onWrite(ship);
  } catch (e) {
    console.error("[dashboard] ship log:", e);
  }
}

/** Newest first. */
export function recentShipEvents(ship: string, limit = 80, opts: { root?: string; actor?: string } = {}): ShipEvent[] {
  try {
    const db = open(ship, opts.root);
    if (!db) return [];
    const rows = (
      opts.actor
        ? db.query("SELECT * FROM events WHERE actor = ? ORDER BY id DESC LIMIT ?").all(opts.actor, limit)
        : db.query("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit)
    ) as { id: number; ts: string; actor: string; kind: string; summary: string; payload_json: string | null }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      kind: r.kind,
      summary: r.summary,
      payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null,
    }));
  } catch {
    return [];
  }
}

/** Turn totals per crewmate since `sinceIso`: turns, cost, tokens, errors. */
export function shipTurnTotals(
  ship: string,
  sinceIso: string,
  opts: { root?: string } = {},
): Record<string, { turns: number; cost: number; tokens: number; errors: number }> {
  const out: Record<string, { turns: number; cost: number; tokens: number; errors: number }> = {};
  try {
    const db = open(ship, opts.root);
    if (!db) return out;
    const rows = db
      .query("SELECT actor, payload_json FROM events WHERE kind = 'turn-end' AND ts >= ?")
      .all(sinceIso) as { actor: string; payload_json: string | null }[];
    for (const r of rows) {
      const p = (r.payload_json ? JSON.parse(r.payload_json) : {}) as { cost?: number; tokens?: number; error?: string };
      const t = (out[r.actor] ??= { turns: 0, cost: 0, tokens: 0, errors: 0 });
      t.turns += 1;
      t.cost += p.cost ?? 0;
      t.tokens += p.tokens ?? 0;
      if (p.error) t.errors += 1;
    }
  } catch {
    /* empty */
  }
  return out;
}
