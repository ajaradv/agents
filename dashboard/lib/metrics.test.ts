import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "metrics-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const m = await import("./metrics.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

describe("fleet metrics and the voyage ledger", () => {
  test("turns, checks, and handoffs land under the ship's open voyage; the ledger sums them", () => {
    m.recordVoyageStart({ id: "2026-10-17-tailwind", ship: "pochteca", goal: "Upgrade Tailwind", to: "pochteca-lead", branch: "chore/tailwind-4.3", started: new Date(Date.now() - 300_000).toISOString() });
    expect(m.openVoyageId("pochteca")).toBe("2026-10-17-tailwind");
    m.recordTurn({ agent: "pochteca-lead", ship: "pochteca", model: "deepseek/deepseek-v4-pro", ok: true, ms: 20_000, cost: 0.05, tokens: 9000, cacheRead: 8000, prompt: 8800 });
    m.recordTurn({ agent: "pochteca-designer", ship: "pochteca", model: "openrouter/anthropic/claude-sonnet-5.5", ok: true, ms: 35_000, cost: 0.11 });
    m.recordTurn({ agent: "alice", model: "deepseek/deepseek-v4-pro", ok: true, ms: 5000, cost: 0.01 });
    m.recordRun({ ship: "pochteca", agent: "pochteca-lead", kind: "check", name: "frontend", ok: false, ms: 300 });
    m.recordRun({ ship: "pochteca", agent: "pochteca-lead", kind: "check", name: "frontend", ok: true, ms: 13_000 });
    m.recordRun({ ship: "pochteca", agent: "pochteca-lead", kind: "check", name: "pytest", ok: true, ms: 13_000 });
    m.recordHandoff({ ship: "pochteca", from: "pochteca-lead", to: "pochteca-designer", kind: "task-assigned", size: 80 });
    m.recordVoyageDock("2026-10-17-tailwind", { commits: 1, outcome: "done" });
    expect(m.openVoyageId("pochteca")).toBeNull();
    const l = m.voyageLedger("2026-10-17-tailwind")!;
    expect(l.totalTurns).toBe(2);
    expect(l.totalCost).toBeCloseTo(0.16);
    expect(l.crew.map((c) => c.role)).toEqual(["designer", "lead"]);
    expect(l.checks).toEqual([
      { name: "frontend", runs: 2, passed: 1, ms: 13_300, lastOk: true },
      { name: "pytest", runs: 1, passed: 1, ms: 13_000, lastOk: true },
    ]);
    expect(m.ledgerLine(l)).toMatch(/^Ledger: 5m, 2 turns, \$0\.16; checks: frontend passed, pytest passed\.$/);
    expect(m.ledgerMarkdown(l)).toContain("| pochteca-designer | openrouter/anthropic/claude-sonnet-5.5 |");
  });
  test("views answer cost by role and model, and check pass rates", () => {
    const rows = m.metricsDb().query("SELECT role, model, turns FROM cost_by_role_model ORDER BY role").all() as { role: string; turns: number }[];
    expect(rows.map((r) => r.role)).toEqual(["alice", "designer", "lead"]);
    const rate = m.metricsDb().query("SELECT pass_rate FROM check_pass_rates WHERE name = 'frontend'").get() as { pass_rate: number };
    expect(rate.pass_rate).toBe(0.5);
    const tot = m.metricsDb().query("SELECT turns, checks, checks_passed, handoffs FROM voyage_totals").get();
    expect(tot).toEqual({ turns: 2, checks: 3, checks_passed: 2, handoffs: 1 });
  });
  test("roles and modes", () => {
    expect(m.roleOf("pochteca-lead", "pochteca")).toBe("lead");
    expect(m.roleOf("alice")).toBe("alice");
    expect(m.shipMode("pochteca")).toBe("vm");
    expect(m.shipMode("kinwork")).toBe("host");
  });
});
