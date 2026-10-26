import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "exe-paused-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { clearPaused, isPaused, markPaused, pauseVoyageVm, wakeVoyageVm } = await import("./exe-paused.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});
beforeEach(() => clearPaused("v1"));

function fakes(opts: { ssh?: boolean; probe?: (n: number) => boolean; resume?: boolean } = {}) {
  const calls: string[] = [];
  let t = 0;
  let probes = 0;
  return {
    calls,
    deps: {
      client: {
        pause: async (n: string) => void calls.push(`pause ${n}`),
        resume: async (n: string) => {
          calls.push(`resume ${n}`);
          if (opts.resume === false) throw new Error("exe.dev: no room");
        },
        ssh: async (n: string, c: string) => (calls.push(`ssh ${n} ${c}`), { ok: opts.ssh !== false, exit: 0, body: "boom" }),
      },
      probe: async () => (calls.push("probe"), opts.probe?.(++probes) !== false),
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
    },
  };
}

describe("paused voyage VMs", () => {
  test("pausing marks the VM; a failed pause does not", async () => {
    const f = fakes();
    expect(await pauseVoyageVm("v1", f.deps)).toMatchObject({ ok: true });
    expect(isPaused("v1")).toBe(true);
    clearPaused("v1");
    const bad = { client: { pause: async () => Promise.reject(new Error("nope")) } };
    expect(await pauseVoyageVm("v1", bad as never)).toMatchObject({ ok: false });
    expect(isPaused("v1")).toBe(false);
  });

  test("a VM that is not paused is left alone", async () => {
    const f = fakes();
    expect(await wakeVoyageVm("v1", f.deps)).toMatchObject({ ok: true });
    expect(f.calls).toEqual([]);
  });

  test("resume, wake over ssh, wait for the worker, then clear the mark", async () => {
    markPaused("v1");
    const f = fakes({ probe: (n) => n >= 3 });
    expect(await wakeVoyageVm("v1", f.deps)).toMatchObject({ ok: true });
    expect(f.calls).toEqual(["resume v1", "ssh v1 ~/Workspace/agents/bin/voyage-vm-setup wake", "probe", "probe", "probe"]);
    expect(isPaused("v1")).toBe(false);
  });

  test("callers racing on one VM share one wake", async () => {
    markPaused("v1");
    const f = fakes();
    const [a, b] = await Promise.all([wakeVoyageVm("v1", f.deps), wakeVoyageVm("v1", f.deps)]);
    expect(a).toEqual(b);
    expect(f.calls.filter((c) => c.startsWith("resume"))).toHaveLength(1);
  });

  test("a failed resume, wake, or probe keeps it marked paused", async () => {
    for (const o of [{ resume: false }, { ssh: false }, { probe: () => false }]) {
      markPaused("v1");
      const f = fakes(o);
      const r = await wakeVoyageVm("v1", f.deps);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("v1");
      expect(isPaused("v1")).toBe(true);
    }
  });
});
