import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { architectGitRead, gitRead, gitReadAllowed, gitReadArgv } from "./git-read.ts";
import type { ShipHost } from "./ship-host.ts";

const argv = (a: Parameters<typeof gitReadArgv>[0]) => {
  const r = gitReadArgv(a);
  return r.ok ? r.argv.slice(3) : r.message;
};

describe("git_read argv", () => {
  test("a fixed argv per op", () => {
    expect(argv({ op: "status" })).toEqual(["status", "--short", "--branch"]);
    expect(argv({ op: "branch" })).toEqual(["branch", "--show-current"]);
    expect(argv({ op: "log" })).toEqual(["log", "--oneline", "--decorate", "-n", "10"]);
    expect(argv({ op: "log", n: 3 })).toEqual(["log", "--oneline", "--decorate", "-n", "3"]);
    expect(argv({ op: "log", n: 500 })).toEqual(["log", "--oneline", "--decorate", "-n", "50"]);
    expect(argv({ op: "diff" })).toEqual(["diff", "--no-ext-diff", "--no-textconv"]);
    expect(argv({ op: "diff", ref: "main..HEAD", paths: ["src/a.ts", "docs"] })).toEqual(["diff", "--no-ext-diff", "--no-textconv", "main..HEAD", "--", "src/a.ts", "docs"]);
    expect(argv({ op: "show" })).toEqual(["show", "--no-ext-diff", "--no-textconv", "HEAD"]);
    expect(argv({ op: "show", ref: "origin/main~2", paths: ["a.py"] })).toEqual(["show", "--no-ext-diff", "--no-textconv", "origin/main~2", "--", "a.py"]);
  });

  test("never passes a shell string or a write operation", () => {
    const r = gitReadArgv({ op: "diff" });
    expect(r.ok && r.argv.slice(0, 3)).toEqual(["git", "--no-pager", "--no-optional-locks"]);
    for (const op of ["push", "checkout", "commit", "config", "", undefined, 3]) expect(gitReadArgv({ op }).ok).toBe(false);
  });

  test("refuses options and bad refs", () => {
    for (const ref of ["--output=/tmp/x", "-p", "a b", "a;rm", "$(x)", "a`b`", "x\ny", " HEAD", 5]) expect(gitReadArgv({ op: "diff", ref }).ok).toBe(false);
    expect(gitReadArgv({ op: "show", ref: "--exec=sh" }).ok).toBe(false);
    expect(gitReadArgv({ op: "diff", ref: "HEAD~1" }).ok).toBe(true);
  });

  test("paths stay relative and inside the tree", () => {
    for (const p of ["/etc/passwd", "../x", "a/../../b", "~/x", "-p", ":(top)x", "", "a\nb", "a\0b", 4]) expect(gitReadArgv({ op: "diff", paths: [p] }).ok).toBe(false);
    expect(gitReadArgv({ op: "diff", paths: "a" }).ok).toBe(false);
    expect(gitReadArgv({ op: "diff", paths: Array(21).fill("a") }).ok).toBe(false);
    expect(gitReadArgv({ op: "log", n: 0 }).ok).toBe(false);
    expect(gitReadArgv({ op: "log", n: "x" }).ok).toBe(false);
  });
});

function fakeHost(res: Partial<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; unreachable: boolean }>) {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  const host = {
    kind: "vm",
    label: "a VM",
    exec: async (cmd: string[], opts: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts.cwd });
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ms: 1, ...res };
    },
  } as unknown as ShipHost;
  return { host, calls };
}

describe("gitRead", () => {
  test("only the ship's lead and helmsman", async () => {
    expect(gitReadAllowed("kin", "kin-lead")).toBe(true);
    expect(gitReadAllowed("kin", "kin-helmsman")).toBe(true);
    expect(gitReadAllowed("kin", "kin-builder")).toBe(false);
    expect(gitReadAllowed("kin", "pochteca-lead")).toBe(false);
    const { host, calls } = fakeHost({});
    expect((await gitRead("kin", "kin-builder", { op: "status" }, { host, cwd: "/w" })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("runs the argv on the host in the worktree and returns the output", async () => {
    const { host, calls } = fakeHost({ stdout: "## main\n M a.ts\n" });
    const r = await gitRead("kin", "kin-lead", { op: "status" }, { host, cwd: "/work/kin" });
    expect(r).toEqual({ ok: true, message: "## main\n M a.ts" });
    expect(calls).toEqual([{ cmd: ["git", "--no-pager", "--no-optional-locks", "status", "--short", "--branch"], cwd: "/work/kin" }]);
  });

  test("refused arguments never reach the host; failures and long output are shaped", async () => {
    const bad = fakeHost({});
    expect((await gitRead("kin", "kin-lead", { op: "diff", ref: "--output=x" }, { host: bad.host, cwd: "/w" })).ok).toBe(false);
    expect(bad.calls).toEqual([]);
    expect(await gitRead("kin", "kin-lead", { op: "show", ref: "nope" }, { host: fakeHost({ exitCode: 128, stderr: "fatal: bad revision" }).host, cwd: "/w" })).toEqual({ ok: false, message: "fatal: bad revision" });
    expect((await gitRead("kin", "kin-lead", { op: "diff" }, { host: fakeHost({ timedOut: true, exitCode: -1 }).host, cwd: "/w" })).ok).toBe(false);
    expect(await gitRead("kin", "kin-lead", { op: "diff" }, { host: fakeHost({}).host, cwd: "/w" })).toEqual({ ok: true, message: "(no output)" });
    const long = await gitRead("kin", "kin-lead", { op: "diff" }, { host: fakeHost({ stdout: "x".repeat(20_000) }).host, cwd: "/w" });
    expect(long.ok && long.message.length).toBeLessThan(16_300);
    expect(long.message).toContain("more characters cut");
  });
});

describe("architectGitRead", () => {
  test("only the architect, with a ship; runs in that ship's repo", async () => {
    const { host, calls } = fakeHost({ stdout: "abc1234 a commit\n" });
    expect((await architectGitRead("kin-lead", { ship: "kin", op: "log" }, { host, cwd: "/r" })).ok).toBe(false);
    expect((await architectGitRead("architect", { op: "log" }, { host, cwd: "/r" })).message).toContain("ship is required");
    expect((await architectGitRead("architect", { ship: "kin", op: "diff", ref: "--output=x" }, { host, cwd: "/r" })).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(await architectGitRead("architect", { ship: "kin", op: "log", n: 3 }, { host, cwd: "/r" })).toEqual({ ok: true, message: "abc1234 a commit" });
    expect(calls).toEqual([{ cmd: ["git", "--no-pager", "--no-optional-locks", "log", "--oneline", "--decorate", "-n", "3"], cwd: "/r" }]);
  });
});

describe("the officers' tools", () => {
  test("architect, lead and helmsman templates enable grep, find and ls", () => {
    for (const id of ["architect", "lead", "helmsman"]) {
      const y = parse(readFileSync(join(import.meta.dir, "..", "..", "agents", id, "agent.yaml"), "utf8")) as { tools?: string[] };
      expect(y.tools).toEqual(expect.arrayContaining(["+grep", "+find", "+ls"]));
      expect(y.tools).not.toContain("-bash");
    }
  });
});
