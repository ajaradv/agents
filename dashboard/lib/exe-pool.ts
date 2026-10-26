import { exeClient, goldenVmName, type ExeClient } from "./exe-dev.ts";
import { hostAlive, hostWaiting } from "./agent-host.ts";
import { isPaused, pauseVoyageVm } from "./exe-paused.ts";
import { readShips } from "./fleet-layers.ts";
import { logShipEvent } from "./ship-log.ts";
import { voyageWorktree } from "./voyage-worktree.ts";

/**
 * Keeping exe.dev's pool (4 vCPU; the hub holds 2) free for voyages (R2c): the
 * `exe-idle` job pauses a voyage VM that has been quiet for a while (it wakes on
 * its next call, lib/exe-paused.ts), and `golden-refresh` brings each ship's
 * paused golden VM up to date at night.
 */

export type VoyageOnVm = { ship: string; vm: string; crew: string[]; rigBusy: boolean };

type IdleDeps = {
  alive: (agentId: string) => boolean;
  waiting: (agentId: string) => boolean;
  paused: (vm: string) => boolean;
  /** When each VM's voyage went quiet (ms). Kept by the caller across runs; a restart resets it, which only delays a pause. */
  quietSince: Map<string, number>;
  now: number;
  afterMin: number;
};

/**
 * The voyages whose VM should be paused now. Quiet means no crew process, none
 * waiting on the captain, and no rig coming up. Updates `quietSince`: a busy
 * voyage clears its clock, a quiet one starts it.
 */
export function idleVoyages(voyages: VoyageOnVm[], d: IdleDeps): { ship: string; vm: string; minutes: number }[] {
  const out: { ship: string; vm: string; minutes: number }[] = [];
  const seen = new Set<string>();
  for (const v of voyages) {
    seen.add(v.vm);
    if (d.paused(v.vm)) {
      d.quietSince.delete(v.vm);
      continue;
    }
    const busy = v.rigBusy || v.crew.some((id) => d.alive(id) || d.waiting(id));
    if (busy) {
      d.quietSince.delete(v.vm);
      continue;
    }
    const since = d.quietSince.get(v.vm) ?? d.now;
    d.quietSince.set(v.vm, since);
    const minutes = Math.floor((d.now - since) / 60_000);
    if (minutes >= d.afterMin) out.push({ ship: v.ship, vm: v.vm, minutes });
  }
  for (const vm of d.quietSince.keys()) if (!seen.has(vm)) d.quietSince.delete(vm);
  return out;
}

/** The open voyages sailing on exe.dev VMs, with the crew that works them (and a session's guest). */
async function voyagesOnVms(): Promise<VoyageOnVm[]> {
  const out: VoyageOnVm[] = [];
  for (const ship of await readShips()) {
    const w = voyageWorktree(ship.id);
    if (w?.host !== "vm" || !w.vm) continue;
    out.push({ ship: ship.id, vm: w.vm, crew: [...ship.crew.map((r) => `${ship.id}-${r}`), ...(w.guest ? [w.guest] : [])], rigBusy: w.rig?.state === "pending" || w.rig?.state === "rigging" });
  }
  return out;
}

/** The node job `exe-idle`: pause the VM of a voyage that has been quiet for FLEET_EXE_IDLE_MIN minutes (default 60). */
export function exeIdleJob(deps: { voyages?: () => Promise<VoyageOnVm[]>; pause?: (vm: string) => Promise<{ ok: boolean; message: string }>; now?: () => number; log?: typeof logShipEvent } & Partial<Pick<IdleDeps, "alive" | "waiting" | "paused">> = {}): () => Promise<string> {
  const quietSince = new Map<string, number>();
  return async () => {
    const afterMin = Number(process.env.FLEET_EXE_IDLE_MIN ?? 60);
    const due = idleVoyages(await (deps.voyages ?? voyagesOnVms)(), { alive: deps.alive ?? hostAlive, waiting: deps.waiting ?? hostWaiting, paused: deps.paused ?? isPaused, quietSince, now: (deps.now ?? Date.now)(), afterMin });
    const done: string[] = [];
    for (const v of due) {
      const r = await (deps.pause ?? pauseVoyageVm)(v.vm);
      if (!r.ok) {
        (deps.log ?? logShipEvent)(v.ship, "helm", "notice", r.message);
        continue;
      }
      quietSince.delete(v.vm);
      (deps.log ?? logShipEvent)(v.ship, "helm", "notice", `Paused the exe.dev VM ${v.vm} after ${v.minutes} min idle; it resumes on the next crew turn or deck action.`);
      done.push(v.vm);
    }
    return done.length ? `paused ${done.join(", ")}` : "nothing to pause";
  };
}

type GoldenDeps = {
  client?: Pick<ExeClient, "ls" | "resume" | "pause" | "ssh">;
  ships?: () => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
};

const SETUP = "~/Workspace/agents/bin/voyage-vm-setup";

/**
 * The node job `golden-refresh`: each ship's golden VM is resumed, brought up to date
 * (`voyage-vm-setup refresh`), sealed (it leaves the tailnet, so copies do not
 * inherit an identity), and paused again. One at a time, and only while no voyage
 * VM runs: the pool has room for a single 2-vCPU VM beside the hub.
 */
export async function refreshGoldens(deps: GoldenDeps = {}): Promise<string> {
  const client = deps.client ?? exeClient();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // VM names flatten ship ids (lineage_atria is lineage-atria-golden): map back from the name.
  const byGolden = new Map((await (deps.ships ?? (async () => (await readShips()).map((s) => s.id)))()).filter((id) => /^[a-z][a-z0-9_-]{0,40}$/i.test(id)).map((id) => [goldenVmName(id), id]));
  const vms = await client.ls();
  const busy = vms.filter((v) => v.status === "running" && !v.vm_name.endsWith("-golden"));
  if (busy.length) return `skipped: ${busy.length} voyage VM${busy.length === 1 ? "" : "s"} running, so the pool has no room`;
  const results: string[] = [];
  for (const v of vms) {
    if (!v.vm_name.endsWith("-golden")) continue;
    const ship = byGolden.get(v.vm_name);
    if (!ship) continue;
    let why = "";
    try {
      await client.resume(v.vm_name);
      await sleep(5_000);
      for (const step of ["wake", `refresh ${ship}`, "seal"]) {
        const r = await client.ssh(v.vm_name, `${SETUP} ${step}`);
        if (!r.ok) {
          why = `${step.split(" ")[0]} failed: ${r.body.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? ""}`;
          break;
        }
      }
    } catch (e) {
      why = e instanceof Error ? e.message.slice(0, 120) : String(e);
    }
    // Paused again whatever happened: a running golden would take a voyage's share of the pool.
    const paused = await client.pause(v.vm_name).then(() => "", (e) => ` (could not pause it: ${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    results.push(`${ship} ${why ? `failed: ${why}` : "refreshed"}${paused}`);
  }
  return results.length ? results.join("; ") : "no golden VMs to refresh";
}
