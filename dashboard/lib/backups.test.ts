import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDrillJob, backupsJob, type BackupsDeps } from "./backups.ts";

const dir = mkdtempSync(join(tmpdir(), "backups-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function harness(over: Partial<BackupsDeps> & { reconcile?: { code: number; out: string }; active?: { code: number; out: string } } = {}) {
  const notices: { kind: string; summary: string }[] = [];
  const calls: string[] = [];
  let clock = Date.parse("2026-10-26T12:00:00Z");
  const job = backupsJob({
    platform: "linux",
    envFileExists: () => true,
    stateFile: join(dir, `state-${n++}.json`),
    now: () => new Date(clock),
    notify: ((x: { kind: string; summary: string }) => void notices.push(x)) as never,
    run: async (cmd) => {
      calls.push(cmd.slice(-2).join(" "));
      return cmd.includes("reconcile") ? (over.reconcile ?? { code: 0, out: "/x/litestream.yml is current (5 databases)" }) : (over.active ?? { code: 0, out: "active" });
    },
    ...over,
  });
  return { job, notices, calls, advance: (ms: number) => (clock += ms) };
}

describe("backups job", () => {
  test("skips off the hub", async () => {
    const h = harness({ platform: "darwin" });
    expect(await h.job()).toBe("skipped: not the hub");
    expect(h.calls).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test("not set up: says so, and nudges once a week", async () => {
    const h = harness({ envFileExists: () => false });
    expect(await h.job()).toBe("not set up (see bin/fleet-backup)");
    expect(h.notices.length).toBe(1);
    h.advance(3 * 86_400_000);
    await h.job();
    expect(h.notices.length).toBe(1);
    h.advance(5 * 86_400_000);
    await h.job();
    expect(h.notices.length).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test("an incomplete env file (reconcile exit 3) counts as not set up", async () => {
    const h = harness({ reconcile: { code: 3, out: "Backups are not set up" } });
    expect(await h.job()).toBe("not set up (see bin/fleet-backup)");
    expect(h.notices).toEqual([]);
  });

  test("set up and healthy: quiet summary", async () => {
    const h = harness();
    expect(await h.job()).toBe("replicating; config current");
    expect(h.notices).toEqual([]);
  });

  test("service down: a blocked notice, once a day", async () => {
    const h = harness({ active: { code: 3, out: "inactive" } });
    expect(await h.job()).toContain("fleet-litestream is inactive");
    expect(h.notices.map((x) => x.kind)).toEqual(["blocked"]);
    h.advance(3_600_000);
    await h.job();
    expect(h.notices.length).toBe(1);
    h.advance(86_400_000);
    await h.job();
    expect(h.notices.length).toBe(2);
  });

  test("reconcile failure is an info notice", async () => {
    const h = harness({ reconcile: { code: 1, out: "error: boom" } });
    expect(await h.job()).toContain("reconcile failed (exit 1)");
    expect(h.notices.map((x) => x.kind)).toEqual(["info"]);
  });

  test("reconcile that changed the config says so", async () => {
    const h = harness({ reconcile: { code: 0, out: "wrote /x/litestream.yml (6 databases)\n  added   /inbox/ships/d/ship.db\nrestarted fleet-litestream" } });
    const out = await h.job();
    expect(out).toContain("config updated");
    expect(out).toContain("ships/d/ship.db");
    expect(h.notices).toEqual([]);
  });

  test("keeps the state file readable", async () => {
    const h = harness({ envFileExists: () => false });
    await h.job();
    expect(readFileSync(join(dir, `state-${n - 1}.json`), "utf8")).toContain("notSetUpNotice");
  });
});

describe("backup-drill job", () => {
  const PASS = "ok    /i/a.db: restored and checked in 2s\n        t   4 rows\nok    /i/b.db: restored and checked in 3s\n\ntotal: 15s\ndrill passed";
  function drill(out: string, code: number, over: Partial<BackupsDeps> = {}) {
    const notices: { kind: string; summary: string; detail: string }[] = [];
    const calls: string[][] = [];
    const job = backupDrillJob({
      platform: "linux",
      envFileExists: () => true,
      notify: ((x: { kind: string; summary: string; detail: string }) => void notices.push(x)) as never,
      run: async (cmd) => (calls.push(cmd), { code, out }),
      ...over,
    });
    return { job, notices, calls };
  }

  test("skips off the hub", async () => {
    const h = drill(PASS, 0, { platform: "darwin" });
    expect(await h.job()).toBe("skipped: not the hub");
    expect(h.calls).toEqual([]);
  });

  test("not set up: says so without a notice", async () => {
    const h = drill(PASS, 0, { envFileExists: () => false });
    expect(await h.job()).toBe("not set up (see bin/fleet-backup)");
    expect(h.calls).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  test("pass: counts databases and seconds, quiet", async () => {
    const h = drill(PASS, 0);
    expect(await h.job()).toBe("drill passed: 2 databases in 15s");
    expect(h.calls[0]?.slice(-1)).toEqual(["drill"]);
    expect(h.notices).toEqual([]);
  });

  test("fail: one blocked notice with the FAIL lines", async () => {
    const h = drill("FAIL  /i/a.db: restore failed (boom)\nok    /i/b.db: restored and checked in 3s\n\ntotal: 4s\ndrill FAILED", 1);
    expect(await h.job()).toContain("drill failed (exit 1)");
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]?.kind).toBe("blocked");
    expect(h.notices[0]?.summary).toBe("Hub backup drill failed");
    expect(h.notices[0]?.detail).toContain("FAIL  /i/a.db: restore failed (boom)");
    expect(h.notices[0]?.detail).not.toContain("ok    /i/b.db");
    expect(h.notices[0]?.detail).toContain("bin/hub fleet-backup drill");
  });

  test("a timeout is a failure too, with the tail of the output", async () => {
    const h = drill("still restoring", 124);
    expect(await h.job()).toContain("exit 124");
    expect(h.notices[0]?.detail).toContain("timed out");
    expect(h.notices[0]?.detail).toContain("still restoring");
  });

  test("lag of 500 rows or more is a warning, not a notice", async () => {
    const h = drill(`${PASS}\n        t   restored 1, live 900 (live ahead by 899)`, 0);
    expect(await h.job()).toContain("replication may be lagging");
    const small = drill(`${PASS}\n        t   restored 1, live 10 (live ahead by 9)`, 0);
    expect(await small.job()).toBe("drill passed: 2 databases in 15s");
    expect(h.notices).toEqual([]);
  });
});
