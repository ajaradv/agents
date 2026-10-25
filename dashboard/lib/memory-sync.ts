import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ShipRow } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";
import type { ShipHost } from "./ship-host.ts";
import { voyageHost } from "./voyage-worktree.ts";

/**
 * Live crew memory for voyages on another ship host (S3d, vault plan
 * fleet/plans/feature/s3-fleet-state-api). A remote host keeps the crew's
 * memory where the crew runs (lib/hosted.ts), and it used to come back only at
 * dock, so the deck showed a laptop crewmate's state hours late. While such a
 * voyage sails, the node pulls the memory every SYNC_MS and writes the files
 * that changed: the hub's copy is a mirror, the host stays the source until
 * dock (lib/shipyard.ts brings it back for good then).
 */

export const SYNC_MS = 30_000;

/** The last pull for a ship: which host, when it was tried, when it last answered. */
export type MemorySync = { host: string; tried: string; synced: string | null; changed: number; message?: string };

const MEMORY_REL = /^(ships\/[a-z][\w-]*|[a-z][\w-]*)\/memory\/[a-z][\w-]*\.md$/;
const syncPath = (ship: string) => join(fleetInboxRoot(), "ships", ship, "memory-sync.json");

export function readMemorySync(ship: string): MemorySync | null {
  try {
    return JSON.parse(readFileSync(syncPath(ship), "utf8")) as MemorySync;
  } catch {
    return null;
  }
}

function writeMemorySync(ship: string, s: MemorySync): void {
  mkdirSync(dirname(syncPath(ship)), { recursive: true });
  writeFileSync(syncPath(ship), JSON.stringify(s) + "\n");
}

/** Write the files whose text differs from the hub's copy; returns their paths (relative to the inbox). */
export function mirrorMemory(files: Record<string, string>): string[] {
  const changed: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    if (!MEMORY_REL.test(rel) || typeof text !== "string") continue;
    const file = join(fleetInboxRoot(), rel);
    let old: string | null = null;
    try {
      old = readFileSync(file, "utf8");
    } catch {
      /* new on the hub */
    }
    if (old === text) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    changed.push(rel);
  }
  return changed;
}

/**
 * One pass over the ships: each lead-run ship whose voyage sails on a host that
 * keeps its own memory. Returns the ships whose memory changed (the node tells
 * the dashboard). A host that does not answer (the laptop asleep) is recorded,
 * not logged: the next pass tries again.
 */
export async function syncRemoteMemory(ships: ShipRow[], hostFor: (ship: string) => ShipHost = voyageHost): Promise<string[]> {
  const changedShips: string[] = [];
  for (const ship of ships) {
    if (ship.orchestrator !== "lead") continue;
    const host = hostFor(ship.id);
    if (host.kind === "local" || !host.getMemory) continue;
    const prev = readMemorySync(ship.id);
    const tried = new Date().toISOString();
    try {
      const changed = mirrorMemory(await host.getMemory(ship.id, ship.crew.map((r) => `${ship.id}-${r}`)));
      writeMemorySync(ship.id, { host: host.label, tried, synced: tried, changed: changed.length });
      if (changed.length) changedShips.push(ship.id);
    } catch (e) {
      writeMemorySync(ship.id, { host: host.label, tried, synced: prev?.host === host.label ? prev.synced : null, changed: 0, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return changedShips;
}

/** A voyage's memory as the deck shows it: the shared scratchpad, then each crewmate's plan and state. */
export type MemoryNote = { label: string; rel: string; text: string; updated: string };

export function voyageMemoryNotes(ship: string, crew: string[]): MemoryNote[] {
  const out: MemoryNote[] = [];
  const add = (label: string, rel: string) => {
    const file = join(fleetInboxRoot(), rel);
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) out.push({ label, rel, text, updated: statSync(file).mtime.toISOString() });
    } catch {
      /* none yet */
    }
  };
  add("Voyage scratchpad", `ships/${ship}/memory/voyage.md`);
  for (const role of crew) {
    add(`${role}: state`, `${ship}-${role}/memory/state.md`);
    add(`${role}: plan`, `${ship}-${role}/memory/plan.md`);
  }
  return out;
}
