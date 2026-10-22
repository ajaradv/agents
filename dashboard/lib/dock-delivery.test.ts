import { describe, expect, test } from "bun:test";
import { deliveryFor, openDockPr, prTitle } from "./dock-delivery.ts";

describe("landing a docked voyage through the ship's delivery mode", () => {
  test("which modes open a pull request", () => {
    expect(deliveryFor("local-only")).toBe("local");
    expect(deliveryFor("direct-PR")).toBe("pr");
    expect(deliveryFor("no-mistakes")).toBe("pr");
    expect(deliveryFor("no-mistakes-prod-only")).toBe("pr");
    expect(deliveryFor("")).toBe("local");
  });
  test("push, then a PR onto the base branch; never a merge", async () => {
    const calls: string[] = [];
    const exec = async (cmd: string[]) => {
      calls.push(cmd.slice(0, 3).join(" "));
      if (cmd[1] === "pr" && cmd[2] === "view") return { code: 1, out: "no pull requests found" };
      if (cmd[1] === "pr" && cmd[2] === "create") return { code: 0, out: "https://github.com/ajaradv/Kinwork/pull/36" };
      return { code: 0, out: "" };
    };
    expect(await openDockPr("/repo", "feat/x", "master", "Add x", "body", exec)).toEqual({ ok: true, url: "https://github.com/ajaradv/Kinwork/pull/36", message: "pull request opened" });
    expect(calls).toEqual(["git push -u", "gh pr view", "gh pr create"]);
    expect(calls.some((c) => c.includes("merge"))).toBe(false);
  });
  test("a failed push keeps the branch local and says why; an open PR is reused", async () => {
    expect(await openDockPr("/r", "b", "main", "t", "x", async () => ({ code: 1, out: "remote: Permission denied" }))).toMatchObject({ ok: false, message: expect.stringContaining("stays local") });
    const reuse = async (cmd: string[]) => (cmd[2] === "view" ? { code: 0, out: "https://github.com/a/b/pull/7" } : { code: 0, out: "" });
    expect(await openDockPr("/r", "b", "main", "t", "x", reuse)).toMatchObject({ ok: true, url: "https://github.com/a/b/pull/7" });
  });
  test("the title is the goal's first sentence without the vault pointer", () => {
    expect(prTitle("Game mechanics phase 3, weather and supply (vault plan fleet/plans/feature/x.md: section C2). Deliver: weather.")).toBe("Game mechanics phase 3, weather and supply");
  });
});
