import { describe, expect, test } from "bun:test";
import { branchForGoal, usesVoyageWorktrees, voyageBranch } from "./voyage-worktree.ts";

describe("voyage worktrees", () => {
  test("branch names: <type>/<words> from the goal (python-semantic-release prefixes), unique when taken", () => {
    expect(branchForGoal("Fix the order total rounding on the checkout page")).toBe("fix/order-total-rounding-checkout-page");
    expect(branchForGoal("Upgrade the Django app frontend to Tailwind CSS 4.3 (tailwindcss 4.3.3) and daisyUI 5.7.50")).toBe("chore/frontend-tailwind-css-4.3-daisyui-5.7.50");
    expect(branchForGoal("Add an order export to CSV for admins")).toBe("feat/order-export-csv-admins");
    expect(branchForGoal("In README.md, add a note about tests")).toMatch(/^docs\//);
    expect(voyageBranch("fix/rounding", () => false)).toBe("fix/rounding");
    const taken = new Set(["fix/rounding", "fix/rounding-2026-10-17-2"]);
    expect(voyageBranch("fix/rounding", (b) => taken.has(b), "2026-10-17")).toBe("fix/rounding-2026-10-17-3");
  });
  test("only ships the fleet's crew sails, with a git repo", () => {
    expect(usesVoyageWorktrees({ orchestrator: "firstmate", path: "/Users/avega/Workspace/agents" })).toBe(false);
    expect(usesVoyageWorktrees({ orchestrator: "lead", path: "/nonexistent" })).toBe(false);
    expect(usesVoyageWorktrees({ orchestrator: "lead", path: "/Users/avega/Workspace/agents" })).toBe(true);
  });
});
