import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
process.env.FLEET_SUBAGENTS_DIR = join(root, "agents", "subagents");
const { discoverAgents } = await import("../../extensions/subagent/agents.ts");

describe("sub-agents (cheaper)", () => {
  test("evidence runs on Claude Haiku; assessor inherits the caller's model; both are read-only", () => {
    const agents = discoverAgents(root, "user").agents;
    const evidence = agents.find((a) => a.name === "evidence")!;
    const assessor = agents.find((a) => a.name === "assessor")!;
    expect(evidence.model).toBe("openrouter/anthropic/claude-haiku-5.5");
    expect(assessor.model).toBeUndefined();
    for (const a of [evidence, assessor]) expect(a.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
    expect(evidence.systemPrompt).toContain("bin/fleet-shot");
  });
  test("children start with discovery off and load only what their definition names", () => {
    const src = readFileSync(join(root, "extensions", "subagent", "index.ts"), "utf8");
    expect(src).toContain('args.push("--no-skills", "--no-extensions", "--no-prompt-templates", "--no-mcp")');
    expect(src).toContain('args.push("--skill", s)');
  });
});
