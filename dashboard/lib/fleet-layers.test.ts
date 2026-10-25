import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listShipAdws,
  parseInitiative,
  parseShipYaml,
  readInitiatives,
  DEFAULT_VM_ALLOW,
} from "./fleet-layers.ts";

describe("parseShipYaml", () => {
  test("reads factory and declared adws", () => {
    const row = parseShipYaml(
      "id: lineage_atria\npath: /x\nfactory:\n  skill: .claude/skills/sssf\n  adws:\n    - adw_plan_build_test\nmode: no-mistakes\n",
      "fallback",
    );
    expect(row).toEqual({
      id: "lineage_atria",
      path: "/x",
      mode: "no-mistakes",
      factory: ".claude/skills/sssf",
      declaredAdws: ["adw_plan_build_test"],
      orchestrator: "firstmate",
      crew: [],
      crewModels: {},
      isolation: "host",
      vmAllow: DEFAULT_VM_ALLOW,
      checks: {},
      gates: { task: [], dock: [] },
      maneuvers: [],
      rig: null,
    });
  });

  test("reads crew and per-role model overrides", () => {
    const row = parseShipYaml("id: kinwork\npath: /k\norchestrator: lead\ncrew:\n  - designer\n  - Bad Role\ncrew_models:\n  designer: deepseek/deepseek-v4-pro\n", "k");
    expect(row.orchestrator).toBe("lead");
    expect(row.crew).toEqual(["designer"]);
    expect(row.crewModels).toEqual({ designer: "deepseek/deepseek-v4-pro" });
  });

  test("factory null means no factory", () => {
    expect(parseShipYaml("id: fleet\nfactory: null\n", "f").factory).toBeNull();
  });
});

describe("listShipAdws", () => {
  test("lists adw_*.py chains only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-"));
    await mkdir(join(dir, "adws", "adw_modules"), { recursive: true });
    await writeFile(join(dir, "adws", "adw_plan.py"), "");
    await writeFile(join(dir, "adws", "adw_scout.py"), "");
    await writeFile(join(dir, "adws", "notes.md"), "");
    expect(await listShipAdws(dir)).toEqual(["adw_plan", "adw_scout"]);
    expect(await listShipAdws(join(dir, "missing"))).toEqual([]);
  });
});

describe("initiatives", () => {
  test("parses frontmatter lists and lowercases ids", () => {
    const row = parseInitiative(
      "---\ntitle: Kin stack\nstatus: paused\nships: [Lineage_Atria]\nprojects: kinwork\n---\n# ignored\n",
      "kin-stack",
    );
    expect(row).toEqual({
      slug: "kin-stack",
      title: "Kin stack",
      status: "paused",
      ships: ["lineage_atria"],
      projects: ["kinwork"],
      plans: [],
    });
  });

  test("falls back to heading and active status", () => {
    const row = parseInitiative("# Big goal\nbody", "big-goal");
    expect(row.title).toBe("Big goal");
    expect(row.status).toBe("active");
  });

  test("missing folder hides the layer", async () => {
    expect(await readInitiatives(join(tmpdir(), "no-such-initiatives-dir"))).toBeNull();
  });
});
