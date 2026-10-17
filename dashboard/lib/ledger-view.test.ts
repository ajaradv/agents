import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "ledger-view-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const m = await import("./metrics.ts");
const v = await import("./ledger-view.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});
const label = (id: string) => ({ "lv-scout": "Scout", "lv-lead": "Lead" })[id] ?? id;

describe("voyage ledger on the deck", () => {
  test("past voyages: totals in the row, crew and runs inside, goal escaped", () => {
    m.recordVoyageStart({ id: "v1", ship: "lv", goal: "Fix <b>nav</b>", to: "lv-lead", branch: "fix/nav", started: new Date(Date.now() - 600_000).toISOString() });
    m.recordTurn({ agent: "lv-scout", ship: "lv", model: "deepseek/deepseek-flash", ok: true, ms: 30_000, cost: 0.004 });
    m.recordTurn({ agent: "lv-lead", ship: "lv", model: "deepseek/deepseek-v4-pro", ok: false, ms: 10_000, cost: 0.02, error: "x" });
    m.recordRun({ ship: "lv", agent: "lv-scout", kind: "check", name: "pytest", ok: true, ms: 8000 });
    m.recordRun({ ship: "lv", agent: "lv-scout", kind: "maneuver", name: "verify", ok: false, ms: 9000 });
    m.recordVoyageDock("v1", { commits: 2, outcome: "Docked." });
    const html = v.pastLedgerHtml("lv", label);
    expect(html).toContain("1 past voyage · $0.02");
    expect(html).toContain("Fix &lt;b&gt;nav&lt;/b&gt;");
    expect(html).toContain("2 turns · $0.02 · checks 1/1");
    expect(html).toContain("<td>Scout</td>");
    expect(html).toContain('<span class="warn">1 failed</span>');
    expect(html).toMatch(/phase is-bad[^>]*>✗ verify/);
    expect(html).toContain("2 commits");
    expect(v.pastLedgerHtml("nothing", label)).toBe("");
  });
  test("live voyage: summary, gates with their states", () => {
    m.recordVoyageStart({ id: "v2", ship: "lv", goal: "Next", to: "lv-lead", started: new Date(Date.now() - 90_000).toISOString() });
    m.recordTurn({ agent: "lv-lead", ship: "lv", model: "deepseek/deepseek-v4-pro", ok: true, ms: 4000, cost: 0.001 });
    m.recordHandoff({ ship: "lv", from: "lv-lead", to: "lv-scout", kind: "task-assigned" });
    const html = v.liveLedgerHtml("v2", label, [{ stage: "dock", commit: "abcdef1234", dirty: false, green: false, gates: [{ name: "pytest", state: "green" }, { name: "frontend", state: "missing" }] }]);
    expect(html).toContain("Ledger · 2m · 1 turn · <$0.01");
    expect(html).toContain("Dock gates");
    expect(html).toMatch(/phase is-ok[^>]*>✓ pytest/);
    expect(html).toContain("frontend not run on this commit (abcdef1)");
    expect(html).toContain("1 handoff between crewmates and the helm");
    expect(v.liveLedgerHtml("missing", label, [])).toBe("");
  });
});
