import { describe, expect, test } from "bun:test";
import type { ExeVm } from "./exe-dev.ts";
import { exeSailable, provisionVoyageVm, releaseVoyageVm, vmPreview } from "./exe-voyages.ts";
import type { ShipHost } from "./ship-host.ts";

const vm = (name: string, status = "running"): ExeVm => ({ vm_name: name, status, dns_name: `${name}.exe.xyz` });

/** A fake clock: sleeping advances it. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function fakes(opts: { vms?: ExeVm[]; adopt?: (n: number) => boolean; ssh?: (cmd: string) => boolean; health?: (n: number) => boolean } = {}) {
  const calls: string[] = [];
  let adopts = 0;
  let health = 0;
  const host = { kind: "vm", label: "vm", exec: async () => (calls.push("health"), { stdout: "", stderr: "", exitCode: opts.health?.(++health) === false ? 125 : 0, timedOut: false, ms: 0 }) } as unknown as ShipHost;
  return {
    calls,
    deps: {
      ...clock(),
      client: {
        ls: async () => opts.vms ?? [vm("kinwork-golden", "stopped")],
        cp: async (s: string, n: string) => (calls.push(`cp ${s} ${n}`), vm(n)),
        rm: async (n: string) => void calls.push(`rm ${n}`),
        ssh: async (n: string, c: string) => (calls.push(`ssh ${n} ${c}`), { ok: opts.ssh?.(c) !== false, exit: 0, body: "boom" }),
      },
      adopt: async (n: string, g: string) => (calls.push(`adopt ${n} ${g}`), { ok: opts.adopt?.(++adopts) !== false, message: "not yet" }),
      forget: async (n: string) => void calls.push(`forget ${n}`),
      host: () => host,
    },
  };
}

describe("exeSailable", () => {
  const base = { on: () => true, nodeUrl: () => "https://hub.ts.net", token: async () => "t", secret: async () => "s", client: { ls: async () => [vm("kinwork-golden", "stopped")] } };
  test("ok when everything is in place", async () => {
    expect(await exeSailable("kinwork", base)).toEqual({ ok: true, why: "" });
  });
  test("each failure says why", async () => {
    expect((await exeSailable("kinwork", { ...base, on: () => false })).why).toContain("off in the Harbor");
    expect((await exeSailable("kinwork", { ...base, nodeUrl: () => "" })).why).toContain("FLEET_NODE_PUBLIC_URL");
    expect((await exeSailable("kinwork", { ...base, token: async () => "" })).why).toContain("no exe.dev token");
    expect((await exeSailable("pochteca", base)).why).toContain("pochteca has no golden VM");
    expect((await exeSailable("kinwork", { ...base, secret: async () => "" })).why).toContain("worker token for kinwork-golden");
    expect((await exeSailable("kinwork", { ...base, client: { ls: async () => { throw new Error("down"); } } })).why).toContain("did not answer");
  });
  test("a busy pool counts running voyage VMs, not goldens", async () => {
    const busy = { ...base, client: { ls: async () => [vm("kinwork-golden"), vm("kinwork-fix")] } };
    expect(await exeSailable("kinwork", busy)).toEqual({ ok: false, why: "exe.dev's pool is busy: 1 voyage VM running" });
    expect((await exeSailable("kinwork", { ...busy, maxRunning: 2 })).ok).toBe(true);
    expect((await exeSailable("kinwork", { ...base, client: { ls: async () => [vm("kinwork-golden"), vm("kinwork-fix", "stopped")] } })).ok).toBe(true);
  });
});

describe("provisionVoyageVm", () => {
  test("copies, adopts, joins the tailnet, refreshes, then waits for the worker", async () => {
    const f = fakes();
    const r = await provisionVoyageVm("kinwork", "fix-search", f.deps);
    expect(r).toMatchObject({ ok: true, vm: "kinwork-fix-search" });
    expect(f.calls).toEqual([
      "cp kinwork-golden kinwork-fix-search",
      "adopt kinwork-fix-search kinwork-golden",
      "ssh kinwork-fix-search ~/Workspace/agents/bin/voyage-vm-setup tailnet",
      "ssh kinwork-fix-search ~/Workspace/agents/bin/voyage-vm-setup refresh kinwork",
      "health",
    ]);
  });
  test("adoption is retried while the copy comes up, and the worker wait too", async () => {
    const f = fakes({ adopt: (n) => n >= 3, health: (n) => n >= 2 });
    expect((await provisionVoyageVm("kinwork", "x1", f.deps)).ok).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("adopt"))).toHaveLength(3);
    expect(f.calls.filter((c) => c === "health")).toHaveLength(2);
  });
  test("names are made unique against the VMs that exist", async () => {
    const f = fakes({ vms: [vm("kinwork-golden"), vm("kinwork-fix"), vm("kinwork-fix-2")] });
    expect(await provisionVoyageVm("kinwork", "fix", f.deps)).toMatchObject({ ok: true, vm: "kinwork-fix-3" });
  });
  test("a VM that never adopts is removed after three minutes", async () => {
    const f = fakes({ adopt: () => false });
    const r = await provisionVoyageVm("kinwork", "fix", f.deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("not yet") });
    expect(f.calls.slice(-2)).toEqual(["rm kinwork-fix", "forget kinwork-fix"]);
    expect(f.calls.filter((c) => c.startsWith("adopt")).length).toBeGreaterThan(30);
    expect(f.calls.some((c) => c.startsWith("ssh"))).toBe(false);
  });
  test("a failed ssh step removes the VM", async () => {
    const f = fakes({ ssh: (c) => !c.endsWith("refresh kinwork") });
    const r = await provisionVoyageVm("kinwork", "fix", f.deps);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("refresh failed") });
    expect(f.calls.slice(-2)).toEqual(["rm kinwork-fix", "forget kinwork-fix"]);
  });
  test("a worker that never answers removes the VM", async () => {
    const f = fakes({ health: () => false });
    expect((await provisionVoyageVm("kinwork", "fix", f.deps)).ok).toBe(false);
    expect(f.calls.slice(-2)).toEqual(["rm kinwork-fix", "forget kinwork-fix"]);
  });
  test("a failed copy leaves nothing to clean", async () => {
    const f = fakes();
    f.deps.client.cp = async () => { throw new Error("quota"); };
    expect(await provisionVoyageVm("kinwork", "fix", f.deps)).toMatchObject({ ok: false, message: expect.stringContaining("quota") });
    expect(f.calls).toEqual([]);
  });
  test("a ship id that could carry shell text is refused", async () => {
    const f = fakes();
    expect((await provisionVoyageVm("kinwork; rm -rf ~", "fix", f.deps)).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
});

describe("releaseVoyageVm", () => {
  test("removes the VM and forgets its tokens", async () => {
    const calls: string[] = [];
    const r = await releaseVoyageVm("kinwork-fix", { client: { rm: async (n: string) => void calls.push(`rm ${n}`) } as never, forget: async (n) => void calls.push(`forget ${n}`) });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["rm kinwork-fix", "forget kinwork-fix"]);
  });
  test("a VM already gone is fine; another error keeps the tokens", async () => {
    const calls: string[] = [];
    const forget = async (n: string) => void calls.push(`forget ${n}`);
    expect((await releaseVoyageVm("a-b", { client: { rm: async () => { throw new Error("exe.dev: VM not found"); } } as never, forget })).ok).toBe(true);
    expect(calls).toEqual(["forget a-b"]);
    const bad = await releaseVoyageVm("a-b", { client: { rm: async () => { throw new Error("exe.dev: busy"); } } as never, forget });
    expect(bad.ok).toBe(false);
    expect(calls).toEqual(["forget a-b"]);
  });
});

describe("vmPreview", () => {
  test("replaces the origin and keeps path and query", () => {
    expect(vmPreview("kinwork-fix", "http://localhost:4101")).toBe("https://kinwork-fix.exe.xyz:4101");
    expect(vmPreview("kinwork-fix", "http://localhost:4101/app?x=1#h")).toBe("https://kinwork-fix.exe.xyz:4101/app?x=1#h");
    expect(vmPreview("lineage-fix", "http://my-slug.localhost:4120/")).toBe("https://lineage-fix.exe.xyz:4120/");
  });
  test("leaves other URLs alone", () => {
    expect(vmPreview("v", "https://example.com/x")).toBe("https://example.com/x");
  });
});
