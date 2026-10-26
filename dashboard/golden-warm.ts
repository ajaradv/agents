/**
 * Warm a golden VM (runs ON the VM; bin/voyage-vm-setup warm <ship>): bring the
 * ship's rig up once on its default branch, prove it ready, then take it down
 * but keep the images, so every copy of this VM starts its rig warm (a cold rig
 * takes minutes of pulls and builds). The golden's own checkout, not a captain's.
 *
 *   bun dashboard/golden-warm.ts <ship>
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostedExecEnv, type HostedShip } from "./lib/hosted.ts";
import { readShips } from "./lib/fleet-layers.ts";
import { ROOT } from "./lib/paths.ts";
import { spawnTimed } from "./lib/proc.ts";
import { copyRigEnv, previewUrl, type RigDecl } from "./lib/rig.ts";

export const GOLDEN_PORT = 4100;
export const GOLDEN_SLUG = "golden";
const STEP_TIMEOUT_MS = 25 * 60_000;

/** The golden's Compose project: the ship's id as Compose names it, then `-golden`. */
export const goldenProject = (shipId: string) => `${shipId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-golden`;

/** The ship's `down` without the flags that delete images (`--rmi local|all`): the warm images are the point. */
export const keepImages = (down: string) => down.replace(/\s--rmi(?:=|\s+)(?:local|all)\b/g, "").trim();

export type WarmPlan = { project: string; up: string[]; ready: string; down: string };

export function warmPlan(shipId: string, rig: RigDecl): WarmPlan {
  return { project: goldenProject(shipId), up: rig.up, ready: rig.ready ? previewUrl(rig.ready, GOLDEN_PORT, GOLDEN_SLUG) : "", down: keepImages(rig.down) };
}

type Step = { ok: boolean; tail: string };
export type WarmDeps = {
  /** Run one shell step in the checkout; the real one is bash -lc with the rig env. */
  run: (script: string, timeoutMs: number) => Promise<Step>;
  /** Probe the ready URL (bin/rig-ready --timeout 300). */
  ready: (url: string) => Promise<Step>;
  copyEnv: () => Promise<{ ok: boolean; message: string }>;
  removeEnv: () => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
};

/** Up, ready, then down keeping images. The teardown and the env cleanup run even when an earlier step failed. */
export async function warmGolden(shipId: string, rig: RigDecl, d: WarmDeps): Promise<{ ok: boolean; seconds: number; message: string }> {
  const log = d.log ?? ((l: string) => console.log(l));
  const now = d.now ?? Date.now;
  const t0 = now();
  const plan = warmPlan(shipId, rig);
  let failure = "";
  const copied = await d.copyEnv();
  if (!copied.ok) failure = `rig env: ${copied.message}`;
  else log(`rig env: ${copied.message}`);
  for (const step of failure ? [] : plan.up) {
    log(`up: ${step}`);
    const r = await d.run(`( ${step} )`, STEP_TIMEOUT_MS);
    if (!r.ok) {
      failure = `up step failed: ${step}\n${r.tail}`;
      break;
    }
  }
  if (!failure && plan.ready) {
    log(`ready: ${plan.ready}`);
    const r = await d.ready(plan.ready);
    if (!r.ok) failure = `not ready at ${plan.ready}\n${r.tail}`;
  }
  if (plan.down) {
    log(`down: ${plan.down}`);
    const r = await d.run(plan.down, 10 * 60_000);
    if (!r.ok) failure ||= `down failed: ${plan.down}\n${r.tail}`;
  }
  await d.removeEnv().catch(() => {});
  const seconds = Math.round((now() - t0) / 1000);
  return failure ? { ok: false, seconds, message: failure } : { ok: true, seconds, message: "warm" };
}

const tailOf = (r: { stdout: string; stderr: string }) => `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-15).join("\n");

if (import.meta.main) {
  const shipId = process.argv[2] ?? "";
  const ship = (await readShips()).find((s) => s.id === shipId);
  if (!ship?.rig) {
    console.error(`golden-warm: ${shipId || "no ship given"} ${ship ? "declares no rig" : "is not a ship on this machine"}`);
    process.exit(1);
  }
  const rig = ship.rig;
  const hosted: HostedShip = { id: ship.id, path: ship.path, checks: ship.checks, isolation: ship.isolation, rig };
  const env = { ...process.env, CI: "1", ...hostedExecEnv(hosted, { project: goldenProject(ship.id), port: GOLDEN_PORT, slug: GOLDEN_SLUG }) };
  // The rig runs in a linked worktree, as a voyage's does: some ships' rigs refuse the main checkout
  // (lineage_atria's dev_worktree.sh attach), and the checkout stays clean for copies.
  const wt = join(homedir(), ".fleet-golden-warm", ship.id);
  await rm(wt, { recursive: true, force: true });
  await spawnTimed(["git", "worktree", "prune"], { timeoutMs: 30_000, cwd: ship.path });
  const added = await spawnTimed(["git", "worktree", "add", "--detach", wt, "HEAD"], { timeoutMs: 120_000, cwd: ship.path });
  if (added.exitCode !== 0) {
    console.error(`golden-warm: could not make a worktree: ${tailOf(added)}`);
    process.exit(1);
  }
  const r = await warmGolden(ship.id, rig, {
    run: async (script, timeoutMs) => {
      const res = await spawnTimed(["bash", "-lc", script], { timeoutMs, cwd: wt, env });
      return { ok: res.exitCode === 0 && !res.timedOut, tail: tailOf(res) };
    },
    ready: async (url) => {
      const res = await spawnTimed([join(ROOT, "bin", "rig-ready"), url, "--timeout", "300"], { timeoutMs: 330_000, cwd: wt, env });
      return { ok: res.exitCode === 0, tail: tailOf(res) };
    },
    copyEnv: () => copyRigEnv(ship.id, rig, wt),
    // The worktree goes as a whole, env files with it.
    removeEnv: async () => {},
  });
  await spawnTimed(["git", "worktree", "remove", "--force", wt], { timeoutMs: 120_000, cwd: ship.path });
  // Containers may have left root-owned files that git cannot remove.
  if (existsSync(wt)) await spawnTimed(["sudo", "-n", "rm", "-rf", wt], { timeoutMs: 120_000, cwd: ship.path });
  await spawnTimed(["git", "worktree", "prune"], { timeoutMs: 30_000, cwd: ship.path });
  console.log(r.ok ? `warm in ${r.seconds}s` : `warm failed after ${r.seconds}s\n${r.message}`);
  process.exit(r.ok ? 0 : 1);
}
