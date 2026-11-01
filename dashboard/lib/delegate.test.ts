import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHelperOutput, startHelper, summaryOf } from "./delegate.ts";

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
  test("startHelper runs pi read-only with the given prompts, extensions and agent id, and calls onFinish once it exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helper-"));
    // A service-account file that exists keeps the key lookup off the fleet/home/.env mount; tests get no keys.
    const prev = process.env.FLEET_OP_ENV_FILE;
    writeFileSync(join(dir, ".env.op"), "");
    process.env.FLEET_OP_ENV_FILE = join(dir, ".env.op");
    try {
      let seen: { cmd: string[]; env: Record<string, string | undefined>; cwd: string } | null = null;
      const finished: [string, string][] = [];
      const done = new Promise<void>((resolve) => {
        void startHelper({
          id: "h1",
          dir: join(dir, "h1"),
          agentId: "surveyor",
          kind: "survey-lens",
          task: "Do the thing",
          cwd: dir,
          model: "openrouter/openai/gpt-6-luna",
          prompts: ["/p/one.md", "/p/two.md"],
          extensions: ["/e/cache-watch.ts", "/e/tool-gate.ts"],
          minutes: 1,
          env: { ALICE_VAULT: "/v" },
          onFinish: (kind, id) => {
            finished.push([kind, id]);
            resolve();
          },
          spawn: (cmd, o) => {
            seen = { cmd, env: o.env, cwd: o.cwd };
            writeSync(o.out, "hello\n");
            return { pid: 2_000_000_000, exited: Promise.resolve() };
          },
        });
      });
      await done;
      expect(seen!.cmd).toEqual(["pi", "--mode", "json", "-p", "--no-session", "--no-skills", "--model", "openrouter/openai/gpt-6-luna", "--tools", "read,grep,find,ls", "--append-system-prompt", "/p/one.md", "--append-system-prompt", "/p/two.md", "-e", "/e/cache-watch.ts", "-e", "/e/tool-gate.ts", "Do the thing"]);
      expect(seen!.env.FLEET_AGENT_ID).toBe("surveyor");
      expect(seen!.env.ALICE_VAULT).toBe("/v");
      expect(seen!.cwd).toBe(dir);
      expect(finished).toEqual([["survey-lens", "h1"]]);
      expect(readFileSync(join(dir, "h1", "out.jsonl"), "utf8")).toBe("hello\n");
    } finally {
      if (prev === undefined) delete process.env.FLEET_OP_ENV_FILE;
      else process.env.FLEET_OP_ENV_FILE = prev;
    }
  });
});
