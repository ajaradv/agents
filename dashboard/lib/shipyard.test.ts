import { describe, expect, test } from "bun:test";
import { readyToSail, voyageBrief, type CheckItem } from "./shipyard.ts";

describe("shipyard", () => {
  const item = (ok: boolean, required: boolean): CheckItem => ({ item: "x", ok, required, note: "" });

  test("only required items block sailing", () => {
    expect(readyToSail([item(true, true), item(false, false)])).toBe(true);
    expect(readyToSail([item(true, true), item(false, true)])).toBe(false);
  });

  test("voyage brief names the goal, record, and crew", () => {
    const ship = { id: "kinwork", path: "/k", mode: "local-only", factory: null, declaredAdws: [], adws: [], orchestrator: "lead", crew: ["designer", "scout"], crewModels: {}, isolation: "host" as const, vmAllow: [], checks: {}, gates: { task: [], dock: [] }, maneuvers: [], rig: null };
    const text = voyageBrief(ship, { file: "/vault/fleet/voyages/kinwork/x.md", ship: "kinwork", status: "sailing", goal: "Ship V4", to: "kinwork-designer", started: "2026-10-11" });
    expect(text).toContain("New voyage for kinwork: Ship V4");
    expect(text).toContain("/vault/fleet/voyages/kinwork/x.md");
    expect(text).toContain("kinwork-designer, kinwork-scout");
    expect(text).toContain("ask_captain");
  });
});

describe("where a voyage sails", () => {
  test("a Gondolin ship never sails on a Linux hub; elsewhere the hub is the fallback", async () => {
    const { sailHost } = await import("./shipyard.ts");
    expect(await sailHost({ id: "pochteca", isolation: "vm" }, "hub", "linux")).toMatchObject({ ok: false, message: expect.stringContaining("Gondolin") });
    expect(await sailHost({ id: "pochteca", isolation: "vm" }, "hub", "darwin")).toMatchObject({ ok: true });
    expect(await sailHost({ id: "kinwork", isolation: "host" }, undefined, "linux")).toMatchObject({ ok: true });
    expect(await sailHost({ id: "kinwork", isolation: "host" }, "moon", "linux")).toMatchObject({ ok: false });
  });
});

describe("sailHost placement", () => {
  const ok = async () => ({ ok: true, why: "" });
  const no = (why: string) => async () => ({ ok: false, why });
  const kin = { id: "kinwork", isolation: "host" as const };
  test("prefer-laptop goes laptop, then exe.dev (hub to fall back on), then the hub", async () => {
    const { sailHost } = await import("./shipyard.ts");
    const { shipHost } = await import("./ship-host.ts");
    const { localHost } = await import("./ship-host.ts");
    expect(await sailHost(kin, "prefer-laptop", "linux", { laptop: ok, exe: ok })).toEqual({ ok: true, host: shipHost("laptop") });
    expect(await sailHost(kin, "prefer-laptop", "linux", { laptop: no("asleep"), exe: ok })).toEqual({ ok: true, exe: true, fallback: localHost });
    expect(await sailHost(kin, "prefer-laptop", "linux", { laptop: no("asleep"), exe: no("busy") })).toEqual({ ok: true, host: localHost });
  });
  test("an explicit exe fails with the why; an explicit laptop never goes to exe.dev", async () => {
    const { sailHost } = await import("./shipyard.ts");
    expect(await sailHost(kin, "exe", "linux", { exe: no("exe.dev's pool is busy: 1 voyage VM running") })).toMatchObject({ ok: false, message: expect.stringContaining("pool is busy") });
    expect(await sailHost(kin, "exe", "linux", { exe: ok })).toEqual({ ok: true, exe: true, fallback: null });
    expect(await sailHost(kin, "laptop", "linux", { laptop: no("asleep"), exe: ok })).toMatchObject({ ok: false });
  });
  test("a Gondolin ship never goes to exe.dev", async () => {
    const { sailHost } = await import("./shipyard.ts");
    const gon = { id: "pochteca", isolation: "vm" as const };
    expect(await sailHost(gon, "exe", "linux", { exe: ok })).toMatchObject({ ok: false, message: expect.stringContaining("Gondolin") });
    expect(await sailHost(gon, "prefer-laptop", "linux", { laptop: no("asleep"), exe: ok })).toMatchObject({ ok: false });
    expect(await sailHost(gon, "prefer-laptop", "darwin", { laptop: no("asleep"), exe: ok })).toMatchObject({ ok: true, host: expect.anything() });
  });
});
