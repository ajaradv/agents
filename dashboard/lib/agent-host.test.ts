import { describe, expect, test } from "bun:test";
import { toolSpend } from "./agent-host.ts";

describe("tool spend", () => {
  test("sub-agent costs count toward the turn; ordinary tools cost nothing", () => {
    expect(toolSpend({ content: [], details: {} })).toBe(0);
    expect(toolSpend({ details: { mode: "parallel", results: [{ usage: { cost: 0.12 } }, { usage: { cost: 0.3 } }] } })).toBeCloseTo(0.42);
    expect(toolSpend({ usage: { cost: { total: 0.05 } }, details: { results: [{ usage: { cost: 9 } }] } })).toBe(0.05);
    expect(toolSpend(undefined)).toBe(0);
  });
});
