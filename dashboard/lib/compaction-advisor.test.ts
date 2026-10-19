import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "compact-"));
const { adviseCompaction, compactionAdviceSummary, cutPoint, judge } = await import("./compaction-advisor.ts");

const n = (v: number) => ({ type: "noul" as const, noul: v });
const s = (v: number) => ({ type: "score" as const, score: v, probabilities: {}, confidence: 0.9 });
const said = (answers: Record<string, unknown>) => (async () => ({ ok: true, answers, route: "typesafe", inputTokens: 500, cost: 0, ms: 1 })) as never;
const state = { current_request: "Now add dark mode to settings", previous_work: "Fix the export crash in Safari", recent_turn: "Committed the fix; tests pass.", tools_this_turn: ["bash"] };

describe("compaction advisor", () => {
  test("moved on: a switched task, or a finished unit needing little history; never mid edit", () => {
    expect(judge({ switched_gears: n(0.9), at_boundary: n(0.2), needs_history: s(1.5), mid_operation: n(0.1) })).toMatchObject({ movedOn: true, reason: "the task changed" });
    expect(judge({ switched_gears: n(0.3), at_boundary: n(0.8), needs_history: s(0.4), mid_operation: n(0.1) }).movedOn).toBe(true);
    expect(judge({ switched_gears: n(0.3), at_boundary: n(0.8), needs_history: s(1.6), mid_operation: n(0.1) }).movedOn).toBe(false);
    expect(judge({ switched_gears: n(0.95), at_boundary: n(0.9), needs_history: s(0), mid_operation: n(0.8) })).toMatchObject({ movedOn: false, reason: "mid operation" });
  });
  test("verdicts are logged with the context size for measurement", async () => {
    const r = await adviseCompaction({ agent: "kinwork-designer", mode: "observe", tokens: 420_000, percent: 42, state }, said({ switched_gears: n(0.9), at_boundary: n(0.7), needs_history: s(0.3), mid_operation: n(0.1) }));
    expect(r.verdict?.movedOn).toBe(true);
    await adviseCompaction({ agent: "kinwork-designer", mode: "observe", tokens: 430_000, percent: 43, state }, said({ switched_gears: n(0.1), at_boundary: n(0.2), needs_history: s(2), mid_operation: n(0.7) }));
    expect(compactionAdviceSummary(1)).toEqual([{ agent: "kinwork-designer", checks: 2, movedOn: 1, avgTokensWhenMovedOn: 420_000 }]);
    expect((await adviseCompaction({ agent: "x", mode: "observe", tokens: 1, percent: 1, state }, (async () => ({ ok: false, error: "down" })) as never)).ok).toBe(false);
  });
  test("the cut point names a real earlier request, or nothing when unsure", async () => {
    const reqs = ["Fix the export crash", "Add dark mode", "Polish dark mode colors"];
    const pick = (choice: string, confidence: number) => said({ live_from: { type: "choice", choice, confidence, probabilities: {} } });
    expect(await cutPoint(reqs, pick("1", 0.9))).toContain('"Add dark mode"');
    expect(await cutPoint(reqs, pick("1", 0.4))).toBeNull();
    expect(await cutPoint(reqs, pick("none", 0.9))).toBeNull();
    expect(await cutPoint(["only one"], pick("0", 0.9))).toBeNull();
  });
});
