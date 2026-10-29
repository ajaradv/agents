import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "fleet-query-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const q = await import("./fleet-query.ts");
const m = await import("./metrics.ts");
const j = await import("./journal.ts");
const failures = await import("./tool-failures.ts");
const { toolText, VIEWS } = await import("./tool-out.ts");
afterAll(() => {
  m._closeMetrics();
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
let n = 0;
const turn = (days: number, agent: string, model: string, cost: number, ok = 1) =>
  m.metricsDb().query("INSERT INTO turns (event_key, project_id, ts, agent, role, ship, model, ok, ms, cost, tokens) VALUES (?, 'flagship', ?, ?, 'r', '', ?, ?, 10, ?, 100)").run(`t${n++}`, ago(days), agent, model, ok, cost);

describe("fleet_query", () => {
  test("spend groups turn cost by agent, model, or day, inside the window", () => {
    turn(1, "alice", "deepseek", 1.5);
    turn(1, "alice", "deepseek", 0.5, 0);
    turn(2, "architect", "opus", 3);
    turn(30, "alice", "deepseek", 100); // outside 7 days
    const byAgent = q.fleetQuery("spend", { days: 7, by: "agent" }) as unknown as { message: string; by_agent: { agent: string; turns: number; cost: number; failed: number }[] };
    expect(byAgent.message).toBe("$5.00 over 3 turns in 7 day(s), by agent");
    expect(byAgent.by_agent.map((r) => [r.agent, r.turns, r.cost, r.failed])).toEqual([["architect", 1, 3, 0], ["alice", 2, 2, 1]]);
    expect((q.fleetQuery("spend", { by: "model" }) as unknown as { by_model: { model: string }[] }).by_model.map((r) => r.model)).toEqual(["opus", "deepseek"]);
    const days = (q.fleetQuery("spend", { by: "day" }) as unknown as { by_day: { day: string; cost: number }[] }).by_day;
    expect(days.map((r) => r.day)).toEqual([ago(1).slice(0, 10), ago(2).slice(0, 10)]);
    expect((q.fleetQuery("spend", { days: 60 }) as unknown as { message: string }).message).toContain("$105.00");
  });

  test("spend renders as a small table with the group's name as the column", () => {
    const text = toolText(q.fleetQuery("spend", { by: "model" }), VIEWS.fleet_query);
    expect(text).toContain("by_model[2]{model,turns,cost,failed,tokens}");
  });

  test("tool_failures counts by agent and tool and shows the latest errors", () => {
    failures.recordToolFailure({ agent: "alice", tool: "bash", args: "sqlite3 x", error: "no such table: turns" }, () => {});
    failures.recordToolFailure({ agent: "alice", tool: "grep", args: "grep zz", error: "Command exited with code 1" }, () => {}); // not bash: counted
    failures.recordToolFailure({ agent: "alice", tool: "bash", args: "grep zz file", error: "Command exited with code 1" }, () => {}); // a "no" answer: not counted
    const r = q.fleetQuery("tool_failures", { days: 7 }) as unknown as { message: string; failures_by_tool: { tool: string; n: number }[]; latest: { error: string }[] };
    expect(r.message).toBe("2 tool failure(s) in 7 day(s)");
    expect(r.failures_by_tool.map((x) => x.tool).sort()).toEqual(["bash", "grep"]);
    expect(r.latest[1]!.error).toContain("no such table");
  });

  test("jev and gate answer with zero rows before anything is logged", () => {
    expect((q.fleetQuery("jev") as unknown as { message: string }).message).toBe("0 Jev calls, $0.0000 in 7 day(s)");
    expect((q.fleetQuery("gate") as unknown as { message: string }).message).toBe("0 gate decisions in 7 day(s)");
    expect(toolText(q.fleetQuery("jev"), VIEWS.fleet_query)).toContain("uses: 0 calls");
  });

  test("jev and gate read what the node logged", () => {
    const d = m.metricsDb();
    d.exec("CREATE TABLE IF NOT EXISTS gate_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL, summary TEXT NOT NULL, decision TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '')");
    const gate = (decision: string, summary: string) => d.query("INSERT INTO gate_log (ts, agent, tool, summary, decision, source) VALUES (?, 'alice', 'bash', ?, ?, 'test')").run(ago(0.1), summary, decision);
    gate("allow", "ls");
    gate("allow", "pwd");
    gate("stop", "rm -rf /tmp/x");
    const r = q.fleetQuery("gate", { days: 1 }) as unknown as { message: string; notable: { decision: string; call: string }[] };
    expect(r.message).toBe("allow 2, stop 1");
    expect(r.notable).toEqual([expect.objectContaining({ decision: "stop", call: "rm -rf /tmp/x" })]);
    expect((q.fleetQuery("jev") as unknown as { ok: boolean }).ok).toBe(true);
    d.query("INSERT INTO jev_calls (ts, use, route, ok, input_tokens, cost, ms, error) VALUES (?, 'tool-gate', 'r', 1, 100, 0.002, 300, '')").run(ago(0.1));
    const jev = q.fleetQuery("jev") as unknown as { message: string; uses: { use: string; calls: number }[] };
    expect(jev.message).toBe("1 Jev calls, $0.0020 in 7 day(s)");
    expect(jev.uses[0]).toMatchObject({ use: "tool-gate", calls: 1 });
  });

  test("voyages lists open ones and those started in the window, with ship and cost", () => {
    const d = m.metricsDb();
    const v = (id: string, ship: string, days: number, docked: string | null) => d.query("INSERT INTO voyages (id, ship, goal, started, docked) VALUES (?, ?, 'g', ?, ?)").run(id, ship, ago(days), docked);
    v("v-old", "kinwork", 40, ago(39));
    v("v-open-old", "pochteca", 40, null);
    v("v-new", "kinwork", 2, ago(1));
    d.query("INSERT INTO turns (event_key, project_id, ts, agent, role, ship, voyage, model, ok, ms, cost, tokens) VALUES ('tv', 'kinwork', ?, 'k', 'r', 'kinwork', 'v-new', 'm', 1, 1, 0.25, 1)").run(ago(1));
    const r = q.fleetQuery("voyages", { days: 7 }) as unknown as { message: string; voyages: { id: string; state: string; cost: number }[] };
    expect(r.voyages.map((x) => [x.id, x.state, x.cost])).toEqual([["v-new", "docked", 0.25], ["v-open-old", "open", 0]]);
    expect(r.message).toContain("1 open, 1 docked");
  });

  test("bad input is an error that says what is valid", () => {
    expect(q.fleetQuery("select * from turns")).toMatchObject({ ok: false, message: expect.stringContaining("Queries: spend, tool_failures") });
    expect(q.fleetQuery("spend", { by: "ship" })).toMatchObject({ ok: false, message: expect.stringContaining("agent, model, day") });
    expect(q.fleetQuery("gate", { by: "agent" }).ok).toBe(false);
    expect((q.fleetQuery("spend", { days: -3 }) as unknown as { message: string }).message).toContain("in 1 day(s)"); // clamped
  });

  test("since/until pick a window of whole UTC days, inclusive at both ends", () => {
    const at = (iso: string, agent: string, cost: number) => m.metricsDb().query("INSERT INTO turns (event_key, project_id, ts, agent, role, ship, model, ok, ms, cost, tokens) VALUES (?, 'flagship', ?, ?, 'r', '', 'm', 1, 10, ?, 100)").run(`w${n++}`, iso, agent, cost);
    at("2020-10-17T23:59:59.000Z", "before", 1000);
    at("2020-10-18T00:00:00.000Z", "first", 1);
    at("2020-10-25T23:59:59.000Z", "last", 2);
    at("2020-10-26T00:00:00.000Z", "after", 1000);
    const r = q.fleetQuery("spend", { since: "2020-10-18", until: "2020-10-25", by: "agent", days: 1 }) as unknown as { message: string; by_agent: { agent: string }[] };
    expect(r.message).toBe("$3.00 over 2 turns, 2020-10-18 to 2020-10-25, by agent");
    expect(r.by_agent.map((x) => x.agent)).toEqual(["last", "first"]);
    // until alone looks `days` back from the end of that day; an ISO time is taken as is
    expect((q.fleetQuery("spend", { until: "2020-10-18", days: 2 }) as unknown as { message: string }).message).toContain("$1001.00 over 2 turns");
    expect((q.fleetQuery("spend", { since: "2020-10-25T12:00:00Z", until: "2020-10-26T00:00:00Z" }) as unknown as { message: string }).message).toContain("$2.00 over 1 turns");
  });

  test("the window bounds the other queries too", () => {
    const d = m.metricsDb();
    d.query("INSERT INTO jev_calls (ts, use, route, ok, input_tokens, cost, ms, error) VALUES ('2019-03-02T10:00:00Z', 'old-use', 'r', 1, 1, 0.5, 1, ''), ('2019-03-09T10:00:00Z', 'late-use', 'r', 1, 1, 0.5, 1, '')").run();
    const jev = q.fleetQuery("jev", { since: "2019-03-01", until: "2019-03-05" }) as unknown as { message: string; uses: { use: string }[] };
    expect(jev.uses.map((u) => u.use)).toEqual(["old-use"]);
    expect(jev.message).toBe("1 Jev calls, $0.5000, 2019-03-01 to 2019-03-05");
    d.query("INSERT INTO voyages (id, ship, goal, started, docked) VALUES ('v-w', 's', 'g', '2019-03-02T00:00:00Z', '2019-03-03T00:00:00Z'), ('v-late', 's', 'g', '2019-04-02T00:00:00Z', NULL)").run();
    const v = q.fleetQuery("voyages", { since: "2019-03-01", until: "2019-03-05" }) as unknown as { voyages: { id: string }[] };
    expect(v.voyages.map((x) => x.id)).toEqual(["v-w"]);
    expect((q.fleetQuery("gate", { since: "2019-03-01", until: "2019-03-05" }) as unknown as { message: string }).message).toBe("0 gate decisions, 2019-03-01 to 2019-03-05");
    expect((q.fleetQuery("tool_failures", { since: "2019-03-01", until: "2019-03-05" }) as unknown as { message: string }).message).toBe("0 tool failure(s), 2019-03-01 to 2019-03-05");
  });

  test("bad windows are errors that say what is valid", () => {
    expect(q.fleetQuery("spend", { since: "10-18" })).toMatchObject({ ok: false, message: expect.stringContaining("YYYY-MM-DD") });
    expect(q.fleetQuery("spend", { until: "2026-02-31" })).toMatchObject({ ok: false, message: expect.stringContaining('until "2026-02-31"') });
    expect(q.fleetQuery("spend", { since: "2026-10-25", until: "2026-10-18" })).toMatchObject({ ok: false, message: expect.stringContaining("after until") });
    expect(q.fleetQuery("spend", { since: "2024-01-01", until: "2026-01-01" })).toMatchObject({ ok: false, message: expect.stringContaining("over 365 days") });
  });
});
