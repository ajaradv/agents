import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listShipAdws,
  parseInitiative,
  parseShipYaml,
  readInitiatives,
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
    });
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
