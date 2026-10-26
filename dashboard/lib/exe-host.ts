import { readSecret } from "./secret-store.ts";
import type { ShipHost } from "./ship-host.ts";
import { workerHost } from "./worker-host.ts";

/**
 * An exe.dev voyage VM as a ship host (R2 of vault plan fleet/plans/feature/ship-rigging):
 * the same worker as the laptop's (dashboard/worker.ts, FLEET_WORKER_HOST set
 * so exe.dev's proxy can reach it), at https://<vm>.exe.xyz:<port>/. Two tokens:
 * the VM's exe.dev token in X-Exedev-Authorization (the proxy checks and strips
 * it) and the worker's own in Authorization.
 */

export const EXE_WORKER_PORT = Number(process.env.FLEET_EXE_WORKER_PORT ?? 8790);

export function exeVoyageHost(vm: string, deps: { fetch?: (url: string, init: RequestInit) => Promise<Response>; secret?: (name: string) => Promise<string> } = {}): ShipHost {
  const secret = deps.secret ?? readSecret;
  return workerHost({
    kind: "vm",
    label: `the exe.dev VM ${vm}`,
    url: () => `https://${vm}.exe.xyz:${EXE_WORKER_PORT}`,
    auth: async (): Promise<Record<string, string>> => {
      const [proxy, worker] = await Promise.all([secret(`exe-vm-${vm}`), secret("exe-worker-token")]);
      return { ...(proxy ? { "X-Exedev-Authorization": `Bearer ${proxy}` } : {}), ...(worker ? { Authorization: `Bearer ${worker}` } : {}) };
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    // A voyage already on a VM may always continue there; new voyages are placed by the shipyard.
    available: async () => true,
  });
}
