import { readShips } from "./fleet-layers.ts";
import { spawnTimed } from "./proc.ts";
import { recordRun } from "./metrics.ts";
import { logShipEvent } from "./ship-log.ts";
import { voyageWorktree } from "./voyage-worktree.ts";

/**
 * Host checks (R4): a crewmate whose tools run in a VM cannot run Docker, and
 * some ships test only through Docker Compose (pochteca: `just pytest`). So
 * the captain lists commands per ship (`checks:` in fleet/ships/<ship>.yaml),
 * and a crewmate may run one of them by name on the host, in the ship's repo,
 * with a time limit. It picks the name; it never writes the command line.
 */

const TIMEOUT_MS = Math.max(30, Number(process.env.FLEET_CHECK_TIMEOUT_SECS) || 900) * 1000;
const OUTPUT_MAX = 12_000;
const running = new Set<string>();

/** The end of long output (test failures are at the bottom). */
export function tail(text: string, max = OUTPUT_MAX): string {
  return text.length <= max ? text : `[… ${text.length - max} earlier characters cut …]\n${text.slice(-max)}`;
}

/** The commit a folder is on and whether it has uncommitted changes (ignored files do not count). */
export async function treeState(cwd: string): Promise<{ commit: string; dirty: boolean }> {
  const head = await spawnTimed(["git", "rev-parse", "HEAD"], { timeoutMs: 15_000, cwd });
  const status = await spawnTimed(["git", "status", "--porcelain"], { timeoutMs: 30_000, cwd });
  return { commit: head.exitCode === 0 ? head.stdout.trim() : "", dirty: status.exitCode !== 0 || status.stdout.trim().length > 0 };
}

export async function runCheck(shipId: string, from: string, name: string): Promise<{ ok: boolean; message: string }> {
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship) return { ok: false, message: `No ship ${shipId}.` };
  const names = Object.keys(ship.checks);
  const cmd = ship.checks[name];
  if (!cmd) return { ok: false, message: names.length ? `No check named "${name}" on ${shipId}. Checks: ${names.join(", ")}.` : `${shipId} lists no checks (the captain adds them under checks: in its ship file).` };
  const key = `${shipId}\u0000${name}`;
  if (running.has(key)) return { ok: false, message: `Check ${name} is already running on ${shipId}; wait for it.` };
  running.add(key);
  const started = Date.now();
  logShipEvent(shipId, from, "check", `Check ${name} started: ${cmd}`, { name, cmd });
  try {
    // In the voyage's worktree when one is open (the crew's work), else the repo.
    // A login shell, so the captain's PATH (just, docker, uv) resolves as in a terminal.
    const cwd = voyageWorktree(shipId)?.path ?? ship.path;
    // What code this run checks: gates count only runs on the current commit with a clean tree.
    const { commit, dirty } = await treeState(cwd);
    const res = await spawnTimed(["/bin/zsh", "-lc", cmd], { timeoutMs: TIMEOUT_MS, cwd, env: { ...process.env, CI: "1" } });
    const secs = Math.round((Date.now() - started) / 1000);
    const passed = !res.timedOut && res.exitCode === 0;
    const verdict = res.timedOut ? `timed out after ${secs}s` : passed ? `passed in ${secs}s` : `failed (exit ${res.exitCode}) in ${secs}s`;
    logShipEvent(shipId, from, "check", `Check ${name} ${verdict}`, { name, exitCode: res.exitCode, timedOut: res.timedOut, secs });
    recordRun({ ship: shipId, agent: from, kind: "check", name, ok: passed, ms: Date.now() - started, detail: verdict, commit, dirty });
    const out = tail(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`.trim());
    return { ok: passed, message: `Check ${name} (${cmd}) ${verdict}.\n\n${out || "(no output)"}` };
  } finally {
    running.delete(key);
  }
}
