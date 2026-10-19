import { describe, expect, test } from "bun:test";
import type { ShipEvent } from "./ship-log.ts";
import { collapseLog, orderProgress } from "./ship-view.ts";

const ev = (id: number, ts: string, kind: string, summary: string, payload: Record<string, unknown> | null = null, actor = "kinwork-designer"): ShipEvent => ({ id, ts, actor, kind, summary, payload });
const SSE = "Could not parse Anthropic SSE event content_block_delta: Unexpected end of JSON input; data=";

describe("collapseLog", () => {
  test("a failure reported as a notice and as the failed turn shows once, as the turn", () => {
    const rows = collapseLog([
      ev(3, "2026-10-14T04:52:00Z", "turn-end", SSE, { error: SSE, cost: 0.4 }),
      ev(2, "2026-10-14T04:51:58Z", "notice", SSE, { level: "error" }),
      ev(1, "2026-10-14T04:51:36Z", "chat-in", "hand it off to ship", null, "captain"),
    ]);
    expect(rows.map((r) => [r.event.kind, r.repeats])).toEqual([["turn-end", 2], ["chat-in", 1]]);
  });
  test("a notice and a failed turn that word the same failure differently still collapse", () => {
    const rows = collapseLog([
      ev(2, "2026-10-14T05:04:00Z", "notice", "503: Service is too busy.", { level: "error" }),
      ev(1, "2026-10-14T05:04:00Z", "turn-end", "Turn failed after 3m 8s: 503: Service is too busy. We advise users to switch.", { error: "503" }),
    ]);
    expect(rows.map((r) => [r.event.kind, r.repeats])).toEqual([["turn-end", 2]]);
  });
  test("different failures, other crewmates, and far-apart repeats stay separate", () => {
    const rows = collapseLog([
      ev(4, "2026-10-14T05:00:00Z", "turn-end", "402 credits", { error: "402 credits" }),
      ev(3, "2026-10-14T04:59:00Z", "turn-end", SSE, { error: SSE }),
      ev(2, "2026-10-14T04:58:00Z", "turn-end", SSE, { error: SSE }, "kinwork-lead"),
      ev(1, "2026-10-14T04:00:00Z", "turn-end", SSE, { error: SSE }, "kinwork-lead"),
    ]);
    expect(rows.map((r) => r.repeats)).toEqual([1, 1, 1, 1]);
  });
});

describe("order progress on the deck", () => {
  test("step k of N follows the logged steps; a chat pause shows until the order resumes", () => {
    const o = (id: number, kind: string, payload: Record<string, unknown>) => ev(id, `2026-10-18T10:00:0${id}Z`, kind, kind, { order: "o1", ...payload }, "orders");
    // Newest first, as the ship log returns them.
    const paused = [o(4, "order-chat", { step: 2 }), o(3, "order-step", { step: 2, ok: true }), o(2, "order-step", { step: 1, ok: true }), o(1, "order-start", { step: 1 })];
    expect(orderProgress("o1", 4, paused)).toEqual({ step: 3, total: 4, chatPaused: true });
    expect(orderProgress("o1", 4, [o(5, "order-start", { step: 3, resumed: true }), ...paused])).toEqual({ step: 3, total: 4, chatPaused: false });
    expect(orderProgress("o2", 4, paused)).toEqual({ step: 1, total: 4, chatPaused: false });
  });
});
