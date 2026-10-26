import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exeClient, exeToken, goldenVmName, voyageVmName, type ExeClient } from "./exe-dev.ts";
import { clearPaused } from "./exe-paused.ts";
import { adoptVoyageVm, exeVoyageHost, forgetVoyageVm } from "./exe-host.ts";
import { nodeStateDir } from "./paths.ts";
import { readSecret } from "./secret-store.ts";
import type { ShipHost } from "./ship-host.ts";
import { nodePublicUrl } from "./worker-host.ts";

/**
 * Voyages on exe.dev VMs (R2c of vault plan fleet/plans/feature/ship-rigging):
 * the Harbor's switch, the check that a voyage may sail there now, and the
 * life of a voyage VM: `cp` of the ship's golden VM, adopt (own tokens), join
 * the tailnet fresh, refresh the repos, then the worker takes the lease. The
 * dock (or a move to the hub) removes the VM.
 */

const statePath = () => join(nodeStateDir(), "exe-voyages.json");

export type ExeVoyages = { on: boolean; at?: string };

export function exeVoyages(): ExeVoyages {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as ExeVoyages;
    return { on: j.on === true, at: j.at };
  } catch {
    return { on: false };
  }
}

export function setExeVoyages(on: boolean): ExeVoyages {
  const s = { on, at: new Date().toISOString() };
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s) + "\n");
  return s;
}

type SailDeps = {
  client?: Pick<ExeClient, "ls">;
  on?: () => boolean;
  nodeUrl?: () => string;
  token?: () => Promise<string>;
  secret?: (name: string) => Promise<string>;
  maxRunning?: number;
};

type ProvisionDeps = {
  client?: Pick<ExeClient, "ls" | "cp" | "rm" | "ssh">;
  adopt?: (vm: string, golden: string) => Promise<{ ok: boolean; message: string }>;
  forget?: (vm: string) => Promise<unknown>;
  host?: (vm: string) => ShipHost;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isGolden = (name: string) => name.endsWith("-golden");
const SHIP_ID = /^[a-z][a-z0-9_-]{0,40}$/i;

/** Can a voyage sail on an exe.dev VM right now: allowed, reachable from the VM, the ship's golden VM exists, the pool has room. */
export async function exeSailable(shipId: string, deps: SailDeps = {}): Promise<{ ok: boolean; why: string }> {
  if (!(deps.on ?? (() => exeVoyages().on))()) return { ok: false, why: "exe.dev voyages are off in the Harbor" };
  if (!(deps.nodeUrl ?? nodePublicUrl)()) return { ok: false, why: "the hub's node has no tailnet address (FLEET_NODE_PUBLIC_URL), which crews on a VM report to" };
  if (!(await (deps.token ?? exeToken)())) return { ok: false, why: "the hub has no exe.dev token" };
  const golden = goldenVmName(shipId);
  let vms;
  try {
    vms = await (deps.client ?? exeClient()).ls();
  } catch (e) {
    return { ok: false, why: `exe.dev did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!vms.some((v) => v.vm_name === golden)) return { ok: false, why: `${shipId} has no golden VM on exe.dev (${golden})` };
  if (!(await (deps.secret ?? readSecret)(`exe-worker-${golden}`))) return { ok: false, why: `the hub has no worker token for ${golden}` };
  const max = deps.maxRunning ?? Number(process.env.FLEET_EXE_MAX_RUNNING ?? 1);
  const running = vms.filter((v) => v.status === "running" && !isGolden(v.vm_name));
  if (running.length >= max) return { ok: false, why: `exe.dev's pool is busy: ${running.length} voyage VM${running.length === 1 ? "" : "s"} running` };
  return { ok: true, why: "" };
}

/** Wait out a step that needs the VM or its worker to come up: true once `probe` passes before the deadline. */
async function until(probe: () => Promise<boolean>, everyMs: number, forMs: number, d: { sleep: (ms: number) => Promise<void>; now: () => number }): Promise<boolean> {
  const end = d.now() + forMs;
  for (;;) {
    if (await probe().catch(() => false)) return true;
    if (d.now() >= end) return false;
    await d.sleep(everyMs);
  }
}

/**
 * A fresh VM for one voyage: copy the ship's golden VM and make it ours. Any
 * failure after the copy removes the VM again. The ssh commands are fixed
 * strings around a validated ship id.
 */
export async function provisionVoyageVm(shipId: string, slug: string, deps: ProvisionDeps = {}): Promise<{ ok: true; vm: string; host: ShipHost } | { ok: false; message: string }> {
  if (!SHIP_ID.test(shipId)) return { ok: false, message: `${shipId} is not a ship id.` };
  const client = deps.client ?? exeClient();
  const t = { sleep: deps.sleep ?? sleepReal, now: deps.now ?? Date.now };
  const adopt = deps.adopt ?? ((vm, golden) => adoptVoyageVm(vm, golden));
  const forget = deps.forget ?? ((vm) => forgetVoyageVm(vm));
  const hostOf = deps.host ?? ((vm) => exeVoyageHost(vm));
  const golden = goldenVmName(shipId);
  const base = voyageVmName(shipId, slug);
  let vm = base;
  try {
    const taken = new Set((await client.ls()).map((v) => v.vm_name));
    for (let n = 2; taken.has(vm); n++) vm = `${base}-${n}`;
    await client.cp(golden, vm);
  } catch (e) {
    return { ok: false, message: `Could not copy ${golden} on exe.dev: ${e instanceof Error ? e.message : String(e)}` };
  }
  const fail = async (message: string) => {
    await client.rm(vm).catch(() => {});
    await forget(vm).catch(() => {});
    return { ok: false as const, message: `${message} (the VM ${vm} was removed)` };
  };
  try {
    // The copy is up within a second or two, but its worker needs a moment to answer.
    let last = "";
    const adopted = await until(async () => {
      const r = await adopt(vm, golden);
      last = r.message;
      return r.ok;
    }, 5_000, 180_000, t);
    if (!adopted) return await fail(`${vm} did not come up as a worker: ${last}`);
    for (const step of [`tailnet`, `refresh ${shipId}`]) {
      const r = await client.ssh(vm, `~/Workspace/agents/bin/voyage-vm-setup ${step}`);
      if (!r.ok) return await fail(`voyage-vm-setup ${step.split(" ")[0]} failed on ${vm}: ${r.body.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    }
    // refresh restarts the worker when the agents repo moved. Probe with its ship list: the worker
    // refuses any command outside a ship's folder, so an exec would never pass.
    const host = hostOf(vm);
    const up = await until(async () => Boolean(await host.repoPath({ id: shipId, path: "" })), 3_000, 120_000, t);
    if (!up) return await fail(`${vm}'s worker did not answer after the refresh`);
    return { ok: true, vm, host };
  } catch (e) {
    return await fail(`Setting up ${vm} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Remove a voyage's VM and drop its tokens. A VM already gone is fine. */
export async function releaseVoyageVm(vm: string, deps: { client?: Pick<ExeClient, "rm">; forget?: ProvisionDeps["forget"] } = {}): Promise<{ ok: boolean; message: string }> {
  try {
    await (deps.client ?? exeClient()).rm(vm);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (!/not.?found|no such|does not exist/i.test(m)) return { ok: false, message: `Could not remove the exe.dev VM ${vm}: ${m.slice(0, 200)}` };
  }
  await (deps.forget ?? ((n) => forgetVoyageVm(n)))(vm).catch(() => {});
  clearPaused(vm);
  return { ok: true, message: `The exe.dev VM ${vm} was removed.` };
}

/** The captain's URL for a rig preview on a VM: the crew's localhost URL, served by the VM at https://<vm>.exe.xyz:<port>. */
export function vmPreview(vm: string, preview: string): string {
  const m = preview.match(/^https?:\/\/(?:[a-z0-9-]+\.)?localhost:(\d+)(.*)$/i);
  return m ? `https://${vm}.exe.xyz:${m[1]}${m[2]}` : preview;
}
