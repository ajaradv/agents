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

describe("moveVoyage to exe.dev", () => {
  const ship = { id: "kinwork", isolation: "host" as const, crew: ["lead"], path: "/k", rig: null } as never;
  const voyage = { file: "/v/2026-10-26-fix-it.md", ship: "kinwork", status: "sailing" as const, goal: "Fix it", to: "kinwork-lead", started: "2026-10-26" };
  const wt = (host?: string) => ({ ship: "kinwork", path: "/w", branch: "fix/it", base: "origin/main", host }) as never;
  const setup = (o: { host?: string; ship?: unknown; sail?: { ok: boolean; why: string }; provision?: unknown } = {}) => {
    const calls: string[] = [];
    const deps = {
      find: async () => (o.ship ?? ship) as never,
      open: async () => voyage,
      worktree: () => wt(o.host),
      from: () => ({ kind: "laptop", label: "the laptop", exec: async (c: string[]) => (calls.push(`exec ${c.join(" ")}`), { stdout: "", stderr: "", exitCode: 0, timedOut: false, ms: 0 }) }) as never,
      sailable: async () => o.sail ?? { ok: true, why: "" },
      provision: (async (s: string, slug: string) => (calls.push(`provision ${s} ${slug}`), o.provision ?? { ok: false, message: "Could not copy kinwork-golden on exe.dev: boom" })) as never,
      release: async (vm: string) => (calls.push(`release ${vm}`), { ok: true, message: "" }),
    };
    const stop = async (id: string) => void calls.push(`stop ${id}`);
    return { calls, deps, stop };
  };

  test("refused: already on a VM, a Gondolin ship, or the switch says no", async () => {
    const { moveVoyage } = await import("./shipyard.ts");
    let s = setup({ host: "vm" });
    expect(await moveVoyage("kinwork", "exe", s.stop, s.deps)).toMatchObject({ ok: false, message: expect.stringContaining("already on an exe.dev VM") });
    s = setup({ host: "laptop", ship: { ...(ship as object), isolation: "vm" } });
    expect(await moveVoyage("kinwork", "exe", s.stop, s.deps)).toMatchObject({ ok: false, message: expect.stringContaining("Gondolin") });
    s = setup({ host: "laptop", sail: { ok: false, why: "exe.dev's pool is busy: 1 voyage VM running" } });
    expect(await moveVoyage("kinwork", "exe", s.stop, s.deps)).toMatchObject({ ok: false, message: expect.stringContaining("pool is busy") });
    expect(s.calls).toEqual([]);
  });

  test("a failed VM copy changes nothing: no crew stopped, nothing run on the source", async () => {
    const { moveVoyage } = await import("./shipyard.ts");
    const s = setup({ host: "laptop" });
    const r = await moveVoyage("kinwork", "exe", s.stop, s.deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("stays where it is") });
    expect(s.calls).toEqual(["provision kinwork fix-it"]);
  });

  test("uncommitted work on the source removes the new VM again", async () => {
    const { moveVoyage } = await import("./shipyard.ts");
    const s = setup({ host: "laptop", provision: { ok: true, vm: "kinwork-fix-it", host: { kind: "vm", label: "vm", vm: "kinwork-fix-it" } } });
    s.deps.from = () => ({ kind: "laptop", label: "the laptop", exec: async (c: string[]) => (s.calls.push(`exec ${c[1]}`), { stdout: c[1] === "status" ? " M a.ts" : "", stderr: "", exitCode: 0, timedOut: false, ms: 0 }) }) as never;
    const r = await moveVoyage("kinwork", "exe", s.stop, s.deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("uncommitted") });
    expect(s.calls.at(-1)).toBe("release kinwork-fix-it");
  });
});
