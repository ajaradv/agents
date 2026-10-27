import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ingest-"));
const base = join(root, "ships");
const overlay = join(root, "overlay");
const inbox = join(root, "inbox");
for (const d of [base, overlay, join(inbox, ".node")]) mkdirSync(d, { recursive: true });
writeFileSync(join(base, "ingdemo.yaml"), `id: ingdemo\npath: ${root}\norchestrator: lead\ncrew: [lead]\nmode: local-only\n`);
const prev = { b: process.env.FLEET_SHIPS_DIR, o: process.env.FLEET_SHIP_OVERLAY_DIR, i: process.env.FLEET_INBOX };
process.env.FLEET_SHIPS_DIR = base;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
process.env.FLEET_INBOX = inbox;
const { handleIngest, INGEST_LIMITS, shipsForSource } = await import("./ingest.ts");
const { metricsDb, _closeMetrics } = await import("./metrics.ts");
const { shipDb } = await import("./ship-log.ts");
afterAll(() => {
  _closeMetrics();
  for (const [k, v] of [["FLEET_SHIPS_DIR", prev.b], ["FLEET_SHIP_OVERLAY_DIR", prev.o], ["FLEET_INBOX", prev.i]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const NODE = "n".repeat(48);
const WORKER = "w".repeat(64);
const OTHER = "o".repeat(64);
const secrets: Record<string, string> = { "ingest-vm-a": WORKER, "ingest-vm-c": OTHER, "ingest-laptop": "l".repeat(64) };
// vm-a holds ingdemo's voyage; vm-c holds none.
const allowedShips = (source: string, ships: string[]) => shipsForSource(source, ships, (s) => (s === "ingdemo" ? "vm-a" : undefined));
const secret = async (name: string) => secrets[name] ?? "";

const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${NODE}` }, raw?: string) =>
  handleIngest(new Request("http://node/v1/ingest", { method: "POST", headers, body: raw ?? JSON.stringify(body) }), { nodeToken: NODE, secret, allowedShips });
const count = (table: string) => (metricsDb().query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const shipCount = () => (shipDb("ingdemo")!.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;

const run = (key: string, extra: Record<string, unknown> = {}) => ({ table: "runs", event_key: key, data: { ship: "ingdemo", agent: "ingdemo-lead", kind: "check", name: "test", ok: true, ms: 1200, detail: "passed in 1s", commit_sha: "abc123", dirty: false, ...extra } });
const logEvent = (key: string) => ({ table: "ship_events", event_key: key, data: { ship: "ingdemo", actor: "ingdemo-lead", kind: "check", summary: "Check test passed in 1s", payload: { name: "test" } } });

describe("POST /v1/ingest: the replay contract", () => {
  test("the same batch twice: accepted once, then all duplicates, and no rows added", async () => {
    const events = [run("01A"), run("01B", { name: "lint", ok: false }), logEvent("01C"), logEvent("01D"),
      { table: "turns", event_key: "01E", data: { agent: "ingdemo-lead", ship: "ingdemo", ok: true, ms: 900, cost: 0.02, cache_read: 5 } },
      { table: "handoffs", event_key: "01F", data: { ship: "ingdemo", from_agent: "ingdemo-lead", kind: "task-assigned", size: 3 } }];
    const first = await post({ source: "vm-a", events });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ accepted: 6, duplicates: 0, rejected: [] });
    const rows = { runs: count("runs"), turns: count("turns"), handoffs: count("handoffs"), log: shipCount() };
    expect(rows).toEqual({ runs: 2, turns: 1, handoffs: 1, log: 2 });
    const second = await post({ source: "vm-a", events });
    expect(await second.json()).toEqual({ accepted: 0, duplicates: 6, rejected: [] });
    expect({ runs: count("runs"), turns: count("turns"), handoffs: count("handoffs"), log: shipCount() }).toEqual(rows);
  });

  test("a row carries project_id, the sender's time, and what the hub derives", async () => {
    await post({ source: "laptop", events: [run("01G", { ts: "2026-10-01T10:00:00.000Z" }), { table: "turns", event_key: "01H", data: { agent: "alice", ok: true, ms: 10 } }] });
    const r = metricsDb().query("SELECT project_id, ts, commit_sha, ok FROM runs WHERE event_key = '01G'").get() as Record<string, unknown>;
    expect(r).toEqual({ project_id: "ingdemo", ts: "2026-10-01T10:00:00.000Z", commit_sha: "abc123", ok: 1 });
    expect(metricsDb().query("SELECT project_id, role FROM turns WHERE event_key = '01H'").get()).toEqual({ project_id: "flagship", role: "alice" });
  });

  test("a batch with some bad events keeps the good ones and says why for the rest", async () => {
    const r = await (await post({ source: "vm-a", events: [run("02A"), run("bad key!"), { table: "nope", event_key: "02B", data: {} }, run("02C", { surprise: 1 }), { table: "runs", event_key: "02D", data: { ship: "ingdemo", agent: "a", kind: "check", name: "x", ok: true } }, run("02E", { ship: "ghost" }), run("x".repeat(81)), run("02F", { kind: "deploy" }), run("02G", { ms: "slow" }), run("02H", { ts: "yesterday" })] })).json() as { accepted: number; rejected: { event_key: string; reason: string }[] };
    expect(r.accepted).toBe(1);
    const why = Object.fromEntries(r.rejected.map((x) => [x.event_key, x.reason]));
    expect(why["bad key!"]).toContain("event_key");
    expect(why["02B"]).toContain("unknown table");
    expect(why["02C"]).toContain("unknown column surprise");
    expect(why["02D"]).toContain("ms is required");
    expect(why["02E"]).toBe("unknown ship ghost");
    expect(r.rejected.find((x) => x.event_key.startsWith("xxx"))?.reason).toContain("event_key");
    expect(why["02F"]).toContain("kind must be one of");
    expect(why["02G"]).toContain("ms must be a number");
    expect(why["02H"]).toContain("ts must be an ISO time");
  });

  test("a ship event for an unknown ship goes nowhere", async () => {
    const r = await (await post({ source: "vm-a", events: [{ ...logEvent("03A"), data: { ...logEvent("03A").data, ship: "ghost" } }] })).json() as { accepted: number; rejected: unknown[] };
    expect(r.accepted).toBe(0);
    expect(r.rejected).toHaveLength(1);
  });

  test("limits: more than 500 events or over 1 MB is refused whole", async () => {
    const many = Array.from({ length: INGEST_LIMITS.events + 1 }, (_, i) => run(`L${i}`));
    const before = count("runs");
    expect((await post({ source: "vm-a", events: many })).status).toBe(413);
    expect(count("runs")).toBe(before);
    expect((await post({ source: "vm-a", events: [run("BIG", { detail: "x".repeat(INGEST_LIMITS.bytes) })] })).status).toBe(413);
    expect((await post({ source: "vm-a", events: Array.from({ length: INGEST_LIMITS.events }, (_, i) => run(`M${i}`)) })).status).toBe(200);
  });
});

describe("POST /v1/ingest: who may send", () => {
  const body = { source: "vm-a", events: [run("04A")] };
  test("the node token, or the worker's own token for its own source", async () => {
    expect((await post(body)).status).toBe(200);
    expect((await post({ source: "vm-a", events: [run("04B")] }, { "x-fleet-ingest-token": WORKER })).status).toBe(200);
  });
  test("a voyage VM writes only for the ship whose voyage it holds; the laptop is not limited", async () => {
    const r = await (await post({ source: "vm-c", events: [run("04V")] }, { "x-fleet-ingest-token": OTHER })).json();
    expect(r).toMatchObject({ accepted: 0, rejected: [{ event_key: "04V", reason: "this worker holds no voyage of ingdemo" }] });
    expect(await (await post({ source: "laptop", events: [run("04W")] }, { "x-fleet-ingest-token": "l".repeat(64) })).json()).toMatchObject({ accepted: 1 });
    // A VM never writes officers' turns (no ship).
    const turn = { table: "turns", event_key: "04X", data: { agent: "alice", ok: true, ms: 10 } };
    expect((await (await post({ source: "vm-a", events: [turn] }, { "x-fleet-ingest-token": WORKER })).json()).rejected).toHaveLength(1);
  });

  test("an ingest token is for one source: another source's name, or an unset one, is refused", async () => {
    expect((await post({ source: "laptop", events: [run("04C")] }, { "x-fleet-ingest-token": WORKER })).status).toBe(401);
    expect((await post({ source: "vm-b", events: [run("04D")] }, { "x-fleet-ingest-token": WORKER })).status).toBe(401);
    expect((await post({ source: "Bad Name", events: [run("04E")] }, { "x-fleet-ingest-token": WORKER })).status).toBe(401);
  });
  test("wrong tokens and none at all are 401, and nothing is written", async () => {
    const before = count("runs");
    expect((await post(body, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await post(body, { "x-fleet-ingest-token": "w".repeat(63) })).status).toBe(401);
    expect((await post(body, {})).status).toBe(401);
    // An ingest token in the bearer slot is not the node token.
    expect((await post(body, { authorization: `Bearer ${WORKER}` })).status).toBe(401);
    expect(count("runs")).toBe(before);
  });
  test("a body that is not JSON: 401 to a stranger, 400 to the node", async () => {
    expect((await post(null, { "x-fleet-ingest-token": WORKER }, "{oops")).status).toBe(401);
    expect((await post(null, { authorization: `Bearer ${NODE}` }, "{oops")).status).toBe(400);
  });
  test("only POST", async () => {
    const r = await handleIngest(new Request("http://node/v1/ingest", { headers: { authorization: `Bearer ${NODE}` } }), { nodeToken: NODE, secret });
    expect(r.status).toBe(405);
  });
  test("an ingest token opens /v1/ingest only: the node's other routes still want the node token", async () => {
    // node.ts sends /v1/ingest to handleIngest before its token gate; every other /v1 route is behind tokenMatches(node token).
    const src = await Bun.file(join(import.meta.dir, "..", "node.ts")).text();
    expect(src.indexOf('path === "/v1/ingest"')).toBeGreaterThan(0);
    expect(src.indexOf('path === "/v1/ingest"')).toBeLessThan(src.indexOf('!tokenMatches(auth.replace'));
    expect(src.match(/x-fleet-ingest-token/gi)).toBeNull();
  });
});
