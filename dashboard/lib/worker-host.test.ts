import { describe, expect, test } from "bun:test";
import { workerHost } from "./worker-host.ts";

const cfg = (before: () => Promise<void>, calls: string[]) => ({
  kind: "vm" as const,
  label: "the exe.dev VM v1",
  url: () => "https://v1.exe.xyz:8790",
  auth: async () => ({}),
  available: async () => true,
  before,
  fetch: async (url: string) => (calls.push(url), Response.json({ ships: [{ id: "kin", path: "/k" }], stdout: "", stderr: "", exitCode: 0, timedOut: false, ms: 0, files: {} })),
});

describe("workerHost before hook", () => {
  test("runs before every HTTP call", async () => {
    const calls: string[] = [];
    let before = 0;
    const host = workerHost(cfg(async () => void (before++, calls.push("before")), calls));
    expect(await host.repoPath({ id: "kin", path: "" })).toBe("/k");
    await host.exec(["true"], { timeoutMs: 1000, cwd: "/k" });
    expect(before).toBe(2);
    expect(calls).toEqual(["before", "https://v1.exe.xyz:8790/host/ships", "before", "https://v1.exe.xyz:8790/host/exec"]);
  });

  test("a rejection fails like an unreachable worker, with no request made", async () => {
    const calls: string[] = [];
    const host = workerHost(cfg(async () => Promise.reject(new Error("Could not wake v1")), calls));
    const r = await host.exec(["true"], { timeoutMs: 1000, cwd: "/k" });
    expect(r.exitCode).toBe(125);
    expect(r.stderr).toContain("Could not wake v1");
    expect(await host.repoPath({ id: "kin", path: "" })).toBe("");
    expect(calls).toEqual([]);
  });

  test("the RPC stream ends with a could-not-reach message when the hook rejects", async () => {
    const host = workerHost(cfg(async () => Promise.reject(new Error("asleep")), []));
    const rpc = host.launchRpc!("kin-lead", { FLEET_CREW_TOKEN: "t" }, { ship: "kin", worktree: null } as never);
    expect(await rpc.exited).toBe(-1);
    expect(await new Response(rpc.stderr).text()).toContain("could not reach the worker on the exe.dev VM v1");
  });
});
