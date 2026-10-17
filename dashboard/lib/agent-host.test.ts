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

import { fallbackReason } from "./agent-host.ts";

describe("provider errors that move an agent to its backup model", () => {
  test("credits, quota, keys, and streams that keep dropping; other errors do not", () => {
    expect(fallbackReason('477 {"error":{"message":"Exception during request ... Out of quota"}}')).toBe("billing");
    expect(fallbackReason("402 This request requires more credits, or fewer max_tokens.")).toBe("billing");
    expect(fallbackReason("401 Unauthorized")).toBe("auth");
    expect(fallbackReason("Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input")).toBe("stream");
    expect(fallbackReason("Tool bash failed: exit 1")).toBeNull();
  });
});
