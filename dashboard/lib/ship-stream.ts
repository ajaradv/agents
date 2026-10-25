import { existsSync } from "node:fs";
import { readShips } from "./fleet-layers.ts";
import { OFFICER_SHIP } from "./ship-events.ts";
import { shipDb, shipLogPath, type ShipEvent } from "./ship-log.ts";

/**
 * One event stream over every ship's log (S3c, vault s3-fleet-state-api):
 * GET /v1/ship-events on the node. Each ship's log is its own table with its
 * own ids, so the stream's position is a cursor of the last id seen per ship
 * ("fleet:1720,kinwork:650"), sent as each event's SSE id: a client that drops
 * resumes with Last-Event-ID and misses nothing. The ship log is already the
 * fleet's event log; this makes it readable without the hub's disk.
 */

export type Cursor = Record<string, number>;
export type StreamEvent = ShipEvent & { ship: string };

const SHIP = /^[a-z][a-z0-9_-]{0,40}$/;

export function encodeCursor(c: Cursor): string {
  return Object.entries(c)
    .filter(([, id]) => id > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, id]) => `${s}:${id}`)
    .join(",");
}

export function decodeCursor(raw: string): Cursor {
  const c: Cursor = {};
  for (const part of raw.split(",")) {
    const m = part.trim().match(/^([a-z][a-z0-9_-]{0,40}):(\d{1,12})$/);
    if (m) c[m[1]!] = Number(m[2]);
  }
  return c;
}

/** The ships the stream covers: every ship, plus the officers' log; `only` narrows it. */
export async function streamShips(only?: string[]): Promise<string[]> {
  const all = [...new Set((await readShips()).map((s) => s.id).concat(OFFICER_SHIP))].sort();
  return only?.length ? all.filter((s) => only.includes(s)) : all;
}

/** Each ship's newest id: where a client that wants only new events starts. */
export function cursorAtEnd(ships: string[], root?: string): Cursor {
  const c: Cursor = {};
  for (const s of ships) {
    if (!SHIP.test(s) || !existsSync(shipLogPath(s, root))) continue;
    const row = shipDb(s, root)?.query("SELECT MAX(id) AS id FROM events").get() as { id: number | null } | undefined;
    c[s] = row?.id ?? 0;
  }
  return c;
}

/** Events after the cursor across the ships, oldest first (by time, then ship), at most `limit`; the cursor moves past them. */
export function eventsAfter(cursor: Cursor, ships: string[], limit = 200, root?: string): { events: StreamEvent[]; cursor: Cursor } {
  const out: StreamEvent[] = [];
  for (const s of ships) {
    if (!SHIP.test(s) || !existsSync(shipLogPath(s, root))) continue;
    const rows = shipDb(s, root)!
      .query("SELECT id, ts, actor, kind, summary, payload_json FROM events WHERE id > ? ORDER BY id LIMIT ?")
      .all(cursor[s] ?? 0, limit) as { id: number; ts: string; actor: string; kind: string; summary: string; payload_json: string | null }[];
    for (const r of rows) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null;
      } catch {
        /* a bad row keeps its place in the stream */
      }
      out.push({ ship: s, id: r.id, ts: r.ts, actor: r.actor, kind: r.kind, summary: r.summary, payload });
    }
  }
  out.sort((a, b) => a.ts.localeCompare(b.ts) || a.ship.localeCompare(b.ship) || a.id - b.id);
  const events = out.slice(0, limit);
  // Past what was sent only: a ship whose later rows were cut stays where its last sent row was.
  const next: Cursor = { ...cursor };
  for (const e of events) next[e.ship] = Math.max(next[e.ship] ?? 0, e.id);
  return { events, cursor: next };
}

/** One SSE frame: the event, with the cursor after it as its id. */
export function sseFrame(e: StreamEvent, after: Cursor): string {
  return `id: ${encodeCursor(after)}\nevent: ship-event\ndata: ${JSON.stringify(e)}\n\n`;
}
