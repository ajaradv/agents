import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = mkdtempSync(join(tmpdir(), "ships-base-"));
const overlay = join(mkdtempSync(join(tmpdir(), "ships-overlay-")), "ships");
const inbox = mkdtempSync(join(tmpdir(), "ships-inbox-"));
const prev = { b: process.env.FLEET_SHIPS_DIR, o: process.env.FLEET_SHIP_OVERLAY_DIR, i: process.env.FLEET_INBOX };
process.env.FLEET_SHIPS_DIR = base;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
process.env.FLEET_INBOX = inbox;
const c = await import("./ship-config.ts");
const m = await import("./metrics.ts");
afterAll(() => {
  m._closeMetrics();
  for (const [k, v] of [["FLEET_SHIPS_DIR", prev.b], ["FLEET_SHIP_OVERLAY_DIR", prev.o], ["FLEET_INBOX", prev.i]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

writeFileSync(join(base, "sc.yaml"), `id: sc
path: /repo
# committed setup
orchestrator: firstmate
crew: []
crew_budgets:
  scout: 2
checks:
  pytest: just pytest
gates:
  dock: [pytest]
`);

describe("ship config layers", () => {
  test("merge: maps key by key, lists and values replace, null removes", () => {
    expect(c.mergeConfig({ a: 1, m: { x: 1, y: 2 }, l: [1, 2] }, { m: { y: 3, z: 4 }, l: [9], a: null })).toEqual({ m: { x: 1, y: 3, z: 4 }, l: [9] });
    expect(c.configDiff({ m: { x: 1 }, l: [1] }, { m: { x: 2 }, l: [1], n: true })).toEqual([
      { path: ["m", "x"], old: 1, value: 2 },
      { path: ["n"], old: undefined, value: true },
    ]);
  });

  test("edits go to the overlay, never the base; the merged view and the log follow", async () => {
    const baseBefore = readFileSync(join(base, "sc.yaml"), "utf8");
    await c.editShipConfig("sc", (doc) => {
      doc.set("orchestrator", "lead");
      doc.set("crew", doc.createNode(["lead", "helmsman"]));
      doc.deleteIn(["crew_budgets", "scout"]);
      doc.setIn(["checks", "lint"], "just lint");
    }, { by: "captain", why: "crew up" });
    expect(readFileSync(join(base, "sc.yaml"), "utf8")).toBe(baseBefore);
    const ov = readFileSync(join(overlay, "sc.yaml"), "utf8");
    expect(ov).toContain("orchestrator: lead");
    expect(ov).toContain("scout: null");
    expect(ov).not.toContain("pytest");
    const merged = c.readShipConfig("sc")!;
    expect(merged).toMatchObject({ orchestrator: "lead", crew: ["lead", "helmsman"], crew_budgets: {}, checks: { pytest: "just pytest", lint: "just lint" }, gates: { dock: ["pytest"] } });
    expect(JSON.parse(readFileSync(join(inbox, ".node", "ships", "sc.json"), "utf8"))).toEqual(merged);
    const log = c.recentConfigChanges("sc");
    expect(log.map((l) => l.key).sort()).toEqual(["checks.lint", "crew", "crew_budgets.scout", "orchestrator"]);
    expect(log[0]).toMatchObject({ by: "captain", why: "crew up" });
  });

  test("an overlay-only key that is removed leaves the overlay; nothing changed writes nothing", async () => {
    await c.editShipConfig("sc", (doc) => doc.deleteIn(["checks", "lint"]), { by: "captain" });
    expect(readFileSync(join(overlay, "sc.yaml"), "utf8")).not.toContain("lint");
    expect(await c.editShipConfig("sc", () => {})).toEqual([]);
    expect(c.readShipConfig("nope")).toBeNull();
    expect(existsSync(join(overlay, "nope.yaml"))).toBe(false);
  });
});

describe("bin/launch reads the merged config", () => {
  const launch = join(import.meta.dir, "..", "..", "bin", "launch");
  const py = (file: string) => {
    const code = `import importlib.util, importlib.machinery, json, pathlib, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
print(json.dumps(m.ship_config(pathlib.Path(sys.argv[2]))))`;
    const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", code, launch, file], { env: { ...process.env } });
    return JSON.parse(r.stdout.toString() || "null");
  };
  test("from the node's JSON when it is current, else by merging base and overlay itself", async () => {
    await c.editShipConfig("sc", (doc) => {
      doc.set("crew", doc.createNode(["lead", "scout"]));
      doc.deleteIn(["crew_budgets", "scout"]);
    }, { by: "captain" });
    const viaJson = py(join(base, "sc.yaml"));
    expect(viaJson).toEqual(c.readShipConfig("sc"));
    // Hand-edit the overlay: the JSON is now older, so the launcher merges the files.
    await Bun.sleep(20);
    writeFileSync(join(overlay, "sc.yaml"), `${readFileSync(join(overlay, "sc.yaml"), "utf8")}mode: direct-PR\n`);
    const merged = py(join(base, "sc.yaml"));
    expect(merged).toMatchObject({ id: "sc", orchestrator: "lead", crew: ["lead", "scout"], mode: "direct-PR", checks: { pytest: "just pytest" } });
    expect(merged.crew_budgets).toEqual({});
  });
});

describe("bin/launch: the ship's preview URL", () => {
  test("`preview:` reaches the crew prompt with the screenshot rule; no preview, no line", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-preview-"));
    const file = join(dir, "ship.yaml");
    writeFileSync(file, "id: x\nmode: m\npreview: http://localhost:3000\n");
    const py = `import importlib.util, importlib.machinery, json, pathlib, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
d = m.parse_simple_yaml(pathlib.Path(sys.argv[2]))
print(json.dumps({"with": m.preview_line(d), "without": m.preview_line({"id": "x"})}))`;
    const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", py, join(import.meta.dir, "..", "..", "bin", "launch"), file]);
    const out = JSON.parse(r.stdout.toString()) as { with: string; without: string };
    expect(out.with).toContain("`http://localhost:3000`");
    expect(out.with).toContain("fleet-shot");
    expect(out.without).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});
