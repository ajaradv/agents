import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Screenshots on disk (bin/fleet-shot writes them). An agent's session keeps
 * its own shrunken copy of any image it looked at (extensions/image-window.ts),
 * so the files are only needed while someone is checking them: the captain
 * clears them when done (Health > Diagnostics, or `bin/fleet-shot --clear`),
 * and the weekly session-archive job drops any older than a week.
 */

export const SWEEP_DAYS = 7;

export const shotsDir = () => process.env.FLEET_SHOTS_DIR ?? join(process.env.TMPDIR ?? tmpdir(), "fleet-shots");

const isShot = (name: string) => /^shot-.*\.png$/.test(name);

function shotFiles(dir: string): { path: string; bytes: number; mtime: number }[] {
  try {
    return readdirSync(dir)
      .filter(isShot)
      .map((n) => {
        const st = statSync(join(dir, n));
        return { path: join(dir, n), bytes: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

export function shotsUsage(dir = shotsDir()): { files: number; bytes: number } {
  const files = shotFiles(dir);
  return { files: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) };
}

/** Delete screenshots older than `days` (0: all of them). Only fleet-shot's own files. */
export function clearShots(days = 0, dir = shotsDir(), now = Date.now()): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const f of shotFiles(dir)) {
    if (days > 0 && now - f.mtime < days * 86_400_000) continue;
    rmSync(f.path, { force: true });
    files++;
    bytes += f.bytes;
  }
  return { files, bytes };
}

const mb = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`);

/** Health > Diagnostics: how many screenshots are on disk, and a button to clear them. */
export function shotsHtml(cleared?: { files: number; bytes: number }): string {
  const u = shotsUsage();
  const done = cleared ? ` <span class="muted">Cleared ${cleared.files} (${mb(cleared.bytes)}).</span>` : "";
  const button = u.files ? `<button class="d-btn d-btn-sm" hx-post="/partials/shots/clear" hx-target="#shots" hx-swap="innerHTML" hx-confirm="Delete all ${u.files} screenshot files? Anything an agent already looked at stays in its session.">Clear screenshots</button>` : "";
  return `<div class="d-card bg-base-100 d-card-border"><div class="d-card-body d-card-sm flex-row items-center justify-between gap-3 flex-wrap">
    <span>Screenshots on disk · ${u.files ? `${u.files} (${mb(u.bytes)})` : "none"}${done}</span>${button}
  </div></div>`;
}
