import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewBranch } from "./dock-review.ts";
import { openDockPr } from "./dock-delivery.ts";
import type { SpawnResult } from "./proc.ts";
import { treeState } from "./ship-checks.ts";
import { availableHosts, hostRunner, localHost, setShipHost, shipHost, type ShipHost } from "./ship-host.ts";
import { leaseVoyageWorktree, voyageHost } from "./voyage-worktree.ts";

const REPO = join(import.meta.dir, "..", "..");

/** A host that records every command and answers from a table. */
function fakeHost(answer: (cmd: string[]) => Partial<SpawnResult> = () => ({}), repo = true): ShipHost & { calls: { cmd: string[]; cwd?: string }[] } {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  return {
    kind: "laptop",
    label: "the laptop",
    calls,
    exec: async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd });
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ms: 1, ...answer(cmd) };
    },
    hasRepo: async () => repo,
    repoPath: async (ship) => ship.path,
    available: async () => true,
    launchRpc: () => {
      throw new Error("not in this test");
    },
  };
}

afterEach(() => setShipHost("laptop", null));

describe("ship hosts", () => {
  test("the local host runs commands here and knows a git checkout", async () => {
    expect((await localHost.exec(["git", "rev-parse", "--is-inside-work-tree"], { timeoutMs: 15_000, cwd: REPO })).stdout).toBe("true");
    expect(await localHost.hasRepo(REPO)).toBe(true);
    expect(await localHost.hasRepo("/nonexistent")).toBe(false);
  });

  test("no host named (older records) is this machine; the laptop is offered only while it can take a voyage", async () => {
    expect(shipHost(undefined)).toBe(localHost);
    expect(shipHost("laptop").kind).toBe("laptop");
    const laptop = fakeHost();
    laptop.available = async () => false;
    setShipHost("laptop", laptop);
    expect(await availableHosts()).toEqual(["local"]);
    laptop.available = async () => true;
    expect(await availableHosts()).toEqual(["local", "laptop"]);
  });

  test("gates read the tree state on the voyage's host", async () => {
    const host = fakeHost((cmd) => (cmd[1] === "rev-parse" ? { stdout: "abc123" } : { stdout: " M a.ts" }));
    expect(await treeState("/w", host)).toEqual({ commit: "abc123", dirty: true });
    expect(host.calls.map((c) => [c.cmd.slice(0, 2).join(" "), c.cwd])).toEqual([["git rev-parse", "/w"], ["git status", "/w"]]);
  });

  test("the dock review and the dock PR run on the host that holds the repo", async () => {
    const host = fakeHost((cmd) => (cmd[1] === "diff" && cmd[2] === "--shortstat" ? { stdout: "1 file changed" } : cmd[2] === "create" ? { stdout: "https://github.com/a/b/pull/9" } : cmd[2] === "view" ? { exitCode: 1 } : {}));
    await reviewBranch("/repo", "main", "feat/x", async () => ({ ok: false }) as never, host);
    expect(host.calls.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "diff").length).toBe(3);
    expect(await openDockPr("/repo", "feat/x", "main", "t", "b", hostRunner(host))).toMatchObject({ ok: true, url: "https://github.com/a/b/pull/9" });
    expect(host.calls.some((c) => c.cmd.join(" ") === "git push -u origin feat/x" && c.cwd === "/repo")).toBe(true);
  });

  test("leasing a worktree asks the host, and refuses without a repo there", async () => {
    const none = fakeHost(undefined, false);
    expect(await leaseVoyageWorktree({ id: "s", path: "/repo" }, "goal", "", none)).toMatchObject({ ok: false, message: expect.stringContaining("no git repo") });
    const failing = fakeHost((cmd) => (cmd.includes("get") ? { exitCode: 1, stderr: "pool empty" } : {}));
    expect(await leaseVoyageWorktree({ id: "s", path: "/repo" }, "goal", "", failing)).toMatchObject({ ok: false, message: expect.stringContaining("pool empty") });
    expect(failing.calls.some((c) => c.cmd[0] === "treehouse" && c.cmd[1] === "get" && c.cwd === "/repo")).toBe(true);
  });

  test("a voyage's host comes from its worktree record; older records are local", () => {
    const inbox = mkdtempSync(join(tmpdir(), "ship-host-"));
    const prev = process.env.FLEET_INBOX;
    process.env.FLEET_INBOX = inbox;
    try {
      const laptop = fakeHost();
      setShipHost("laptop", laptop);
      mkdirSync(join(inbox, "ships", "a"), { recursive: true });
      mkdirSync(join(inbox, "ships", "b"), { recursive: true });
      writeFileSync(join(inbox, "ships", "a", "worktree.json"), JSON.stringify({ ship: "a", path: "/w", host: "laptop" }));
      writeFileSync(join(inbox, "ships", "b", "worktree.json"), JSON.stringify({ ship: "b", path: "/w" }));
      expect(voyageHost("a")).toBe(laptop);
      expect(voyageHost("b")).toBe(localHost);
      expect(voyageHost("none")).toBe(localHost);
    } finally {
      if (prev === undefined) delete process.env.FLEET_INBOX;
      else process.env.FLEET_INBOX = prev;
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});
