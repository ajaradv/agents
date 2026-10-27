import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { addColumn, migrate, type Migration } from "./db-migrate.ts";
import { nodeStateDir } from "./paths.ts";
import { readShipConfig } from "./ship-config.ts";
import { ulid } from "./ulid.ts";

/**
 * The fleet metrics database (vault research note helm-and-maneuvers): one
 * SQLite file, fleet/inbox/.node/metrics.db (WAL), that records what every
 * voyage cost and how it went, for the voyage ledger and for dashboards.
 *
 * - voyages: one row per voyage (ship, goal, branch, started, docked, commits).
 * - turns: every agent turn (agent, role, ship, voyage, model, mode, time,
 *   cost, tokens, cache reads, error).
 * - runs: every check (and later maneuver) run (name, deterministic, time,
 *   result) with its voyage.
 * - handoffs: crew messages and task changes between crewmates.
 *
 * Every turns, runs, and handoffs row carries event_key (unique; the
 * idempotency key, so a replayed event adds nothing) and project_id (the ship,
 * or "flagship" for the officers, who have no ship).
 *
 * The schema is numbered migrations (MIGRATIONS below; lib/db-migrate.ts).
 *
 * The node and the dashboard both write it (WAL, busy timeout); anything can
 * read it. Views answer the usual questions directly (cost by role and model,
 * check pass rates, voyage totals).
 */

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS voyages (
  id TEXT PRIMARY KEY, ship TEXT NOT NULL, goal TEXT NOT NULL, sent_to TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '', worktree TEXT NOT NULL DEFAULT '', started TEXT NOT NULL,
  docked TEXT, commits INTEGER, outcome TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS voyages_ship ON voyages(ship, docked);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT NOT NULL, role TEXT NOT NULL,
  ship TEXT NOT NULL DEFAULT '', voyage TEXT, model TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'host',
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, prompt INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS turns_voyage ON turns(voyage);
CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ship TEXT NOT NULL, voyage TEXT, agent TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, deterministic INTEGER NOT NULL DEFAULT 1,
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL DEFAULT '', dirty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_voyage ON runs(voyage);
CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, ship TEXT NOT NULL, voyage TEXT,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS handoffs_voyage ON handoffs(voyage);
CREATE VIEW IF NOT EXISTS cost_by_role_model AS
  SELECT role, model, mode, COUNT(*) AS turns, ROUND(SUM(cost), 4) AS cost, SUM(ms) AS ms, SUM(tokens) AS tokens,
         ROUND(1.0 * SUM(cache_read) / NULLIF(SUM(prompt), 0), 3) AS cache_share, SUM(1 - ok) AS failed
  FROM turns GROUP BY role, model, mode;
CREATE VIEW IF NOT EXISTS check_pass_rates AS
  SELECT ship, name, COUNT(*) AS runs, SUM(ok) AS passed, ROUND(1.0 * SUM(ok) / COUNT(*), 3) AS pass_rate, ROUND(AVG(ms)) AS avg_ms
  FROM runs GROUP BY ship, name;
CREATE VIEW IF NOT EXISTS voyage_totals AS
  SELECT v.id, v.ship, v.goal, v.branch, v.started, v.docked, v.commits,
         (SELECT COUNT(*) FROM turns t WHERE t.voyage = v.id) AS turns,
         (SELECT ROUND(COALESCE(SUM(cost), 0), 4) FROM turns t WHERE t.voyage = v.id) AS cost,
         (SELECT COALESCE(SUM(ms), 0) FROM turns t WHERE t.voyage = v.id) AS agent_ms,
         (SELECT COUNT(*) FROM runs r WHERE r.voyage = v.id) AS checks,
         (SELECT COALESCE(SUM(ok), 0) FROM runs r WHERE r.voyage = v.id) AS checks_passed,
         (SELECT COUNT(*) FROM handoffs h WHERE h.voyage = v.id) AS handoffs
  FROM voyages v;
`;

/** The officers' ship in project_id (agents #45); turns with no ship are theirs (chat-bridge passes the ship only for crewmates). */
const OFFICER_PROJECT = "flagship";

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    note: "baseline: voyages, turns, runs, handoffs, views",
    up: (db) => {
      db.exec(SCHEMA_V1);
      // Columns added after the first release of this file.
      addColumn(db, "runs", "commit_sha", "TEXT NOT NULL DEFAULT ''");
      addColumn(db, "runs", "dirty", "INTEGER NOT NULL DEFAULT 0");
      db.exec("CREATE INDEX IF NOT EXISTS runs_commit ON runs(ship, name, commit_sha)");
    },
  },
  {
    version: 2,
    note: "event_key and project_id on turns, runs, handoffs",
    up: (db) => {
      for (const table of ["turns", "runs", "handoffs"]) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN event_key TEXT`);
        db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
        db.exec(`UPDATE ${table} SET event_key = 'legacy:${table}:' || id, project_id = CASE WHEN ship = '' THEN '${OFFICER_PROJECT}' ELSE ship END`);
        db.exec(`CREATE UNIQUE INDEX ${table}_event_key ON ${table}(event_key)`);
      }
    },
  },
];

let handle: Database | null = null;
let handlePath = "";

export function metricsDb(): Database {
  const path = join(nodeStateDir(), "metrics.db");
  if (handle && handlePath === path) return handle;
  mkdirSync(nodeStateDir(), { recursive: true });
  handle = new Database(path, { create: true });
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  migrate(handle, MIGRATIONS, "metrics.db");
  handlePath = path;
  return handle;
}

/** For tests: a new FLEET_INBOX opens a new file. */
export function _closeMetrics(): void {
  handle?.close();
  handle = null;
  handlePath = "";
}

/** Metrics never break the work they measure. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error("[metrics]", e instanceof Error ? e.message : e);
  }
}

const now = () => new Date().toISOString();

/** A voyage's id: its vault note's file name without .md. */
export function voyageId(file: string): string {
  return file.split("/").pop()!.replace(/\.md$/, "");
}

export function recordVoyageStart(v: { id: string; ship: string; goal: string; to: string; branch?: string; worktree?: string; started: string }): void {
  safely(() =>
    metricsDb()
      .query("INSERT OR IGNORE INTO voyages (id, ship, goal, sent_to, branch, worktree, started) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(v.id, v.ship, v.goal.slice(0, 500), v.to, v.branch ?? "", v.worktree ?? "", v.started),
  );
}

export function recordVoyageDock(id: string, d: { commits?: number; outcome?: string; branch?: string }): void {
  safely(() =>
    metricsDb()
      .query("UPDATE voyages SET docked = ?, commits = ?, outcome = ?, branch = COALESCE(NULLIF(?, ''), branch) WHERE id = ?")
      .run(now(), d.commits ?? null, (d.outcome ?? "").slice(0, 500), d.branch ?? "", id),
  );
}

/** The ship's voyage under sail, as the metrics database knows it. */
export function openVoyageId(ship: string): string | null {
  if (!ship) return null;
  try {
    return (metricsDb().query("SELECT id FROM voyages WHERE ship = ? AND docked IS NULL ORDER BY started DESC LIMIT 1").get(ship) as { id: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** "vm" when the ship runs its crew's tools in a VM (fleet/ships/<ship>.yaml), else "host". */
export function shipMode(ship: string): "vm" | "host" {
  if (!ship || !/^[a-z][a-z0-9_-]{0,40}$/.test(ship)) return "host";
  try {
    return readShipConfig(ship)?.isolation === "vm" ? "vm" : "host";
  } catch {
    return "host";
  }
}

/** A crewmate's role is its id without the ship (pochteca-lead -> lead); an officer's is its id. */
export function roleOf(agent: string, ship?: string): string {
  return ship && agent.startsWith(`${ship}-`) ? agent.slice(ship.length + 1) : agent;
}

type TurnIn = { eventKey?: string; agent: string; ship?: string; model?: string; ok: boolean; ms: number; cost?: number; tokens?: number; cacheRead?: number; prompt?: number; error?: string };
type RunIn = { eventKey?: string; ship: string; agent: string; kind: "check" | "maneuver"; name: string; ok: boolean; ms: number; cost?: number; deterministic?: boolean; detail?: string; commit?: string; dirty?: boolean };
type HandoffIn = { eventKey?: string; ship: string; from: string; to?: string; kind: string; size?: number };

// The inserts are shared with the node's ingest (lib/ingest.ts): they return the rows added (0 for a replayed event_key).
const insertTurn = (db: Database, t: TurnIn, ts: string): number => {
  const ship = t.ship ?? "";
  return db
    .query("INSERT INTO turns (event_key, project_id, ts, agent, role, ship, voyage, model, mode, ok, ms, cost, tokens, cache_read, prompt, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING")
    .run(t.eventKey ?? ulid(), ship || OFFICER_PROJECT, ts, t.agent, roleOf(t.agent, ship), ship, openVoyageId(ship), t.model ?? "", ship ? shipMode(ship) : "host", t.ok ? 1 : 0, Math.round(t.ms), t.cost ?? 0, t.tokens ?? 0, t.cacheRead ?? 0, t.prompt ?? 0, (t.error ?? "").slice(0, 300)).changes;
};

const insertRun = (db: Database, r: RunIn, ts: string): number =>
  db
    .query("INSERT INTO runs (event_key, project_id, ts, ship, voyage, agent, kind, name, deterministic, ok, ms, cost, detail, commit_sha, dirty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING")
    .run(r.eventKey ?? ulid(), r.ship || OFFICER_PROJECT, ts, r.ship, openVoyageId(r.ship), r.agent, r.kind, r.name, r.deterministic === false ? 0 : 1, r.ok ? 1 : 0, Math.round(r.ms), r.cost ?? 0, (r.detail ?? "").slice(0, 300), r.commit ?? "", r.dirty ? 1 : 0).changes;

const insertHandoff = (db: Database, h: HandoffIn, ts: string): number =>
  db
    .query("INSERT INTO handoffs (event_key, project_id, ts, ship, voyage, from_agent, to_agent, kind, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_key) DO NOTHING")
    .run(h.eventKey ?? ulid(), h.ship || OFFICER_PROJECT, ts, h.ship, openVoyageId(h.ship), h.from, h.to ?? "", h.kind, h.size ?? 0).changes;

export function recordTurn(t: TurnIn): void {
  safely(() => void insertTurn(metricsDb(), t, now()));
}

export function recordRun(r: RunIn): void {
  safely(() => void insertRun(metricsDb(), r, now()));
}

/**
 * Rows a worker recorded (lib/ingest.ts), each with its own event_key and
 * time, in one transaction. A key already present adds nothing: `duplicates`.
 */
export function ingestMetrics(table: "turns" | "runs" | "handoffs", rows: { ts: string; row: TurnIn | RunIn | HandoffIn }[]): { accepted: number; duplicates: number } {
  const db = metricsDb();
  let accepted = 0;
  db.transaction(() => {
    for (const { ts, row } of rows) {
      accepted += table === "turns" ? insertTurn(db, row as TurnIn, ts) : table === "runs" ? insertRun(db, row as RunIn, ts) : insertHandoff(db, row as HandoffIn, ts);
    }
  }).immediate();
  return { accepted, duplicates: rows.length - accepted };
}

/** The latest run of a check on a commit (clean tree only), or null. */
export function latestRunOn(ship: string, name: string, commit: string): { ok: boolean; ts: string; detail: string } | null {
  if (!commit) return null;
  const r = metricsDb()
    .query("SELECT ok, ts, detail FROM runs WHERE ship = ? AND name = ? AND commit_sha = ? AND dirty = 0 ORDER BY id DESC LIMIT 1")
    .get(ship, name, commit) as { ok: number; ts: string; detail: string } | null;
  return r ? { ok: r.ok === 1, ts: r.ts, detail: r.detail } : null;
}

export function recordHandoff(h: HandoffIn): void {
  safely(() => void insertHandoff(metricsDb(), h, now()));
}

export type VoyageLedger = {
  id: string;
  started: string;
  elapsedMs: number;
  crew: { agent: string; role: string; model: string; mode: string; turns: number; ms: number; cost: number; tokens: number; failed: number }[];
  /** Check and maneuver runs, one row per kind and name. */
  checks: { kind: "check" | "maneuver"; name: string; runs: number; passed: number; lastOk: boolean; ms: number }[];
  handoffs: { kind: string; n: number }[];
  totalCost: number;
  totalTurns: number;
};

export function voyageLedger(id: string): VoyageLedger | null {
  const d = metricsDb();
  const v = d.query("SELECT started, docked FROM voyages WHERE id = ?").get(id) as { started: string; docked: string | null } | null;
  if (!v) return null;
  const crew = d
    .query("SELECT agent, role, model, mode, COUNT(*) AS turns, SUM(ms) AS ms, ROUND(SUM(cost), 4) AS cost, SUM(tokens) AS tokens, SUM(1 - ok) AS failed FROM turns WHERE voyage = ? GROUP BY agent, model, mode ORDER BY cost DESC")
    .all(id) as VoyageLedger["crew"];
  const checks = (d
    .query("SELECT kind, name, COUNT(*) AS runs, SUM(ok) AS passed, SUM(ms) AS ms, (SELECT ok FROM runs r2 WHERE r2.voyage = runs.voyage AND r2.kind = runs.kind AND r2.name = runs.name ORDER BY id DESC LIMIT 1) AS last_ok FROM runs WHERE voyage = ? GROUP BY kind, name ORDER BY kind, name")
    .all(id) as { kind: string; name: string; runs: number; passed: number; ms: number; last_ok: number }[]).map((c) => ({ kind: c.kind === "maneuver" ? ("maneuver" as const) : ("check" as const), name: c.name, runs: c.runs, passed: c.passed, ms: c.ms, lastOk: c.last_ok === 1 }));
  const handoffs = d.query("SELECT kind, COUNT(*) AS n FROM handoffs WHERE voyage = ? GROUP BY kind ORDER BY kind").all(id) as VoyageLedger["handoffs"];
  const end = v.docked ? Date.parse(v.docked) : Date.now();
  return {
    id,
    started: v.started,
    elapsedMs: Math.max(0, end - Date.parse(v.started)),
    crew,
    checks,
    handoffs,
    totalCost: Math.round(crew.reduce((s, c) => s + (c.cost ?? 0), 0) * 10000) / 10000,
    totalTurns: crew.reduce((s, c) => s + c.turns, 0),
  };
}

export type VoyageTotals = { id: string; goal: string; branch: string; started: string; docked: string | null; commits: number | null; outcome: string; turns: number; cost: number; checks: number; checksPassed: number; handoffs: number };

/** A ship's docked voyages, newest first, with their totals (the voyage_totals view). */
export function dockedVoyages(ship: string, limit = 10): VoyageTotals[] {
  try {
    return (metricsDb()
      // Checks only: a maneuver's run is the sum of its checks, which are counted already.
      .query(`SELECT t.id, t.goal, t.branch, t.started, t.docked, t.commits, v.outcome, t.turns, t.cost, t.handoffs,
        (SELECT COUNT(*) FROM runs r WHERE r.voyage = t.id AND r.kind = 'check') AS checks,
        (SELECT COALESCE(SUM(ok), 0) FROM runs r WHERE r.voyage = t.id AND r.kind = 'check') AS checksPassed
        FROM voyage_totals t JOIN voyages v ON v.id = t.id WHERE t.ship = ? AND t.docked IS NOT NULL ORDER BY t.started DESC LIMIT ?`)
      .all(ship, limit) as VoyageTotals[]);
  } catch {
    return [];
  }
}

export const mins = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

/** The ledger as a short markdown section for the voyage note. */
export function ledgerMarkdown(l: VoyageLedger): string {
  const lines = ["## Ledger", "", `${mins(l.elapsedMs)} from set sail to dock; ${l.totalTurns} turns; $${l.totalCost.toFixed(2)}.`, ""];
  if (l.crew.length) {
    lines.push("| Crewmate | Model | Mode | Turns | Time | Cost |", "|---|---|---|---|---|---|");
    for (const c of l.crew) lines.push(`| ${c.agent} | ${c.model || "?"} | ${c.mode} | ${c.turns}${c.failed ? ` (${c.failed} failed)` : ""} | ${mins(c.ms ?? 0)} | $${(c.cost ?? 0).toFixed(3)} |`);
    lines.push("");
  }
  for (const [kind, label] of [["check", "Checks"], ["maneuver", "Maneuvers"]] as const) {
    const rows = l.checks.filter((c) => c.kind === kind);
    if (rows.length) lines.push(`${label}: ${rows.map((c) => `${c.name} ${c.lastOk ? "passed" : "failed"}${c.runs > 1 ? ` (${c.passed}/${c.runs} runs passed)` : ""}`).join("; ")}.`, "");
  }
  if (l.handoffs.length) lines.push(`Handoffs: ${l.handoffs.map((h) => `${h.n} ${h.kind}`).join(", ")}.`, "");
  return lines.join("\n");
}

/** One line for the dock message. */
export function ledgerLine(l: VoyageLedger): string {
  const part = (kind: "check" | "maneuver", label: string) => {
    const rows = l.checks.filter((c) => c.kind === kind);
    return rows.length ? `; ${label}: ${rows.map((c) => `${c.name} ${c.lastOk ? "passed" : "failed"}`).join(", ")}` : "";
  };
  return `Ledger: ${mins(l.elapsedMs)}, ${l.totalTurns} turns, $${l.totalCost.toFixed(2)}${part("check", "checks")}${part("maneuver", "maneuvers")}.`;
}
