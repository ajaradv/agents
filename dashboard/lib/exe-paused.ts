import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exeClient, type ExeClient } from "./exe-dev.ts";
import { nodeStateDir } from "./paths.ts";

/**
 * Paused voyage VMs (R2c): exe.dev's pool is 4 vCPU and the hub holds 2, so an
 * idle voyage's VM is paused (lib/exe-idle.ts) and wakes on the next call to
 * its worker. The set is kept on disk so a node restart still knows which VMs
 * must be resumed before they are used. No import of exe-host: exe-host calls
 * wakeVoyageVm, passing in how to tell that the worker answers.
 */

const statePath = () => join(nodeStateDir(), "exe-paused.json");

function readSet(): string[] {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as unknown;
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeSet(vms: string[]): void {
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(vms) + "\n");
}

export const isPaused = (vm: string): boolean => readSet().includes(vm);
export const markPaused = (vm: string): void => {
  const s = readSet();
  if (!s.includes(vm)) writeSet([...s, vm]);
};
export const clearPaused = (vm: string): void => {
  const s = readSet();
  if (s.includes(vm)) writeSet(s.filter((x) => x !== vm));
};

type Deps = {
  client?: Pick<ExeClient, "pause" | "resume" | "ssh">;
  /** True once the VM's worker answers (the ship list: the worker refuses an exec outside a ship's folder). */
  probe: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function pauseVoyageVm(vm: string, deps: Pick<Partial<Deps>, "client"> = {}): Promise<{ ok: boolean; message: string }> {
  try {
    await (deps.client ?? exeClient()).pause(vm);
  } catch (e) {
    return { ok: false, message: `Could not pause the exe.dev VM ${vm}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` };
  }
  markPaused(vm);
  return { ok: true, message: `The exe.dev VM ${vm} was paused.` };
}

const WAKE = "~/Workspace/agents/bin/voyage-vm-setup wake";
const waking = new Map<string, Promise<{ ok: boolean; message: string }>>();

/**
 * Resume a paused VM and wait for its worker. A resumed VM has a stale clock and
 * may have lost its ephemeral tailnet node: `voyage-vm-setup wake` fixes both.
 * Callers racing on one VM share one wake; a failure leaves it marked paused.
 */
export function wakeVoyageVm(vm: string, deps: Deps): Promise<{ ok: boolean; message: string }> {
  if (!isPaused(vm)) return Promise.resolve({ ok: true, message: "" });
  const running = waking.get(vm);
  if (running) return running;
  const p = wake(vm, deps).finally(() => waking.delete(vm));
  waking.set(vm, p);
  return p;
}

async function wake(vm: string, deps: Deps): Promise<{ ok: boolean; message: string }> {
  const client = deps.client ?? exeClient();
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? Date.now;
  const fail = (why: string) => ({ ok: false, message: `Could not wake the exe.dev VM ${vm}: ${why}` });
  try {
    await client.resume(vm);
    // sshd may need a moment after the resume.
    let r = await client.ssh(vm, WAKE);
    for (let n = 1; !r.ok && n < 4; n++) {
      await sleep(3_000);
      r = await client.ssh(vm, WAKE);
    }
    if (!r.ok) return fail(`voyage-vm-setup wake failed: ${r.body.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`);
    const end = now() + 120_000;
    for (;;) {
      if (await deps.probe().catch(() => false)) break;
      if (now() >= end) return fail("its worker did not answer within 2 minutes");
      await sleep(3_000);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  clearPaused(vm);
  return { ok: true, message: `The exe.dev VM ${vm} is awake.` };
}
