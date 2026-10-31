import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "routines-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { mkdirSync } = await import("node:fs");
mkdirSync(join(inbox, ".node"), { recursive: true });
// Ships come from scratch folders, never the real fleet/ships.
const shipsBase = join(inbox, "ships-base");
const shipsOverlay = join(inbox, "ships-overlay");
mkdirSync(shipsBase, { recursive: true });
mkdirSync(shipsOverlay, { recursive: true });
const prevShips = { base: process.env.FLEET_SHIPS_DIR, overlay: process.env.FLEET_SHIP_OVERLAY_DIR };
process.env.FLEET_SHIPS_DIR = shipsBase;
process.env.FLEET_SHIP_OVERLAY_DIR = shipsOverlay;
const r = await import("./routines.ts");
afterAll(() => {
  for (const [k, v] of [["FLEET_SHIPS_DIR", prevShips.base], ["FLEET_SHIP_OVERLAY_DIR", prevShips.overlay]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
    const { routines, problems } = r.loadFleetRoutines(f);
    expect(routines.map((x) => x.id)).toEqual(["ok-one"]);
    expect(problems.length).toBe(5);
  });
  test("the fleet's routines.yaml reads cleanly and names only built-in jobs", () => {
    const { routines, problems } = r.loadFleetRoutines(join(import.meta.dir, "..", "..", "fleet", "config", "routines.yaml"));
    expect(problems).toEqual([]);
    for (const x of routines) if (x.job) expect(["vault-doctor", "free-models", "due-tasks", "proactive", "helm-review", "codegraph-sync", "session-archive", "exe-idle", "golden-refresh", "backups", "backup-drill"]).toContain(x.job);
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

describe("ship routines", () => {
  const empty = join(inbox, "empty.yaml");
  beforeAll(() => {
    writeFileSync(empty, "routines: []\n");
    writeFileSync(join(shipsBase, "kinwork.yaml"), "id: kinwork\nroutines:\n  nightly-checks:\n    every: daily 02:00\n    agent: lead\n    prompt: Run the checks and report.\n  helm-review:\n    every: weekly fri 16:30\n    job: helm-review\n  old-one:\n    every: daily 03:00\n    job: helm-review\n  bad:\n    every: sometimes\n    job: helm-review\n");
    writeFileSync(join(shipsOverlay, "kinwork.yaml"), "routines:\n  helm-review:\n    enabled: false\n  old-one: null\n");
  });
  test("a ship's routines come from its merged config: the overlay changes one by id or removes it", () => {
    const { routines, problems } = r.loadShipRoutines();
    expect(routines.map((x) => `${x.id}${x.enabled ? "" : " (off)"}`)).toEqual(["kinwork/nightly-checks", "kinwork/helm-review (off)"]);
    expect(routines.every((x) => x.layer === "kinwork" && x.ship === "kinwork")).toBe(true);
    expect(problems).toEqual(['kinwork/bad has a schedule the node does not read: "sometimes"']);
  });
  test("a ship routine runs on the role aboard that ship; skipped while the role is ashore or over budget", async () => {
    const sent: string[] = [];
    let aboard = false;
    let broke = false;
    const deps = { jobs: {}, runAgent: async (a: string) => void sent.push(a), agentExists: (a: string) => aboard && a === "kinwork-lead", budgetRefusal: async () => (broke ? "kinwork-lead has spent its budget" : null) };
    await r.tickRoutines(new Date(2026, 9, 20, 1, 0), deps, empty); // schedules for 02:00
    await r.tickRoutines(new Date(2026, 9, 20, 2, 1), deps, empty);
    expect(sent).toEqual([]);
    expect(r.routinesHtml()).toContain("skipped: lead is not aboard kinwork");
    aboard = true;
    broke = true;
    await r.tickRoutines(new Date(2026, 9, 21, 2, 1), deps, empty);
    expect(sent).toEqual([]);
    expect(r.routinesHtml()).toContain("skipped: kinwork-lead has spent its budget");
    broke = false;
    await r.tickRoutines(new Date(2026, 9, 22, 2, 1), deps, empty);
    expect(sent).toEqual(["kinwork-lead"]);
  });
});

describe("skip when nothing changed (N2)", () => {
  test("a watching routine runs, then skips while its inputs are unchanged, and runs again once they change", async () => {
    const vault = join(inbox, "vault");
    mkdirSync(join(vault, "inbox"), { recursive: true });
    const prevVault = process.env.ALICE_VAULT;
    process.env.ALICE_VAULT = vault;
    const f = join(inbox, "watch.yaml");
    writeFileSync(f, "routines:\n  - { id: triage, every: daily 08:00, agent: alice, prompt: Triage., watch: [\"vault:inbox\"] }\n  - { id: bad-watch, every: daily 08:00, job: count, watch: [\"vault:../x\"] }\n");
    const sent: string[] = [];
    // Only Alice's sends count (the ship fixtures above run in the same ticks).
    const deps = { jobs: {}, runAgent: async (a: string) => void (a === "alice" && sent.push(a)), agentExists: () => true };
    expect(r.loadFleetRoutines(f).problems[0]).toContain("watches something the node does not read");
    writeFileSync(join(vault, "inbox", "a.md"), "one");
    await r.tickRoutines(new Date(2026, 10, 3, 7, 0), deps, f);
    await r.tickRoutines(new Date(2026, 10, 3, 8, 1), deps, f);
    expect(sent.length).toBe(1);
    await r.tickRoutines(new Date(2026, 10, 4, 8, 1), deps, f);
    expect(sent.length).toBe(1);
    process.env.FLEET_ROUTINES_FILE = f;
    expect(r.routinesHtml()).toContain("skipped: nothing changed in vault:inbox");
    delete process.env.FLEET_ROUTINES_FILE;
    writeFileSync(join(vault, "inbox", "b.md"), "two");
    await r.tickRoutines(new Date(2026, 10, 5, 8, 1), deps, f);
    expect(sent.length).toBe(2);
    if (prevVault === undefined) delete process.env.ALICE_VAULT;
    else process.env.ALICE_VAULT = prevVault;
  });
  test("helm reviews watch their own ship by default", () => {
    const { routines } = r.loadShipRoutines();
    expect(routines.find((x) => x.id === "kinwork/helm-review")?.watch).toEqual(["ship:kinwork"]);
    expect(routines.find((x) => x.id === "kinwork/nightly-checks")?.watch).toEqual([]);
  });
});
