import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { laptopCan, laptopFetch, laptopToken } from "./laptop.ts";
import { nodeStateDir } from "./paths.ts";
import type { ShipHost } from "./ship-host.ts";
import { nodePublicUrl, workerHost } from "./worker-host.ts";

/**
 * The captain's laptop as a ship host (vault plan
 * fleet/plans/feature/remote-ship-hosts, H2): a voyage sailed "on the laptop"
 * keeps its worktree there, runs its checks and its crew's pi there (Gondolin
 * works on macOS), and reports to the hub's node like any crew. The laptop
 * side is dashboard/worker.ts with lib/hosted.ts deciding what it accepts.
 *
 * The captain directs it from the Harbor: **Laptop voyages** on means ships
 * may sail on the laptop while it is awake; off (closing it for the day) means
 * new voyages sail on the hub, and open laptop voyages can be moved to the hub.
 */

const statePath = () => join(nodeStateDir(), "laptop-voyages.json");

export type LaptopVoyages = { on: boolean; at?: string };

export function laptopVoyages(): LaptopVoyages {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as LaptopVoyages;
    return { on: j.on === true, at: j.at };
  } catch {
    return { on: false };
  }
}

export function setLaptopVoyages(on: boolean): LaptopVoyages {
  const s = { on, at: new Date().toISOString() };
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s) + "\n");
  return s;
}

export { nodePublicUrl } from "./worker-host.ts";

/** Can a voyage sail on the laptop right now: the captain allows it, the worker is up, the node is reachable. */
export async function laptopSailable(): Promise<{ ok: boolean; why: string }> {
  if (!laptopVoyages().on) return { ok: false, why: "laptop voyages are off in the Harbor" };
  if (!nodePublicUrl()) return { ok: false, why: "the hub's node has no tailnet address (FLEET_NODE_PUBLIC_URL)" };
  if (!(await laptopCan("ship-host"))) return { ok: false, why: "the laptop is not available" };
  return { ok: true, why: "" };
}

export { LINK_LOST } from "./worker-host.ts";

/** The captain's laptop (dashboard/worker.ts there), through Tailscale Serve with the shared worker token. */
export const laptopHost: ShipHost = workerHost({
  kind: "laptop",
  label: "the laptop",
  url: () => (process.env.FLEET_LAPTOP_URL ?? "").replace(/\/+$/, ""),
  auth: async (): Promise<Record<string, string>> => {
    const token = await laptopToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  },
  fetch: (url, init) => laptopFetch(url.replace(/^https?:\/\/[^/]+/, ""), init),
  available: async () => (await laptopSailable()).ok,
});
