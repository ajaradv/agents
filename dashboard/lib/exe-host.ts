import { randomBytes } from "node:crypto";
import { exeClient, type ExeClient } from "./exe-dev.ts";
import { deleteSecret, readSecret, writeSecret } from "./secret-store.ts";
import type { ShipHost } from "./ship-host.ts";
import { workerHost } from "./worker-host.ts";

/**
 * An exe.dev voyage VM as a ship host (R2 of vault plan fleet/plans/feature/ship-rigging):
 * the same worker as the laptop's (dashboard/worker.ts, FLEET_WORKER_HOST set
 * so exe.dev's proxy can reach it), at https://<vm>.exe.xyz:<port>/. Two tokens:
 * the VM's exe.dev token in X-Exedev-Authorization (the proxy checks and strips
 * it) and the worker's own in Authorization. Both are per VM
 * (exe-vm-<vm>, exe-worker-<vm>); a copy of the golden VM starts with the
 * golden's worker token, which adoptVoyageVm replaces.
 */

export const EXE_WORKER_PORT = Number(process.env.FLEET_EXE_WORKER_PORT ?? 8790);

export function exeVoyageHost(vm: string, deps: { fetch?: (url: string, init: RequestInit) => Promise<Response>; secret?: (name: string) => Promise<string> } = {}): ShipHost {
  const secret = deps.secret ?? readSecret;
  const host = workerHost({
    kind: "vm",
    label: `the exe.dev VM ${vm}`,
    url: () => `https://${vm}.exe.xyz:${EXE_WORKER_PORT}`,
    auth: async (): Promise<Record<string, string>> => {
      const [proxy, worker] = await Promise.all([secret(`exe-vm-${vm}`), secret(`exe-worker-${vm}`)]);
      return { ...(proxy ? { "X-Exedev-Authorization": `Bearer ${proxy}` } : {}), ...(worker ? { Authorization: `Bearer ${worker}` } : {}) };
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    // A voyage already on a VM may always continue there; new voyages are placed by the shipyard.
    available: async () => true,
  });
  return { ...host, vm };
}

export type AdoptDeps = {
  vmToken?: ExeClient["vmToken"];
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  read?: (name: string) => Promise<string>;
  write?: (name: string, value: string) => Promise<boolean>;
  random?: () => string;
};

/**
 * Take over a fresh `cp` of the golden VM: mint its proxy token, then replace
 * the golden's worker token (which the copy still has) with one only the hub
 * knows. The new token is stored only once the VM accepted it.
 */
export async function adoptVoyageVm(vm: string, golden: string, deps: AdoptDeps = {}): Promise<{ ok: boolean; message: string }> {
  const read = deps.read ?? readSecret;
  const write = deps.write ?? writeSecret;
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  try {
    // Minted once: callers retry adoption until the copy's worker answers, and each mint adds a key to the account.
    let proxy = await read(`exe-vm-${vm}`);
    if (!proxy) {
      const mint = deps.vmToken ?? ((n: string) => exeClient().vmToken(n));
      proxy = await mint(vm);
      if (!(await write(`exe-vm-${vm}`, proxy))) return { ok: false, message: `could not store the VM token for ${vm}` };
    }
    const goldenToken = await read(`exe-worker-${golden}`);
    if (!goldenToken) return { ok: false, message: `no worker token for the golden VM ${golden}` };
    const token = deps.random ? deps.random() : randomBytes(32).toString("hex");
    if (token === goldenToken) return { ok: false, message: "refusing to reuse the golden worker token" };
    const res = await doFetch(`https://${vm}.exe.xyz:${EXE_WORKER_PORT}/host/token`, {
      method: "POST",
      headers: { "X-Exedev-Authorization": `Bearer ${proxy}`, Authorization: `Bearer ${goldenToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok || body.ok !== true) return { ok: false, message: `${vm} refused the new worker token (HTTP ${res.status}${body.message ? `: ${body.message}` : ""})` };
    if (!(await write(`exe-worker-${vm}`, token))) return { ok: false, message: `${vm} has a new worker token the hub could not store` };
    return { ok: true, message: `${vm} has its own worker token` };
  } catch (e) {
    return { ok: false, message: `could not reach ${vm}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Drop a removed VM's two tokens. */
export async function forgetVoyageVm(vm: string, deps: { remove?: (name: string) => Promise<boolean> } = {}): Promise<boolean> {
  const remove = deps.remove ?? deleteSecret;
  const results = await Promise.all([remove(`exe-vm-${vm}`), remove(`exe-worker-${vm}`)]);
  return results.every(Boolean);
}
