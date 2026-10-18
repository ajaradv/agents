import { describe, expect, test } from "bun:test";
import { readyToSail, voyageBrief, type CheckItem } from "./shipyard.ts";

describe("shipyard", () => {
  const item = (ok: boolean, required: boolean): CheckItem => ({ item: "x", ok, required, note: "" });

  test("only required items block sailing", () => {
    expect(readyToSail([item(true, true), item(false, false)])).toBe(true);
    expect(readyToSail([item(true, true), item(false, true)])).toBe(false);
  });

  test("voyage brief names the goal, record, and crew", () => {
    const ship = { id: "kinwork", path: "/k", mode: "local-only", factory: null, declaredAdws: [], adws: [], orchestrator: "lead", crew: ["designer", "scout"], crewModels: {}, isolation: "host" as const, vmAllow: [], checks: {}, gates: { task: [], dock: [] }, maneuvers: [] };
    const text = voyageBrief(ship, { file: "/vault/fleet/voyages/kinwork/x.md", ship: "kinwork", status: "sailing", goal: "Ship V4", to: "kinwork-designer", started: "2026-10-11" });
    expect(text).toContain("New voyage for kinwork: Ship V4");
    expect(text).toContain("/vault/fleet/voyages/kinwork/x.md");
    expect(text).toContain("kinwork-designer, kinwork-scout");
    expect(text).toContain("ask_captain");
  });
});
