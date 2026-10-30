import { describe, expect, test } from "bun:test";
import { STATE_CAP, stateText } from "../../extensions/context-guard.ts";

describe("state.md handoff", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  test("a short summary is kept whole", () => {
    const t = stateText("Doing X.\nNext Y.", "idle", now);
    expect(t).toBe("# State handoff\n\nWritten 2026-10-30T00:00:00.000Z after a idle compaction. The session's summary of everything before it:\n\nDoing X.\nNext Y.\n");
  });
  test("a long one is cut at a line boundary within 1.5 KB and says so", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"é".repeat(20)}`);
    const t = stateText(lines.join("\n"), "manual", now);
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(STATE_CAP);
    expect(t.endsWith("[cut at 1.5 KB; the session summary has the rest]\n")).toBe(true);
    const kept = t.split("\n").filter((l) => l.startsWith("line "));
    expect(kept.length).toBeGreaterThan(5);
    expect(kept.every((l, i) => l === lines[i])).toBe(true);
  });
  test("one huge line is cut mid-line rather than dropped", () => {
    const t = stateText("x".repeat(5000), "manual", now);
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(STATE_CAP);
    expect(t).toContain("xxxx");
  });
});
