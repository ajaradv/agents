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
  test("credits, quota, keys, streams that keep dropping, and provider-side errors; other errors do not", () => {
    expect(fallbackReason('477 {"error":{"message":"Exception during request ... Out of quota"}}')).toBe("billing");
    expect(fallbackReason("402 This request requires more credits, or fewer max_tokens.")).toBe("billing");
    expect(fallbackReason("401 Unauthorized")).toBe("auth");
    expect(fallbackReason("Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input")).toBe("stream");
    expect(fallbackReason('401 {"type":"error","error":{"type":"authentication_error","message":"User not found."}}')).toBe("auth");
    expect(fallbackReason("Upstream error from Reka: Something wrong happened during your request! Please retry. If the error persists, contact our support team.")).toBe("upstream");
    expect(fallbackReason('503 {"error":{"message":"Service Unavailable"}}')).toBe("upstream");
    expect(fallbackReason("529 Overloaded")).toBe("upstream");
    expect(fallbackReason("400 max_tokens: 500 is too large")).toBeNull();
    expect(fallbackReason("Tool bash failed: exit 1")).toBeNull();
  });
});

import { codemodeTools } from "./agent-host.ts";

describe("codemode tool names", () => {
  test("reads tools.name( and tools['name']( calls, deduped in order", () => {
    expect(codemodeTools('const a = await tools.vault_tasks({}); const b = await tools["fleet_query"]({ query: "spend" }); await tools.vault_tasks({}); return [a, b];')).toEqual(["vault_tasks", "fleet_query"]);
    expect(codemodeTools("return 1 + 1;")).toEqual([]);
    expect(codemodeTools("const tools2 = 1; mytools.x(1)")).toEqual([]);
    expect(codemodeTools(undefined)).toEqual([]);
  });
});
