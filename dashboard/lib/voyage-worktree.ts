import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ShipRow } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";
import { spawnTimed } from "./proc.ts";

/**
 * A worktree per voyage (vault plan fleet/plans/research/helm-and-maneuvers).
 * In the first isolated voyage, the crew created its branch in the repo
 * folder itself and switched the captain's own checkout. Firstmate solved
 * this long ago ("worktree tangle"); this borrows its approach:
 *
 * - On voyage start, lease a worktree from treehouse's pool (`treehouse get
 *   --lease`, non-interactive and durable, the holder named after the voyage),
 *   assert it is a real linked worktree distinct from the primary checkout,
 *   require it clean, and create `crew/<slug>` from the default branch's tip.
 * - Crewmates work there (bin/launch reads the record; a crewmate's VM mounts
 *   the worktree at /workspace and the repo's .git at its own path).
 * - On dock: refuse while there is uncommitted work, then return the worktree
 *   (`treehouse return --force --if-lease-id`). The branch stays in the repo
 *   for the captain to merge. Warn if the primary checkout's branch moved.
 *
 * Only for ships the fleet's own crew sails (orchestrator: lead); Firstmate
 * manages worktrees for its ships itself.
 */

export type VoyageWorktree = {
  ship: string;
  path: string;
  leaseId: string;
  branch: string;
  base: string;
  /** The repo's .git directory (a linked worktree's .git file points into it). */
  gitDir: string;
  /** The primary checkout's branch when the voyage started (tangle check on dock). */
  primaryBranch: string;
  started: string;
};

const recordPath = (shipId: string) => join(fleetInboxRoot(), "ships", shipId, "worktree.json");

export function usesVoyageWorktrees(ship: Pick<ShipRow, "orchestrator" | "path">): boolean {
  return ship.orchestrator === "lead" && Boolean(ship.path) && existsSync(join(ship.path, ".git"));
}

export function voyageWorktree(shipId: string): VoyageWorktree | null {
  try {
    return JSON.parse(readFileSync(recordPath(shipId), "utf8")) as VoyageWorktree;
  } catch {
    return null;
  }
}

function treehouseBin(): string {
  const local = join(homedir(), ".local", "bin", "treehouse");
  return existsSync(local) ? local : "treehouse";
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const r = await spawnTimed(["git", ...args], { timeoutMs, cwd });
  return { ok: !r.timedOut && r.exitCode === 0, out: (r.stdout || r.stderr).trim() };
}

/** The default branch to start from: origin's HEAD when there is a remote, else local main or master. */
async function defaultBase(cwd: string): Promise<string | null> {
  const remote = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.out) return remote.out;
  for (const b of ["main", "master"]) if ((await git(cwd, ["rev-parse", "--verify", "--quiet", b])).ok) return b;
  return null;
}

/** A branch name for this voyage that does not exist yet. */
export function voyageBranch(slug: string, taken: (b: string) => boolean, today = new Date().toISOString().slice(0, 10)): string {
  const base = `crew/${slug.slice(0, 48).replace(/-+$/, "") || "voyage"}`;
  if (!taken(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken(`${base}-${today}-${i}`)) return `${base}-${today}-${i}`;
  return `${base}-${Date.now()}`;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export async function leaseVoyageWorktree(ship: Pick<ShipRow, "id" | "path">, slug: string): Promise<{ ok: true; worktree: VoyageWorktree } | { ok: false; message: string }> {
  const primary = ship.path;
  if (!primary || !existsSync(join(primary, ".git"))) return { ok: false, message: `${ship.id} has no git repo at ${primary || "(no path)"}; voyage not started.` };
  const hasRemote = (await git(primary, ["remote"])).out.split("\n").includes("origin");
  const holder = `voyage:${ship.id}:${slug}`.slice(0, 120);
  const lease = await spawnTimed([treehouseBin(), "get", "--lease", "--json", "--lease-holder", holder, ...(hasRemote ? [] : ["--no-fetch"])], { timeoutMs: 180_000, cwd: primary });
  let info: { path?: string; lease_id?: string } = {};
  try {
    info = JSON.parse(lease.stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}");
  } catch {
    /* reported below */
  }
  if (lease.exitCode !== 0 || !info.path || !info.lease_id) {
    return { ok: false, message: `Could not lease a worktree for ${ship.id} (treehouse): ${(lease.stderr || lease.stdout).trim().split("\n").filter((l) => !/new version|treehouse update/.test(l)).slice(-2).join(" ").slice(0, 300) || "no output"}` };
  }
  const path = info.path;
  const release = () => spawnTimed([treehouseBin(), "return", "--force", "--if-lease-id", info.lease_id!, path], { timeoutMs: 120_000, cwd: primary });
  try {
    return await prepareLease(ship, slug, primary, path, info.lease_id, release);
  } catch (e) {
    // Never leak a lease: anything unexpected after leasing returns the worktree.
    await release();
    return { ok: false, message: `Setting up ${ship.id}'s worktree failed (${e instanceof Error ? e.message : String(e)}); voyage not started.` };
  }
}

async function prepareLease(
  ship: Pick<ShipRow, "id" | "path">,
  slug: string,
  primary: string,
  path: string,
  leaseId: string,
  release: () => Promise<unknown>,
): Promise<{ ok: true; worktree: VoyageWorktree } | { ok: false; message: string }> {
  // Isolation, as Firstmate asserts it: a linked worktree, not the primary checkout.
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (!common.ok || !top.ok || real(top.out) === real(primary) || real(common.out) !== real(join(primary, ".git"))) {
    await release();
    return { ok: false, message: `Treehouse gave ${path}, which is not an isolated worktree of ${primary}; voyage not started.` };
  }
  if ((await git(path, ["status", "--porcelain"])).out) {
    await release();
    return { ok: false, message: `The leased worktree ${path} is not clean; voyage not started.` };
  }
  const base = await defaultBase(path);
  if (!base) {
    await release();
    return { ok: false, message: `Could not find ${ship.id}'s default branch (origin/HEAD, main, or master); voyage not started.` };
  }
  const existing = new Set((await git(primary, ["for-each-ref", "--format=%(refname:short)", "refs/heads/crew/"])).out.split("\n").filter(Boolean));
  const branch = voyageBranch(slug, (b) => existing.has(b));
  const sw = await git(path, ["switch", "-c", branch, base]);
  if (!sw.ok) {
    await release();
    return { ok: false, message: `Could not create ${branch} from ${base}: ${sw.out.slice(0, 200)}` };
  }
  const primaryBranch = (await git(primary, ["branch", "--show-current"])).out;
  const worktree: VoyageWorktree = { ship: ship.id, path, leaseId, branch, base, gitDir: real(common.out), primaryBranch, started: new Date().toISOString() };
  await mkdir(dirname(recordPath(ship.id)), { recursive: true });
  await writeFile(recordPath(ship.id), JSON.stringify(worktree, null, 2) + "\n", "utf8");
  return { ok: true, worktree };
}

/** Uncommitted changes in the voyage's worktree (files, short status lines). */
export async function worktreeChanges(w: VoyageWorktree): Promise<string[]> {
  if (!existsSync(w.path)) return [];
  return (await git(w.path, ["status", "--porcelain"])).out.split("\n").filter(Boolean);
}

export async function releaseVoyageWorktree(ship: Pick<ShipRow, "id" | "path">): Promise<{ ok: boolean; message: string }> {
  const w = voyageWorktree(ship.id);
  if (!w) return { ok: true, message: "" };
  const changes = await worktreeChanges(w);
  if (changes.length) {
    return { ok: false, message: `${ship.id}'s voyage worktree has uncommitted work (${changes.slice(0, 5).join("; ")}${changes.length > 5 ? "; …" : ""}). Have the crew commit or discard it, then dock again.` };
  }
  const ahead = (await git(ship.path, ["rev-list", "--count", `${w.base}..${w.branch}`])).out;
  const r = await spawnTimed([treehouseBin(), "return", "--force", "--if-lease-id", w.leaseId, w.path], { timeoutMs: 120_000, cwd: ship.path });
  if (r.exitCode !== 0) {
    return { ok: false, message: `Could not return ${ship.id}'s worktree to treehouse: ${(r.stderr || r.stdout).trim().slice(0, 200)}. The voyage stays open.` };
  }
  await rm(recordPath(ship.id), { force: true });
  const now = (await git(ship.path, ["branch", "--show-current"])).out;
  const tangle = w.primaryBranch && now !== w.primaryBranch ? ` Warning: your checkout of ${ship.id} moved from ${w.primaryBranch} to ${now || "a detached HEAD"} during the voyage.` : "";
  const work = Number(ahead) > 0 ? `Branch ${w.branch} has ${ahead} commit(s) on ${w.base}, ready for you to review and merge.` : `Branch ${w.branch} has no commits; nothing to merge.`;
  return { ok: true, message: `${work}${tangle}` };
}
