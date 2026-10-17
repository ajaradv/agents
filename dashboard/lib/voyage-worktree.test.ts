import { describe, expect, test } from "bun:test";
import { usesVoyageWorktrees, voyageBranch } from "./voyage-worktree.ts";

describe("voyage worktrees", () => {
  test("branch names: crew/<slug>, unique when the slug was used before", () => {
    expect(voyageBranch("upgrade-tailwind", () => false)).toBe("crew/upgrade-tailwind");
    const taken = new Set(["crew/upgrade-tailwind", "crew/upgrade-tailwind-2026-10-17-2"]);
    expect(voyageBranch("upgrade-tailwind", (b) => taken.has(b), "2026-10-17")).toBe("crew/upgrade-tailwind-2026-10-17-3");
    expect(voyageBranch("", () => false)).toBe("crew/voyage");
  });
  test("only ships the fleet's crew sails, with a git repo", () => {
    expect(usesVoyageWorktrees({ orchestrator: "firstmate", path: "/Users/avega/Workspace/agents" })).toBe(false);
    expect(usesVoyageWorktrees({ orchestrator: "lead", path: "/nonexistent" })).toBe(false);
    expect(usesVoyageWorktrees({ orchestrator: "lead", path: "/Users/avega/Workspace/agents" })).toBe(true);
  });
});
