import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "routines-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { mkdirSync } = await import("node:fs");
mkdirSync(join(inbox, ".node"), { recursive: true });
const r = await import("./routines.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

describe("routine schedules", () => {
  const at = new Date(2026, 9, 18, 13, 30); // Sun 18 Oct 2026, 13:30 local
  test("every, daily, and weekly read; the next run is strictly later", () => {
    expect(r.nextRun(r.parseSchedule("every 6h")!, at)).toEqual(new Date(2026, 9, 18, 19, 30));
    expect(r.nextRun(r.parseSchedule("daily 08:30")!, at)).toEqual(new Date(2026, 9, 19, 8, 30));
    expect(r.nextRun(r.parseSchedule("daily 13:30")!, at)).toEqual(new Date(2026, 9, 19, 13, 30));
    expect(r.nextRun(r.parseSchedule("weekly mon 09:00")!, at)).toEqual(new Date(2026, 9, 19, 9, 0));
    expect(r.nextRun(r.parseSchedule("weekly sun 13:00")!, at)).toEqual(new Date(2026, 9, 25, 13, 0));
  });
  test("schedules the node cannot honour are refused", () => {
    for (const s of ["every 1m", "hourly", "daily 25:00", "weekly someday 09:00", ""]) expect([s, r.parseSchedule(s)]).toEqual([s, null]);
  });
});

describe("routines file", () => {
  test("bad routines are reported and skipped, good ones kept", () => {
    const f = join(inbox, "r.yaml");
    writeFileSync(f, `routines:\n  - { id: ok-one, every: daily 08:00, job: due-tasks }\n  - { id: Bad, every: daily 08:00, job: x }\n  - { id: both, every: daily 08:00, job: x, agent: alice, prompt: hi }\n  - { id: no-prompt, every: daily 08:00, agent: alice }\n  - { id: when, every: sometimes, job: x }\n  - { id: ok-one, every: daily 09:00, job: x }\n`);
    const { routines, problems } = r.loadRoutines(f);
    expect(routines.map((x) => x.id)).toEqual(["ok-one"]);
    expect(problems.length).toBe(5);
  });
  test("the fleet's routines.yaml reads cleanly and names only built-in jobs", () => {
    const { routines, problems } = r.loadRoutines(join(import.meta.dir, "..", "..", "fleet", "config", "routines.yaml"));
    expect(problems).toEqual([]);
    for (const x of routines) if (x.job) expect(["vault-doctor", "free-models", "due-tasks", "helm-review"]).toContain(x.job);
    for (const x of routines) if (x.job === "helm-review") expect(x.ship).toBeTruthy();
  });
});

describe("running routines", () => {
  const f = join(inbox, "run.yaml");
  writeFileSync(f, `routines:\n  - { id: job-one, every: every 6h, job: count }\n  - { id: report, every: weekly mon 09:00, agent: alice, prompt: Write the report. }\n  - { id: broken, every: daily 08:00, job: missing }\n  - { id: off, every: daily 08:00, job: count, enabled: false }\n`);
  let jobs = 0;
  const sent: [string, string][] = [];
  const deps = { jobs: { count: () => `run ${++jobs}` }, runAgent: async (a: string, t: string) => void sent.push([a, t]), agentExists: (a: string) => a === "alice" };
  test("the first tick schedules; intervals run a few minutes after start", async () => {
    expect(await r.tickRoutines(new Date(2026, 9, 18, 8, 0), deps, f)).toEqual([]);
    expect(await r.tickRoutines(new Date(2026, 9, 18, 8, 4), deps, f)).toEqual(["job-one"]);
    expect(jobs).toBe(1);
  });
  test("due routines run once and move to their next time; failures are recorded, not thrown", async () => {
    const ran = await r.tickRoutines(new Date(2026, 9, 19, 9, 1), deps, f);
    expect(ran.sort()).toEqual(["broken", "job-one", "report"]);
    expect(sent[0]![0]).toBe("alice");
    expect(sent[0]![1]).toContain("Write the report.");
    expect(sent[0]![1]).toContain("notify_captain");
    expect(await r.tickRoutines(new Date(2026, 9, 19, 9, 2), deps, f)).toEqual([]);
    expect(r.routinesHtml()).toContain("Routines");
  });
  test("a routine missed while the node was down runs once, then keeps its schedule", async () => {
    const ran = await r.tickRoutines(new Date(2026, 10, 2, 12, 0), deps, f);
    expect(ran.filter((id) => id === "report")).toEqual(["report"]);
    expect(await r.tickRoutines(new Date(2026, 10, 2, 12, 1), deps, f)).toEqual([]);
    expect(sent.length).toBe(2);
  });
});
