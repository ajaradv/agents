import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "metrics-view-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const m = await import("./metrics.ts");
const v = await import("./metrics-view.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

describe("fleet metrics dashboard", () => {
  test("periods parse to 7, 30, or all time", () => {
    expect([v.parsePeriod("30"), v.parsePeriod("0"), v.parsePeriod("9"), v.parsePeriod(null)]).toEqual([30, 0, 7, 7]);
  });
  test("the day axis covers the whole period, oldest first, ending today", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(v.dayAxis(3, now)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
  });
  test("an empty database says so", () => {
    expect(v.metricsDashboardHtml(7)).toContain("Nothing recorded in this period yet.");
  });
  test("totals, roles, modes, runs, and voyages from the database", () => {
    m.recordVoyageStart({ id: "mv1", ship: "mvs", goal: "Ship <it>", to: "mvs-lead", started: new Date(Date.now() - 1_200_000).toISOString() });
    m.recordTurn({ agent: "mvs-lead", ship: "mvs", model: "deepseek/deepseek-v4-pro", ok: true, ms: 20_000, cost: 0.04, cacheRead: 900, prompt: 1000 });
    m.recordTurn({ agent: "mvs-lead", ship: "mvs", model: "deepseek/deepseek-v4-pro", ok: false, ms: 10_000, cost: 0.02, cacheRead: 100, prompt: 1000, error: "x" });
    m.recordTurn({ agent: "alice", model: "deepseek/deepseek-v4-pro", ok: true, ms: 6000, cost: 0.01 });
    m.recordRun({ ship: "mvs", agent: "mvs-lead", kind: "check", name: "pytest", ok: false, ms: 4000 });
    m.recordRun({ ship: "mvs", agent: "mvs-lead", kind: "check", name: "pytest", ok: true, ms: 6000 });
    m.recordRun({ ship: "mvs", agent: "mvs-lead", kind: "maneuver", name: "verify", ok: true, ms: 9000 });
    m.recordHandoff({ ship: "mvs", from: "mvs-lead", to: "mvs-scout", kind: "task-assigned" });
    m.recordVoyageDock("mv1", { commits: 1 });
    const d = v.metricsData(7);
    expect(d.kpi).toMatchObject({ turns: 3, failed: 1, voyages: 1, checkRuns: 2, checkPassed: 1, maneuverRuns: 1 });
    expect(d.kpi.cost).toBeCloseTo(0.07);
    expect(d.kpi.cacheShare).toBeCloseTo(0.5);
    expect(d.byRole.map((r) => [r.role, r.mode, r.turns])).toEqual([["lead", "host", 2], ["alice", "host", 1]]);
    expect(d.byMode).toEqual([{ mode: "host", turns: 2, cost: expect.closeTo(0.06), ms: 30_000 }]);
    expect(d.runs.map((r) => `${r.kind} ${r.name} ${r.passed}/${r.runs} last ${r.lastOk}`)).toEqual(["maneuver verify 1/1 last 1", "check pytest 1/2 last 1"]);
    const html = v.metricsDashboardHtml(7);
    expect(html).toContain("Ship &lt;it&gt;");
    expect(html).toContain('aria-pressed="true" hx-get="/partials/fleet-metrics?days=7"');
    expect(html).toContain("Spend per day by role");
    expect(html).toMatch(/Checks passed<\/span><b>50%<\/b>/);
    expect(html).toContain("1 task-assigned");
    expect(v.metricsDashboardHtml(0)).toContain("last 30 days");
    expect((v.metricsDashboardHtml(7).match(/class="bar"/g) ?? []).length).toBe(7);
  });
});
