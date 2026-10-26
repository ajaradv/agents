import { describe, expect, test } from "bun:test";
import type { ExeVm } from "./exe-dev.ts";
import { exeIdleJob, idleVoyages, refreshGoldens, type VoyageOnVm } from "./exe-pool.ts";

const MIN = 60_000;
const voyage = (o: Partial<VoyageOnVm> = {}): VoyageOnVm => ({ ship: "kin", vm: "kin-x", crew: ["kin-lead", "kin-dev"], rigBusy: false, ...o });
const base = (o: Partial<Parameters<typeof idleVoyages>[1]> = {}) => ({ alive: () => false, waiting: () => false, paused: () => false, quietSince: new Map<string, number>(), now: 0, afterMin: 60, ...o });

describe("idleVoyages", () => {
  test("pauses only after the quiet threshold, counted from the first quiet look", () => {
    const d = base();
    expect(idleVoyages([voyage()], d)).toEqual([]);
    d.now = 59 * MIN;
    expect(idleVoyages([voyage()], d)).toEqual([]);
    d.now = 60 * MIN;
    expect(idleVoyages([voyage()], d)).toEqual([{ ship: "kin", vm: "kin-x", minutes: 60 }]);
  });
  test("a live crew process, an open captain dialog, or a rig coming up resets the clock", () => {
    for (const o of [{ alive: (id: string) => id === "kin-dev" }, { waiting: (id: string) => id === "kin-lead" }]) {
      const d = base(o);
      d.quietSince.set("kin-x", -120 * MIN);
      expect(idleVoyages([voyage()], d)).toEqual([]);
      expect(d.quietSince.has("kin-x")).toBe(false);
    }
    const d = base();
    d.quietSince.set("kin-x", -120 * MIN);
    expect(idleVoyages([voyage({ rigBusy: true })], d)).toEqual([]);
    expect(d.quietSince.size).toBe(0);
  });
  test("a session guest counts as crew", () => {
    const d = base({ alive: (id) => id === "architect" });
    d.quietSince.set("kin-x", -120 * MIN);
    expect(idleVoyages([voyage({ crew: ["kin-lead", "architect"] })], d)).toEqual([]);
  });
  test("an already paused VM is skipped and forgotten; gone voyages drop their clock", () => {
    const d = base({ paused: () => true });
    d.quietSince.set("kin-x", -120 * MIN);
    d.quietSince.set("old", -120 * MIN);
    expect(idleVoyages([voyage()], d)).toEqual([]);
    expect([...d.quietSince.keys()]).toEqual([]);
  });
});

describe("exeIdleJob", () => {
  test("pauses a VM quiet past the threshold and logs the notice", async () => {
    let now = 0;
    const paused: string[] = [];
    const logs: string[] = [];
    const job = exeIdleJob({ voyages: async () => [voyage()], pause: async (vm) => (paused.push(vm), { ok: true, message: "" }), now: () => now, alive: () => false, waiting: () => false, paused: () => false, log: ((_s: string, _a: string, _k: string, m: string) => void logs.push(m)) as never });
    expect(await job()).toBe("nothing to pause");
    now = 61 * MIN;
    expect(await job()).toBe("paused kin-x");
    expect(paused).toEqual(["kin-x"]);
    expect(logs[0]).toBe("Paused the exe.dev VM kin-x after 61 min idle; it resumes on the next crew turn or deck action.");
  });
});

const vm = (name: string, status = "stopped"): ExeVm => ({ vm_name: name, status, dns_name: `${name}.exe.xyz` });

function goldenFakes(vms: ExeVm[], failStep = "") {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      ships: async () => ["kinwork", "lineage_atria"],
      sleep: async () => {},
      client: {
        ls: async () => vms,
        resume: async (n: string) => void calls.push(`resume ${n}`),
        pause: async (n: string) => void calls.push(`pause ${n}`),
        ssh: async (n: string, c: string) => (calls.push(`ssh ${n} ${c.replace(/^.*voyage-vm-setup /, "")}`), { ok: !failStep || !c.endsWith(failStep), exit: 0, body: "no" }),
      },
    },
  };
}

describe("refreshGoldens", () => {
  test("resume, wake, refresh, seal, pause; names map back to ship ids; unknown goldens are skipped", async () => {
    const f = goldenFakes([vm("kinwork-golden"), vm("lineage-atria-golden"), vm("ghost-golden")]);
    const r = await refreshGoldens(f.deps);
    expect(f.calls).toEqual([
      "resume kinwork-golden", "ssh kinwork-golden wake", "ssh kinwork-golden refresh kinwork", "ssh kinwork-golden seal", "pause kinwork-golden",
      "resume lineage-atria-golden", "ssh lineage-atria-golden wake", "ssh lineage-atria-golden refresh lineage_atria", "ssh lineage-atria-golden seal", "pause lineage-atria-golden",
    ]);
    expect(r).toBe("kinwork refreshed; lineage_atria refreshed");
  });
  test("skips everything while a voyage VM runs", async () => {
    const f = goldenFakes([vm("kinwork-golden"), vm("kinwork-fix", "running")]);
    expect(await refreshGoldens(f.deps)).toContain("skipped");
    expect(f.calls).toEqual([]);
  });
  test("a failed step still pauses the golden and the next one goes on", async () => {
    const f = goldenFakes([vm("kinwork-golden"), vm("lineage-atria-golden")], "refresh kinwork");
    const r = await refreshGoldens(f.deps);
    expect(f.calls.slice(0, 4)).toEqual(["resume kinwork-golden", "ssh kinwork-golden wake", "ssh kinwork-golden refresh kinwork", "pause kinwork-golden"]);
    expect(r).toContain("kinwork failed: refresh failed");
    expect(r).toContain("lineage_atria refreshed");
  });
});
