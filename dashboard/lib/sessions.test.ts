import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "sessions-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const q = await import("./decision-queue.ts");
const s = await import("./sessions.ts");
const w = await import("./voyage-worktree.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

describe("the decision queue", () => {
  test("items are checked, kept in the captain's order, moved, dropped, and finished by their record", async () => {
    expect(q.addQueueItem({ kind: "merge", ship: "kinwork", title: "x y z w" })).toMatchObject({ ok: false });
    expect(q.addQueueItem({ kind: "design-session", ship: "kinwork", title: "x" })).toMatchObject({ ok: false });
    const a = q.addQueueItem({ kind: "design-session", ship: "kinwork", title: "Search page redesign", request: "Explore five patterns" });
    await Bun.sleep(5);
    const b = q.addQueueItem({ kind: "spec-session", ship: "pochteca", title: "Ollin ledger API", by: "pochteca-lead" });
    if (!a.ok || !b.ok) throw new Error("add failed");
    expect(q.queueView().open.map((i) => i.title)).toEqual(["Search page redesign", "Ollin ledger API"]);
    expect(q.moveQueueItem(b.item.id, "up")).toBe(true);
    expect(q.queueView().open.map((i) => i.ship)).toEqual(["pochteca", "kinwork"]);
    expect(q.moveQueueItem(b.item.id, "up")).toBe(false);
    q.updateQueueItem(a.item.id, { status: "active", record: "/vault/fleet/voyages/kinwork/s.md" });
    q.finishQueueItem("/vault/fleet/voyages/kinwork/s.md", "done");
    q.updateQueueItem(b.item.id, { status: "dropped" });
    const v = q.queueView();
    expect(v.open).toEqual([]);
    expect(v.done.map((i) => [i.title, i.status]).sort()).toEqual([["Ollin ledger API", "dropped"], ["Search page redesign", "done"]]);
    expect(q.readQueue().find((i) => i.id === b.item.id)!.by).toBe("pochteca-lead");
  });
});

describe("sessions", () => {
  test("the designer runs design sessions and the architect spec sessions, on design/ and spec/ branches", () => {
    expect([s.sessionKindOf("designer"), s.sessionKindOf("architect"), s.sessionKindOf("kinwork-lead")]).toEqual(["design", "spec", null]);
    expect(s.sessionBranch("design", "search-page")).toBe("design/search-page");
  });

  test("the brief makes rounds end with a question, never choose for the captain, and wrap up with voyage_dock", () => {
    const text = s.sessionBrief({ ship: "kinwork", kind: "design", topic: "Search page redesign", record: "/v/s.md", branch: "design/search" });
    expect(text).toContain("New design session for kinwork: Search page redesign");
    expect(text).toContain("choose: true");
    expect(text).toContain("End every round with a question");
    expect(text).toContain("Never choose a direction yourself");
    expect(text).toContain('"## Design brief"');
    expect(text).toContain("voyage_dock");
    expect(s.sessionBrief({ ship: "p", kind: "spec", topic: "t", record: "r", branch: "spec/t" })).toContain("acceptance criteria");
  });

  test("the brief comes back out of the archived scratchpad, up to the next section", () => {
    const scratch = "Round 1: five options.\n\n## Design brief\n\nVariant 2 with 4's filter bar.\n- tokens: quiet\n\n## Notes\n\nlater";
    expect(s.extractBrief(scratch, "design")).toBe("Variant 2 with 4's filter bar.\n- tokens: quiet");
    expect(s.extractBrief("## Spec brief\n\nGoal: x", "spec")).toBe("Goal: x");
    expect(s.extractBrief("no brief here", "design")).toBe("");
  });

  test("the node finds the ship whose open session has an officer as its guest", () => {
    mkdirSync(join(inbox, "ships", "kinwork"), { recursive: true });
    writeFileSync(join(inbox, "ships", "kinwork", "worktree.json"), JSON.stringify({ ship: "kinwork", path: "/w", leaseId: "l", branch: "design/x", base: "main", gitDir: "", primaryBranch: "main", started: "", host: "laptop" }));
    expect(w.guestShip("designer")).toBeUndefined();
    w.setVoyageGuest("kinwork", "designer");
    expect(w.guestShip("designer")).toBe("kinwork");
    expect(w.guestShip("architect")).toBeUndefined();
  });
});

describe("bin/launch boards a session guest", () => {
  test("FLEET_GUEST_SHIP puts the designer aboard that ship as the fleet's designer; anyone else stays an officer", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-guest-"));
    mkdirSync(join(dir, "ships"));
    writeFileSync(join(dir, "ships", "kin.yaml"), "id: kin\npath: /tmp\norchestrator: lead\ncrew:\n  - lead\nmode: m\n");
    const py = `import importlib.util, importlib.machinery, json, os, pathlib, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
m.ships_dir = lambda: pathlib.Path(sys.argv[2]) / "ships"
out = {}
for agent in ("designer", "alice"):
    aboard = None
    guest_ship = os.environ.get("FLEET_GUEST_SHIP", "")
    if aboard is None and guest_ship and agent in ("designer", "architect"):
        y = m.ships_dir() / f"{guest_ship}.yaml"
        if y.is_file():
            aboard = m.ship_config(y)
            aboard["id"] = guest_ship
    out[agent] = aboard and aboard["id"]
print(json.dumps(out))`;
    const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", py, join(import.meta.dir, "..", "..", "bin", "launch"), dir], { env: { ...process.env, FLEET_GUEST_SHIP: "kin", FLEET_SHIP_OVERLAY_DIR: join(dir, "none") } });
    expect(JSON.parse(r.stdout.toString())).toEqual({ designer: "kin", alice: null });
    const src = readFileSync(join(import.meta.dir, "..", "..", "bin", "launch"), "utf8");
    expect(src).toContain('if aboard is None and guest_ship and agent_id in ("designer", "architect"):');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("bin/launch compiles cleanly", () => {
  test("no SyntaxWarning (a string next to a parenthesised expression is a call, and fails every crew launch)", () => {
    const r = Bun.spawnSync(["/usr/bin/python3", "-W", "error::SyntaxWarning", "-c", "import sys, ast; ast.parse(open(sys.argv[1]).read())", join(import.meta.dir, "..", "..", "bin", "launch")]);
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});
