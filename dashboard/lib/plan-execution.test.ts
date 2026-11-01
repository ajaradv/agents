import { describe, expect, test } from "bun:test";
import { parseExecution, resolveExecution, type DispatchConfig } from "./plan-execution.ts";

const config: DispatchConfig = {
  rules: [
    {
      id: "mechanical",
      when: "trivial",
      use: [
        { harness: "claude", model: "claude-haiku-4-5", effort: "low" },
        { harness: "cursor", model: "composer-2.5" },
      ],
    },
    { id: "big-ship", when: "big", use: { harness: "claude", model: "claude-sonnet-5-5", effort: "high" } },
  ],
};

const plan = (block: string) => `---\ntitle: T\nstatus: finalized\n${block}---\n# T\n`;

describe("parseExecution", () => {
  test("no block means no tasks and no errors", () => {
    expect(parseExecution(plan(""))).toEqual({ tasks: [], errors: [] });
  });

  test("reads tasks and flags model names", () => {
    const r = parseExecution(
      plan("execution:\n  - task: rename\n    rule: mechanical\n  - task: core\n    rule: big-ship\n    effort: xhigh\n    model: opus\n"),
    );
    expect(r.tasks.map((t) => t.rule)).toEqual(["mechanical", "big-ship"]);
    expect(r.errors).toEqual(["execution[1] names a model; use a rule id instead"]);
  });

  test("rejects a bad effort", () => {
    expect(parseExecution(plan("execution:\n  - task: x\n    rule: mechanical\n    effort: huge\n")).errors[0]).toContain("effort");
  });
});

describe("resolveExecution", () => {
  test("binds rule ids and applies effort only where allowed", () => {
    const { resolved, errors } = resolveExecution(
      [{ task: "rename", rule: "mechanical", effort: "medium" }],
      config,
      true,
    );
    expect(errors).toEqual([]);
    expect(resolved[0]!.profiles).toEqual([
      { harness: "claude", model: "claude-haiku-4-5", effort: "medium" },
      { harness: "cursor", model: "composer-2.5" },
    ]);
  });

  test("unknown rule is an error", () => {
    const { errors } = resolveExecution([{ task: "x", rule: "nope" }], config, true);
    expect(errors[0]).toContain('unknown rule "nope"');
  });

  test("Cursor off drops cursor profiles and says so when a rule has nothing left", () => {
    const cursorOnly: DispatchConfig = { rules: [...config.rules!, { id: "cheap", when: "cheap", use: { harness: "cursor", model: "composer-2.5" } }] };
    const { resolved, errors } = resolveExecution(
      [{ task: "rename", rule: "mechanical" }, { task: "notes", rule: "cheap" }],
      cursorOnly,
      false,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.profiles).toEqual([{ harness: "claude", model: "claude-haiku-4-5", effort: "low" }]);
    expect(errors).toEqual(['rule "cheap" has nothing left for task "notes": Cursor is off']);
  });
});
