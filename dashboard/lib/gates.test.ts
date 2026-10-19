import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "gates-inbox-"));
const repo = mkdtempSync(join(tmpdir(), "gates-repo-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const g = await import("./gates.ts");
const m = await import("./metrics.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});
const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo }).stdout.toString().trim();
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", ".");
Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
const head = git("rev-parse", "HEAD");
const ship = { id: "gt", path: repo, checks: { pytest: "true", lint: "true" }, gates: { task: ["pytest"], dock: ["pytest", "lint", "nope"] } };

describe("declared gates", () => {
  test("green only for a passing run on the current commit with a clean tree", async () => {
    expect((await g.gateStatus(ship, "task")).gates).toEqual([{ name: "pytest", state: "missing" }]);
    m.recordRun({ ship: "gt", agent: "x", kind: "check", name: "pytest", ok: false, ms: 1, commit: head });
    expect((await g.gateStatus(ship, "task")).gates[0]!.state).toBe("failed");
    m.recordRun({ ship: "gt", agent: "x", kind: "check", name: "pytest", ok: true, ms: 1, commit: "0000000" });
    expect((await g.gateStatus(ship, "task")).gates[0]!.state).toBe("failed");
    m.recordRun({ ship: "gt", agent: "x", kind: "check", name: "pytest", ok: true, ms: 1, commit: head, dirty: true });
    expect((await g.gateStatus(ship, "task")).gates[0]!.state).toBe("failed");
    m.recordRun({ ship: "gt", agent: "x", kind: "check", name: "pytest", ok: true, ms: 1, commit: head });
    const r = await g.gateStatus(ship, "task");
    expect(r.green).toBe(true);
    expect(g.describeGates(r)).toBe(`task gates green on ${head.slice(0, 7)}: pytest.`);
  });
  test("uncommitted changes and unknown checks keep a stage red", async () => {
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const dirty = await g.gateStatus(ship, "task");
    expect(dirty.green).toBe(false);
    expect(g.describeGates(dirty)).toContain("uncommitted changes");
    git("checkout", "--", "a.txt");
    const dock = await g.gateStatus(ship, "dock");
    expect(dock.gates.map((x) => x.state)).toEqual(["green", "missing", "unknown-check"]);
    expect(g.describeGates(dock)).toContain("lint not run on this commit; nope is not a check of this ship");
  });
});
