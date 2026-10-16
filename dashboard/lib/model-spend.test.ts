import { describe, expect, test } from "bun:test";
import { addPiSession, cursorRunTokens, type SpendRow } from "./model-spend.ts";

describe("model spend", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const msg = (ts: string, provider: string, cost: number) =>
    JSON.stringify({ type: "message", timestamp: ts, message: { role: "assistant", provider, model: "m", usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: { total: cost } } } });

  test("sums real API cost by day and week, skipping Cursor and old lines", () => {
    const acc = new Map<string, SpendRow>();
    const text = [
      msg("2026-10-11T10:00:00Z", "deepseek", 0.01),
      msg("2026-10-08T10:00:00Z", "deepseek", 0.02),
      msg("2026-09-01T10:00:00Z", "deepseek", 5),
      msg("2026-10-11T10:00:00Z", "cursor", 0),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ].join("\n");
    addPiSession(acc, "firstmate", text, now);
    const rows = [...acc.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lane).toBe("deepseek/m");
    expect(rows[0]!.todayUsd).toBeCloseTo(0.01);
    expect(rows[0]!.weekUsd).toBeCloseTo(0.03);
    expect(rows[0]!.weekTokens).toBe(2020);
  });

  test("Cursor estimate charges each step the context so far", () => {
    const user = JSON.stringify({ role: "user", message: { content: "x".repeat(4000) } });
    const step = JSON.stringify({ role: "assistant", message: { content: "ok" } });
    const one = cursorRunTokens([user, step].join("\n"));
    const two = cursorRunTokens([user, step, step].join("\n"));
    expect(one).toBeGreaterThan(1000);
    expect(two).toBeGreaterThan(2 * one - 50);
  });
});
