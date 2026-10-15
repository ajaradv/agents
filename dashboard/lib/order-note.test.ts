import { describe, expect, test } from "bun:test";
import { callMismatch, parseArgs, parseOrder, withMeta, withReport } from "./order-note.ts";

const NOTE = `---
title: "Kinwork status round"
order: "2026-10-15-kinwork-status-round"
status: "queued"
ship: "kinwork"
submitted_by: "claude-code"
created: "2026-10-15T05:00:00Z"
---

## Intent

Ask the lead for a status line.

## Steps

1. \`ship_tasks\` ship=kinwork
   expect: the open voyage and its tasks
2. \`fleet_chat\` to=kinwork-designer text="Dashboard test: reply with only OK."
   expect: the message lands in the designer's thread

## Acceptance

- \`agent_chat_read\` agent=kinwork-designer n=5
  expect: the message is in the thread
`;

describe("parseOrder", () => {
  test("steps and acceptance become one numbered list of literal calls", () => {
    const { order, errors } = parseOrder(NOTE);
    expect(errors).toEqual([]);
    expect(order!.meta.status).toBe("queued");
    expect(order!.intent).toBe("Ask the lead for a status line.");
    expect(order!.steps.map((s) => [s.n, s.phase, s.tool])).toEqual([
      [1, "step", "ship_tasks"],
      [2, "step", "fleet_chat"],
      [3, "acceptance", "agent_chat_read"],
    ]);
    expect(order!.steps[1]!.args).toEqual({ to: "kinwork-designer", text: "Dashboard test: reply with only OK." });
    expect(order!.steps.map((x) => x.line)).toEqual([16, 18, 23]);
  });
  test("free text, unknown tools, bad arguments, and missing expect lines are rejected with line numbers", () => {
    const bad = NOTE.replace("1. `ship_tasks` ship=kinwork", "1. make sure the ship is healthy")
      .replace("`fleet_chat` to=kinwork-designer", "`voyage_start` ship=kinwork")
      .replace("  expect: the message is in the thread\n", "");
    const { order, errors } = parseOrder(bad);
    expect(order).toBeNull();
    expect(errors.some((e) => e.startsWith("line 16:") && e.includes("free text"))).toBe(true);
    expect(errors.some((e) => e.startsWith("line 18:") && e.includes("voyage_start` is not an order tool"))).toBe(true);
    expect(errors.some((e) => e.includes('add an indented "expect:"'))).toBe(true);
  });
  test("acceptance lines must be reads", () => {
    const { errors } = parseOrder(NOTE.replace("- `agent_chat_read` agent=kinwork-designer n=5", '- `fleet_chat` to=x text="y"'));
    expect(errors.some((e) => e.includes("acceptance lines must be read tools"))).toBe(true);
  });
});

describe("arguments and matching", () => {
  test("quoted values keep spaces and escaped quotes", () => {
    expect(parseArgs('to=a text="say \\"hi\\" now" n=3')).toEqual({ to: "a", text: 'say "hi" now', n: "3" });
    expect(parseArgs("to=")).toBeNull();
  });
  test("a call matches only with the same tool and the same literal arguments", () => {
    const step = parseOrder(NOTE).order!.steps[1]!;
    expect(callMismatch(step, "fleet_chat", { to: "kinwork-designer", text: "Dashboard  test: reply with only OK. " })).toBeNull();
    expect(callMismatch(step, "fleet_chat", { to: "kinwork-lead", text: "Dashboard test: reply with only OK." })).toContain("to=");
    expect(callMismatch(step, "ship_tasks", { ship: "kinwork" })).toContain("not `ship_tasks`");
    expect(callMismatch(parseOrder(NOTE).order!.steps[0]!, "ship_tasks", { ship: "kinwork", extra: "1" })).toContain("extra=");
  });
});

describe("note edits", () => {
  test("frontmatter changes keep the body; the report replaces itself", () => {
    const meta = { ...parseOrder(NOTE).meta!, status: "done" as const, ended: "2026-10-15T05:10:00Z" };
    let text = withMeta(NOTE, meta);
    expect(parseOrder(text).order!.meta.status).toBe("done");
    expect(text).toContain("## Intent\n\nAsk the lead");
    text = withReport(withReport(text, "first"), "second");
    expect(text.match(/## Report/g)!.length).toBe(1);
    expect(text.trimEnd().endsWith("second")).toBe(true);
  });
});
