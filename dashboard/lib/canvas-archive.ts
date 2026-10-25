import { readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { canvasDir, ITEM_RE } from "./canvas.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Canvas items end with the work they showed. A crewmate's canvas used to
 * keep every item from every voyage, so the captain's panel piled up with
 * stale screenshots. At dock (the ship's crew), at Set sail (leftovers), and
 * on New session (that agent), the items move to an archive folder outside
 * every agent's inbox: no agent reads it, and it is not in the vault (images
 * would bloat its git). The voyage note names the folder; folders older than
 * KEEP_DAYS go with the weekly session-archive job.
 */

export const KEEP_DAYS = 30;
const REL_ROOT = join(".archive", "canvas");
const archiveRoot = () => join(fleetInboxRoot(), REL_ROOT);

/** Move the agents' canvas items into one archive folder; returns how many and where (relative to the inbox). */
export async function archiveCanvas(agentIds: string[], label: string, now = new Date()): Promise<{ items: number; dir: string | null }> {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const folder = `${stamp}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "canvas"}`;
  let items = 0;
  for (const agent of agentIds) {
    const names = await readdir(canvasDir(agent)).catch(() => [] as string[]);
    for (const name of names) {
      if (!ITEM_RE.test(name)) continue;
      const src = join(canvasDir(agent), name);
      if (!(await stat(src).catch(() => null))?.isDirectory()) continue;
      const dest = join(archiveRoot(), folder, agent);
      await mkdir(dest, { recursive: true });
      await rename(src, join(dest, name));
      items++;
    }
  }
  return { items, dir: items ? join(REL_ROOT, folder) : null };
}

/** Delete archive folders older than `days`; returns how many went. */
export function pruneCanvasArchive(days = KEEP_DAYS, now = Date.now()): number {
  let gone = 0;
  let names: string[] = [];
  try {
    names = readdirSync(archiveRoot());
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = join(archiveRoot(), name);
    try {
      if (now - statSync(dir).mtimeMs < days * 86_400_000) continue;
      rmSync(dir, { recursive: true, force: true });
      gone++;
    } catch {
      /* raced */
    }
  }
  return gone;
}
