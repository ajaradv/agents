import { describe, expect, test } from "bun:test";
import { parseHelperOutput, summaryOf } from "./delegate.ts";

describe("delegate", () => {
  test("the summary is the Summary: paragraph, else the first three sentences", () => {
    expect(summaryOf("Summary: Four requests are open. Two concern Kinwork.\n\n## Detail\n- a")).toBe("Four requests are open. Two concern Kinwork.");
    expect(summaryOf("One. Two. Three. Four.")).toBe("One. Two. Three.");
  });
  test("the helper's JSON stream gives its final answer and total cost", () => {
    const lines = [
      { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage: { cost: { total: 0.001 } } } },
      { type: "tool_execution_end" },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Summary: Done.\n\nDetail." }], usage: { cost: { total: 0.002 } } } },
    ].map((l) => JSON.stringify(l)).join("\n");
    const r = parseHelperOutput(lines);
    expect(r.text).toBe("Summary: Done.\n\nDetail.");
    expect(r.cost).toBeCloseTo(0.003);
    expect(r.error).toBe("");
  });
});
