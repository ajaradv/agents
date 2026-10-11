import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAdwPhases, slugify, validateGroup } from "./groups.ts";
import { ROOT } from "./paths.ts";

const allowed = ["alice", "architect", "shipwright"];

describe("validateGroup", () => {
  test("accepts a group whose lead is a member", async () => {
    const r = await validateGroup({ name: "Plan crew", lead: "architect", members: ["architect", "alice"] }, allowed);
    expect(r.group).toEqual({ id: "plan-crew", name: "Plan crew", lead: "architect", members: ["architect", "alice"], adw: null });
  });

  test("refuses Firstmate and live tasks", async () => {
    const r = await validateGroup({ name: "x", lead: "firstmate", members: ["firstmate"] }, allowed);
    expect(r.error).toContain("Firstmate and its tasks cannot join");
  });

  test("lead must be a member", async () => {
    const r = await validateGroup({ name: "x", lead: "alice", members: ["architect"] }, allowed);
    expect(r.error).toBe("The lead must be one of the members.");
  });

  test("ADW label needs ship and chain", async () => {
    const r = await validateGroup({ name: "x", lead: "alice", members: ["alice"], adwShip: "lineage_atria" }, allowed);
    expect(r.error).toContain("both a ship and a chain");
  });

  test("unknown ship is refused", async () => {
    const r = await validateGroup({ name: "x", lead: "alice", members: ["alice"], adwShip: "nope", adwChain: "adw_plan" }, allowed);
    expect(r.error).toBe("Unknown ship nope.");
  });
});

describe("slugify", () => {
  test("makes a safe id", () => {
    expect(slugify("Plan & Build crew!")).toBe("plan-build-crew");
  });
});

describe("parseAdwPhases", () => {
  test("collapses loop phases and keeps order", () => {
    const src = `run.phase(PhaseParams(name="plan", kind="agent"))
run.phase(PhaseParams(name=f"test_{i}", kind="code"))
run.phase(PhaseParams(name=f"fix_{i}", kind="agent"))
run.phase(PhaseParams(name=f"test_{i}", kind="code"))
run.phase(PhaseParams(name="commit_build"))`;
    expect(parseAdwPhases(src)).toEqual(["plan", "test", "fix", "commit_build"]);
  });

  test("reads the shipped simple_sdlc template", async () => {
    const src = await readFile(join(ROOT, ".claude/skills/sssf/templates/adws/adw_simple_sdlc.py"), "utf8");
    const phases = parseAdwPhases(src);
    expect(phases[0]).toBe("request");
    expect(phases).toContain("build");
    expect(phases).toContain("document");
  });
});
