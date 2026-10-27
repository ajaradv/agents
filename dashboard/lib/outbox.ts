import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, type Migration } from "./db-migrate.ts";
import { nodeStateDir } from "./paths.ts";
import { validEventKey } from "./ulid.ts";

/**
 * A worker's outbox: what it recorded for the hub (a check's result, later a
 * voyage VM's turns and log) waits here, in <inbox>/.node/outbox.db, until the
 * hub's /v1/ingest (lib/ingest.ts) has it. The hub may be down, restarting, or
 * out of reach for a long time; each event keeps its event_key, so sending a
 * batch again is always safe and the hub counts it once.
 *
 * - enqueue: write before answering anyone; a key already queued is ignored.
 * - flush: oldest first, batches of 200. A key the hub accepted or already had
 *   is sent. One it rejected will never succeed: kept for a look, never retried.
 *   A failed send backs off (30 s, doubling, 30 min at most) and stops the flush.
 * - Sent rows stay 7 days (so a late duplicate enqueue is still ignored); the
 *   table holds 20,000 rows at most, the oldest sent ones going first.
 */

export const OUTBOX_TABLES = ["runs", "turns", "handoffs", "ship_events"] as const;
export type OutboxEvent = { table: (typeof OUTBOX_TABLES)[number]; event_key: string; data: Record<string, unknown> };
export type Rejection = { event_key: string; reason: string };
export type IngestPost = (url: string, token: string, body: { source: string; events: OutboxEvent[] }) => Promise<{ status: number; body: unknown }>;

export const BATCH = 200;
export const BACKOFF_FIRST_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
export const KEEP_SENT_MS = 7 * 24 * 3_600_000;
export const MAX_ROWS = 20_000;
/** next_at of a rejected row: never due. */
const NEVER = "9999-12-31T00:00:00.000Z";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    note: "outbox",
    up: `CREATE TABLE outbox (
      event_key TEXT PRIMARY KEY, tbl TEXT NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL, last_error TEXT, sent_at TEXT
    );
    CREATE INDEX outbox_due ON outbox(sent_at, next_at, created);`,
  },
];

let handle: Database | null = null;
let handlePath = "";

export function outboxDb(): Database {
  const path = join(nodeStateDir(), "outbox.db");
  if (handle && handlePath === path) return handle;
  mkdirSync(nodeStateDir(), { recursive: true });
  handle = new Database(path, { create: true });
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  migrate(handle, MIGRATIONS, "outbox.db");
  handlePath = path;
  return handle;
}

/** For tests: a new FLEET_INBOX opens a new file. */
export function _closeOutbox(): void {
  handle?.close();
  handle = null;
  handlePath = "";
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Queue an event for the hub. False when it was refused (a bad key or table) or its key is already queued. */
export function enqueue(e: OutboxEvent, now = Date.now()): boolean {
  if (!validEventKey(e.event_key) || !OUTBOX_TABLES.includes(e.table)) return false;
  const t = iso(now);
  return outboxDb().query("INSERT INTO outbox (event_key, tbl, data, created, next_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING").run(e.event_key, e.table, JSON.stringify(e.data), t, t).changes > 0;
}

/** Events not yet sent that can still succeed (a rejected one cannot). */
export function pendingCount(): number {
  return (outboxDb().query("SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL AND next_at < ?").get(NEVER) as { n: number }).n;
}

export const backoffMs = (attempts: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));

/** Drop what is no longer needed: sent rows past 7 days, dead (rejected) rows past 7 days, then the oldest beyond the cap. */
export function prune(now = Date.now(), max = MAX_ROWS): void {
  const db = outboxDb();
  const cut = iso(now - KEEP_SENT_MS);
  db.query("DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?").run(cut);
  db.query("DELETE FROM outbox WHERE sent_at IS NULL AND next_at = ? AND created < ?").run(NEVER, cut);
  const over = (db.query("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n - max;
  if (over <= 0) return;
  // Sent first, then rejected, then (the hub has been gone for weeks) the oldest waiting.
  db.query("DELETE FROM outbox WHERE event_key IN (SELECT event_key FROM outbox ORDER BY CASE WHEN sent_at IS NOT NULL THEN 0 WHEN next_at = ? THEN 1 ELSE 2 END, COALESCE(sent_at, created) LIMIT ?)").run(NEVER, over);
}

export type FlushResult = { sent: number; rejected: number; failed: boolean; error?: string };

const defaultPost: IngestPost = async (url, token, body) => {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Fleet-Ingest-Token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** Send what is due, oldest first, until none is or a send fails. */
export async function flush(opts: { url: string; token: string; source: string; post?: IngestPost; now?: () => number }): Promise<FlushResult> {
  const db = outboxDb();
  const post = opts.post ?? defaultPost;
  const now = opts.now ?? Date.now;
  const out: FlushResult = { sent: 0, rejected: 0, failed: false };
  try {
    for (;;) {
      const rows = db.query("SELECT event_key, tbl, data, attempts FROM outbox WHERE sent_at IS NULL AND next_at <= ? ORDER BY created, rowid LIMIT ?").all(iso(now()), BATCH) as { event_key: string; tbl: OutboxEvent["table"]; data: string; attempts: number }[];
      if (!rows.length) break;
      let error = "";
      let rejected: Rejection[] = [];
      try {
        const r = await post(opts.url, opts.token, { source: opts.source, events: rows.map((x) => ({ table: x.tbl, event_key: x.event_key, data: JSON.parse(x.data) as Record<string, unknown> })) });
        const b = r.body as { rejected?: unknown } | null;
        if (r.status === 200 && b && Array.isArray(b.rejected)) rejected = b.rejected as Rejection[];
        else error = `the hub answered HTTP ${r.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const t = iso(now());
      if (error) {
        const fail = db.query("UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE event_key = ?");
        db.transaction(() => {
          for (const x of rows) fail.run(iso(now() + backoffMs(x.attempts + 1)), error.slice(0, 300), x.event_key);
        })();
        out.failed = true;
        out.error = error;
        break;
      }
      const dead = new Map(rejected.map((x) => [String(x.event_key), String(x.reason ?? "rejected").slice(0, 300)]));
      const mark = db.query("UPDATE outbox SET sent_at = ?, last_error = NULL WHERE event_key = ?");
      const kill = db.query("UPDATE outbox SET next_at = ?, last_error = ? WHERE event_key = ?");
      db.transaction(() => {
        for (const x of rows) {
          const why = dead.get(x.event_key);
          if (why === undefined) {
            mark.run(t, x.event_key);
            out.sent++;
          } else {
            kill.run(NEVER, why, x.event_key);
            out.rejected++;
          }
        }
      })();
    }
  } finally {
    prune(now());
  }
  return out;
}
