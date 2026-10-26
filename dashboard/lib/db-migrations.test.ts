import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The schemas as they stood before numbered migrations, kept as fixtures.
const METRICS_V0_FULL = `
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
const METRICS_V0_NO_ALTERS = `
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
  ok INTEGER NOT NULL, ms INTEGER NOT NULL, cost REAL NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT ''
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
const SHIP_V0_FULL = `
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
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  voyage        TEXT NOT NULL,        -- the voyage note path it belongs to
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  assignee      TEXT,                 -- crewmate id, or NULL while unassigned
  kind          TEXT NOT NULL DEFAULT 'crew',  -- 'crew' (a crewmate works it) | 'maneuver' (an ADW run)
  adw_id        TEXT,                 -- maneuver tasks: the SSSF run id
  status        TEXT NOT NULL DEFAULT 'open',  -- open | working | done | blocked
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_voyage ON tasks(voyage, id);
`;
const SHIP_V0_NO_ALTERS = `
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
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  voyage        TEXT NOT NULL,        -- the voyage note path it belongs to
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  assignee      TEXT,                 -- crewmate id, or NULL while unassigned
  kind          TEXT NOT NULL DEFAULT 'crew',  -- 'crew' (a crewmate works it) | 'maneuver' (an ADW run)
  adw_id        TEXT,                 -- maneuver tasks: the SSSF run id
  status        TEXT NOT NULL DEFAULT 'open',  -- open | working | done | blocked
  note          TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_voyage ON tasks(voyage, id);
`;

const inbox = mkdtempSync(join(tmpdir(), "migrations-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const m = await import("./metrics.ts");
const sl = await import("./ship-log.ts");
const j = await import("./journal.ts");
const { nodeStateDir } = await import("./paths.ts");
afterAll(() => {
  m._closeMetrics();
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const version = (d: Database) => (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (d: Database, t: string) => (d.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe("metrics.db migrations", () => {
  beforeEach(() => {
    m._closeMetrics();
    process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "migrations-metrics-"));
    mkdirSync(nodeStateDir(), { recursive: true });
  });
  const seed = (schema: string) => {
    const raw = new Database(join(nodeStateDir(), "metrics.db"), { create: true });
    raw.exec(schema);
    raw.exec("INSERT INTO turns (ts, agent, role, ship, ok, ms) VALUES ('t1', 'alice', 'alice', '', 1, 10), ('t2', 'pochteca-lead', 'lead', 'pochteca', 1, 20)");
    raw.exec("INSERT INTO runs (ts, ship, agent, kind, name, ok, ms) VALUES ('t1', 'pochteca', 'pochteca-lead', 'check', 'fe', 1, 5)");
    raw.exec("INSERT INTO handoffs (ts, ship, from_agent, kind) VALUES ('t1', 'pochteca', 'pochteca-lead', 'message')");
    raw.close();
  };

  test("a fresh database ends at the latest version with the new columns", () => {
    const d = m.metricsDb();
    expect(version(d)).toBe(2);
    for (const t of ["turns", "runs", "handoffs"]) expect(columns(d, t)).toEqual(expect.arrayContaining(["event_key", "project_id"]));
    expect(columns(d, "runs")).toEqual(expect.arrayContaining(["commit_sha", "dirty"]));
  });

  for (const [label, schema] of [["with every column", METRICS_V0_FULL], ["without the ALTER-added columns", METRICS_V0_NO_ALTERS]] as const) {
    test(`an old database ${label} migrates without losing rows; keys and project ids are backfilled`, () => {
      seed(schema);
      const d = m.metricsDb();
      expect(version(d)).toBe(2);
      const turns = d.query("SELECT agent, event_key, project_id FROM turns ORDER BY id").all();
      expect(turns).toEqual([
        { agent: "alice", event_key: "legacy:turns:1", project_id: "flagship" },
        { agent: "pochteca-lead", event_key: "legacy:turns:2", project_id: "pochteca" },
      ]);
      expect(d.query("SELECT event_key, project_id, commit_sha, dirty FROM runs").all()).toEqual([{ event_key: "legacy:runs:1", project_id: "pochteca", commit_sha: "", dirty: 0 }]);
      expect(d.query("SELECT event_key, project_id FROM handoffs").all()).toEqual([{ event_key: "legacy:handoffs:1", project_id: "pochteca" }]);
    });
  }

  test("event_key is unique; a replayed event adds no row", () => {
    m.recordTurn({ eventKey: "k1", agent: "alice", ok: true, ms: 1 });
    m.recordTurn({ eventKey: "k1", agent: "alice", ok: false, ms: 99 });
    m.recordRun({ eventKey: "k2", ship: "pochteca", agent: "a", kind: "check", name: "n", ok: true, ms: 1 });
    m.recordRun({ eventKey: "k2", ship: "pochteca", agent: "a", kind: "check", name: "n", ok: true, ms: 1 });
    m.recordHandoff({ eventKey: "k3", ship: "pochteca", from: "a", kind: "message" });
    m.recordHandoff({ eventKey: "k3", ship: "pochteca", from: "a", kind: "message" });
    const d = m.metricsDb();
    for (const t of ["turns", "runs", "handoffs"]) expect((d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(1);
    expect(d.query("SELECT ok, project_id FROM turns").get()).toEqual({ ok: 1, project_id: "flagship" });
    expect(() => d.exec("INSERT INTO turns (event_key, ts, agent, role, ok, ms) VALUES ('k1', 't', 'a', 'a', 1, 1)")).toThrow();
  });

  test("new rows get a ULID event_key and the ship as project_id", () => {
    m.recordTurn({ agent: "pochteca-lead", ship: "pochteca", ok: true, ms: 1 });
    m.recordTurn({ agent: "pochteca-lead", ship: "pochteca", ok: true, ms: 1 });
    const rows = m.metricsDb().query("SELECT event_key, project_id FROM turns").all() as { event_key: string; project_id: string }[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.event_key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rows[0]!.event_key).not.toBe(rows[1]!.event_key);
    expect(rows[0]!.project_id).toBe("pochteca");
  });
});

describe("ship.db migrations", () => {
  const open = (schema?: string) => {
    const root = mkdtempSync(join(tmpdir(), "migrations-ship-"));
    mkdirSync(join(root, "ships", "demo"), { recursive: true });
    if (schema) {
      const raw = new Database(join(root, "ships", "demo", "ship.db"), { create: true });
      raw.exec(schema);
      raw.exec("INSERT INTO events (ts, actor, kind) VALUES ('t1', 'demo-lead', 'notice'), ('t2', 'demo-lead', 'tool')");
      raw.exec("INSERT INTO tasks (voyage, title, created_by, created_at, updated_at) VALUES ('/v.md', 'Old task', 'x', 'n', 'n')");
      raw.close();
    }
    return { root, db: sl.shipDb("demo", root)! };
  };

  test("a fresh database ends at the latest version", () => {
    const { db } = open();
    expect(version(db)).toBe(2);
    expect(columns(db, "events")).toContain("event_key");
    expect(columns(db, "tasks")).toEqual(expect.arrayContaining(["blocked_by", "role"]));
  });

  for (const [label, schema] of [["with every column", SHIP_V0_FULL], ["without the ALTER-added columns", SHIP_V0_NO_ALTERS]] as const) {
    test(`an old database ${label} migrates without losing rows`, () => {
      const { db } = open(schema);
      expect(version(db)).toBe(2);
      expect(db.query("SELECT event_key FROM events ORDER BY id").all()).toEqual([{ event_key: "legacy:events:1" }, { event_key: "legacy:events:2" }]);
      expect(db.query("SELECT title, blocked_by, role FROM tasks").all()).toEqual([{ title: "Old task", blocked_by: "", role: null }]);
    });
  }

  test("logShipEvent sets a ULID; a replayed event_key adds no row", () => {
    const { root, db } = open();
    expect(sl.logShipEvent("demo", "a", "notice", "one", null, { root, eventKey: "k1" })).toBe(1);
    expect(sl.logShipEvent("demo", "a", "notice", "again", null, { root, eventKey: "k1" })).toBeNull();
    sl.logShipEvent("demo", "a", "notice", "two", null, { root });
    expect(db.query("SELECT event_key FROM events ORDER BY id").all()).toEqual([{ event_key: "k1" }, { event_key: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) }]);
  });
});

describe("journal.db migrations", () => {
  test("a fresh database is at version 1, and an old one keeps its rows", () => {
    j._closeJournal();
    process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "migrations-journal-"));
    mkdirSync(nodeStateDir(), { recursive: true });
    const raw = new Database(join(nodeStateDir(), "journal.db"), { create: true });
    raw.exec("CREATE TABLE workflows (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, trace TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', created TEXT NOT NULL, updated TEXT NOT NULL)");
    raw.exec("INSERT INTO workflows (id, kind, status, trace, created, updated) VALUES ('w1', 'go', 'running', 't', 'c', 'u')");
    raw.close();
    const d = j.journalDb();
    expect(version(d)).toBe(1);
    expect(columns(d, "steps")).toContain("workflow");
    expect((d.query("SELECT id FROM workflows").get() as { id: string }).id).toBe("w1");
  });
});
