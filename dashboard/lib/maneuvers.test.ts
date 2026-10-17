import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeManeuver, findManeuver, launchRefusal, maneuverAvailability, parseManeuvers } from "./maneuvers.ts";

const decls = parseManeuvers({
  verify: { checks: ["lint", "pytest"], by: ["lead", "scout", "designer"] },
  build: { adw: "adw_plan_build_test", needs: ["designer"], gates: ["task"] },
  release: { adw: "adw_ship", go: true },
  both: { checks: ["lint"], adw: "adw_x" },
  neither: { by: ["lead"] },
  "Bad Name": { checks: ["lint"] },
  typo: { checks: ["lint", "mypy"] },
});

const ship = (over: Partial<{ crew: string[]; gates: { task: string[]; dock: string[] }; adws: string[] }> = {}) => ({
  crew: ["lead", "scout"],
  checks: { lint: "true", pytest: "true" },
  gates: { task: ["pytest"], dock: [] },
  adws: ["adw_plan_build_test", "adw_ship", "adw_review"],
  maneuvers: decls,
  ...over,
});

describe("maneuver declarations", () => {
  test("parse: one of checks or adw, `by` defaults to the lead, bad entries dropped", () => {
    expect(decls.map((m) => m.name)).toEqual(["verify", "build", "release", "typo"]);
    expect(decls.find((m) => m.name === "build")).toMatchObject({ kind: "adw", by: ["lead"], needs: ["designer"], gates: ["task"], go: false });
    expect(decls.find((m) => m.name === "verify")).toMatchObject({ kind: "checks", checks: ["lint", "pytest"] });
  });

  test("locked when a needed role, gate stage, check, or ADW is missing", () => {
    const all = maneuverAvailability(ship(), "lead");
    const by = (n: string) => all.find((m) => m.name === n)!;
    expect(by("verify").unlocked).toBe(true);
    expect(by("build").locked).toEqual(["needs a designer aboard"]);
    expect(by("typo").locked).toEqual(["check mypy is not one of the ship's checks"]);
    const noGates = maneuverAvailability(ship({ crew: ["lead", "designer"], gates: { task: [], dock: [] }, adws: [] }), "lead");
    expect(noGates.find((m) => m.name === "build")!.locked).toEqual(["needs the ship to declare task gates", "adw_plan_build_test is not in the repo's adws/"]);
  });

  test("undeclared repo ADWs stay the lead's; declared ADWs are not listed twice", () => {
    const all = maneuverAvailability(ship(), "lead");
    expect(all.map((m) => m.name)).toEqual(["verify", "build", "release", "typo", "adw_review"]);
    expect(all.at(-1)).toMatchObject({ declared: false, by: ["lead"], yours: true });
    expect(maneuverAvailability(ship(), "scout").find((m) => m.name === "adw_review")!.yours).toBe(false);
    // Older calls name the ADW, not the declaration.
    expect(findManeuver(all, "adw_plan_build_test")!.name).toBe("build");
  });

  test("launch: role permission, Go-only, and locks; a Go skips the role but never a lock", () => {
    const scout = maneuverAvailability(ship(), "scout");
    const lead = maneuverAvailability(ship(), "lead");
    const of = (all: typeof lead, n: string) => findManeuver(all, n)!;
    expect(launchRefusal(of(scout, "verify"), "scout", false)).toBeNull();
    expect(launchRefusal(of(scout, "adw_review"), "scout", false)).toContain("launched by lead, not by a scout");
    expect(launchRefusal(of(lead, "release"), "lead", false)).toContain("only on the captain's Go");
    expect(launchRefusal(of(lead, "release"), "lead", true)).toBeNull();
    expect(launchRefusal(of(scout, "adw_review"), "scout", true)).toBeNull();
    expect(launchRefusal(of(lead, "build"), "lead", true)).toContain("locked: needs a designer aboard");
    expect(of(lead, "release").yours).toBe(false);
  });

  test("described in one line", () => {
    const all = maneuverAvailability(ship(), "lead");
    expect(describeManeuver(findManeuver(all, "verify")!)).toBe("verify: checks lint → pytest (deterministic), by lead, scout, designer");
    expect(describeManeuver(findManeuver(all, "build")!)).toBe("build: SSSF adw_plan_build_test, by lead; must pass task gates; locked: needs a designer aboard");
    expect(describeManeuver(findManeuver(all, "release")!)).toBe("release: SSSF adw_ship, captain's Go only");
  });
});

describe("bin/launch reads maneuvers", () => {
  test("nested maneuver fields never overwrite the ship's checks; tools go to the roles in `by`", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-yaml-"));
    const file = join(dir, "ship.yaml");
    writeFileSync(file, "id: x\ncrew:\n  - lead\nchecks:\n  lint: just lint\n  pytest: just pytest\nmaneuvers:\n  verify:\n    checks: [lint, pytest]\n    by:\n      - lead\n      - scout\n  release:\n    adw: adw_ship\n    go: true\nmode: m\n");
    const py = `import importlib.util, importlib.machinery, json, pathlib, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
d = m.parse_simple_yaml(pathlib.Path(sys.argv[2]))
print(json.dumps({"checks": d["checks"], "mode": d["mode"], "scout": m.launchable_maneuvers(d, "scout", pathlib.Path(sys.argv[3])), "lead": m.launchable_maneuvers(d, "lead", pathlib.Path(sys.argv[3]))}))`;
    const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", py, join(import.meta.dir, "..", "..", "bin", "launch"), file, dir]);
    expect(JSON.parse(r.stdout.toString())).toEqual({ checks: { lint: "just lint", pytest: "just pytest" }, mode: "m", scout: ["verify"], lead: ["verify"] });
  });
});
