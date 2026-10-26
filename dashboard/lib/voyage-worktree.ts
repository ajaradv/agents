import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ShipRow } from "./fleet-layers.ts";
import { fleetInboxRoot } from "./paths.ts";
import type { RigRecord } from "./rig.ts";
import { exeVoyageHost } from "./exe-host.ts";
import { readShipConfig } from "./ship-config.ts";
import { hostGit, localHost, shipHost, type HostKind, type ShipHost } from "./ship-host.ts";

/**
 * A worktree per voyage (vault plan fleet/plans/research/helm-and-maneuvers).
 * In the first isolated voyage, the crew created its branch in the repo
 * folder itself and switched the captain's own checkout. Firstmate solved
 * this long ago ("worktree tangle"); this borrows its approach:
 *
 * - On voyage start, lease a worktree from treehouse's pool (`treehouse get
 *   --lease`, non-interactive and durable, the holder named after the voyage),
 *   assert it is a real linked worktree distinct from the primary checkout,
 *   require it clean, and create a conventional branch (`<type>/<words>`,
 *   skills/git-conventions) from the default branch's tip.
 * - Crewmates work there (bin/launch reads the record; a crewmate's VM mounts
 *   the worktree at /workspace and the repo's .git at its own path).
 * - On dock: refuse while there is uncommitted work, then return the worktree
 *   (`treehouse return --force --if-lease-id`). The branch stays in the repo
 *   for the captain to merge. Warn if the primary checkout's branch moved.
 *
 * Only for ships the fleet's own crew sails (orchestrator: lead); Firstmate
 * manages worktrees for its ships itself.
 *
 * Every git and treehouse call runs on the voyage's ship host (lib/ship-host.ts):
 * the record names it, so the dock returns the worktree where it was leased.
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
  /** The ship host holding the worktree (lib/ship-host.ts); records from before hosts are local. */
  host?: HostKind;
  /** The ship's repo on that host (paths differ between machines); older records use the ship's path. */
  repo?: string;
  /** The voyage's running copy of the app (lib/rig.ts): Compose project, port, preview, state. */
  rig?: RigRecord;
  /** A design or spec session (lib/sessions.ts): the flagship officer working in this worktree as the ship's guest. */
  guest?: string;
  /** host "vm": the exe.dev voyage VM holding the worktree (lib/exe-host.ts). */
  vm?: string;
};

const recordPath = (shipId: string) => join(fleetInboxRoot(), "ships", shipId, "worktree.json");

/** A remote host checks its own repo when leasing; this machine's must be a git checkout. */
export function usesVoyageWorktrees(ship: Pick<ShipRow, "orchestrator" | "path">, host: ShipHost = localHost): boolean {
  if (ship.orchestrator !== "lead") return false;
  return host.kind !== "local" || (Boolean(ship.path) && existsSync(join(ship.path, ".git")));
}

export function voyageWorktree(shipId: string): VoyageWorktree | null {
  try {
    return JSON.parse(readFileSync(recordPath(shipId), "utf8")) as VoyageWorktree;
  } catch {
    return null;
  }
}

/** Change the voyage's rig record (no-op without an open worktree); returns the record as written. */
export function updateVoyageRig(shipId: string, patch: Omit<Partial<RigRecord>, "brief"> & { brief?: RigRecord["brief"] | null }): RigRecord | null {
  const w = voyageWorktree(shipId);
  if (!w) return null;
  const merged = { ...(w.rig ?? {}), ...patch, at: new Date().toISOString() } as RigRecord & { brief?: RigRecord["brief"] | null };
  if (merged.brief === null) delete merged.brief;
  writeFileSync(recordPath(shipId), JSON.stringify({ ...w, rig: merged }, null, 2) + "\n", "utf8");
  return merged as RigRecord;
}

/** Set the session guest on the open worktree record (lib/sessions.ts). */
export function setVoyageGuest(shipId: string, guest: string): void {
  const w = voyageWorktree(shipId);
  if (w) writeFileSync(recordPath(shipId), JSON.stringify({ ...w, guest }, null, 2) + "\n", "utf8");
}

/** The ship whose open session has this agent as its guest, if any (the node launches it there). */
export function guestShip(agentId: string): string | undefined {
  let ships: string[] = [];
  try {
    ships = readdirSync(join(fleetInboxRoot(), "ships"));
  } catch {
    return undefined;
  }
  return ships.find((id) => voyageWorktree(id)?.guest === agentId);
}

/** Ports held by open voyages on a host (every ship's record), so a new voyage takes a free one. */
export function rigPortsOn(host: HostKind): number[] {
  const out: number[] = [];
  let ships: string[] = [];
  try {
    ships = readdirSync(join(fleetInboxRoot(), "ships"));
  } catch {
    return out;
  }
  for (const id of ships) {
    const w = voyageWorktree(id);
    if (w?.rig && (w.host ?? "local") === host) out.push(w.rig.port);
  }
  return out;
}

/** The ship host for a ship's repo work: the open voyage's, else this machine. */
export function voyageHost(shipId: string): ShipHost {
  return hostFor(voyageWorktree(shipId));
}

/** A record's host. One exe.dev VM per voyage: its host is made from the record's VM name (shipHost has no "vm" backend and would fall back to this machine). */
function hostFor(w: Pick<VoyageWorktree, "host" | "vm" | "ship"> | null | undefined): ShipHost {
  if (w?.host === "vm" && w.vm) return exeVoyageHost(w.vm, { ship: w.ship });
  return shipHost(w?.host);
}

/** treehouse on the host: this machine's ~/.local/bin copy when it has one, else from PATH. */
function treehouseBin(host: ShipHost): string {
  if (host.kind !== "local") return "treehouse";
  const local = join(homedir(), ".local", "bin", "treehouse");
  return existsSync(local) ? local : "treehouse";
}


/**
 * The branch a voyage starts from: the ship's `base_branch` (ship config) when
 * it exists, as origin/<branch> when the remote has it; else origin's HEAD when
 * there is a remote, else local main or master. A ship whose work lives on a
 * long-running branch (the fleet on fleet-reliability) sets base_branch, or its
 * crews build on a stale main.
 */
async function defaultBase(git: Git, cwd: string, configured?: string): Promise<string | null> {
  if (configured) {
    const local = (await git(cwd, ["rev-parse", "--verify", "--quiet", configured])).ok;
    const remote = (await git(cwd, ["rev-parse", "--verify", "--quiet", `origin/${configured}`])).ok;
    // The captain's local branch when it is ahead of origin (work not pushed yet), else origin's.
    if (local && remote && (await git(cwd, ["merge-base", "--is-ancestor", `origin/${configured}`, configured])).ok) return configured;
    if (remote) return `origin/${configured}`;
    if (local) return configured;
  }
  const remote = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote.ok && remote.out) return remote.out;
  for (const b of ["main", "master"]) if ((await git(cwd, ["rev-parse", "--verify", "--quiet", b])).ok) return b;
  return null;
}

type Git = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

const TYPE_RULES: [RegExp, string][] = [
  [/\b(fix|fixes|bug|broken|repair|crash|regression)\b/i, "fix"],
  [/\b(perf|performance|faster|speed up|optimi[sz]e)\b/i, "perf"],
  [/\b(upgrade|bump|update .*(deps|dependenc|version|to \d)|dependenc)/i, "chore"],
  [/\b(readme|docs?|documentation|document)\b/i, "docs"],
  [/\b(refactor|restructure|clean ?up|rename|reorgani[sz]e)\b/i, "refactor"],
  [/\b(tests?|coverage)\b/i, "test"],
  [/\b(ci|pipeline|github actions|workflow file)\b/i, "ci"],
  [/\b(build|packaging|webpack|docker ?file)\b/i, "build"],
];
const FILLER = new Set("a an the to of and or in on for with by from into under over at as is are be this that these those our its it add adds make makes one short small note please update the app django project repo code".split(" "));

/**
 * A conventional branch name for a goal (skills/git-conventions, the form
 * python-semantic-release reads): `<type>/<2-6 words>`, the type guessed from
 * the goal's wording (feat when nothing else fits). The lead renames it before
 * its first commit when the guess is wrong.
 */
export function branchForGoal(goal: string): string {
  const type = TYPE_RULES.find(([re]) => re.test(goal))?.[1] ?? "feat";
  const words = goal
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .match(/[a-z0-9]+(?:\.[0-9]+)*/g) ?? [];
  const picked: string[] = [];
  for (const w of words) {
    if (FILLER.has(w) || w === type || (picked.length === 0 && /^(upgrade|bump|fix|implement|create|write)$/.test(w) && type !== "feat")) continue;
    picked.push(w);
    if (picked.length >= 6 || picked.join("-").length >= 36) break;
  }
  return `${type}/${picked.join("-") || "voyage"}`;
}

/** A branch name for this voyage that does not exist yet. */
export function voyageBranch(name: string, taken: (b: string) => boolean, today = new Date().toISOString().slice(0, 10)): string {
  const base = name.includes("/") ? name : `feat/${name.slice(0, 48).replace(/-+$/, "") || "voyage"}`;
  if (!taken(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken(`${base}-${today}-${i}`)) return `${base}-${today}-${i}`;
  return `${base}-${Date.now()}`;
}

const realLocal = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** A voyage moving between hosts carries on its branch instead of starting one. */
export type Resume = { branch: string; base: string };

export async function leaseVoyageWorktree(ship: Pick<ShipRow, "id" | "path">, slug: string, goal = "", host: ShipHost = localHost, resume?: Resume, from?: string): Promise<{ ok: true; worktree: VoyageWorktree } | { ok: false; message: string }> {
  const primary = await host.repoPath(ship);
  const git: Git = (cwd, args) => hostGit(host, cwd, args);
  if (!primary || !(await host.hasRepo(primary))) return { ok: false, message: `${ship.id} has no git repo ${host.kind === "local" ? `at ${primary || "(no path)"}` : `on ${host.label}`}; voyage not started.` };
  const hasRemote = (await git(primary, ["remote"])).out.split("\n").includes("origin");
  const holder = `voyage:${ship.id}:${slug}`.slice(0, 120);
  const lease = await host.exec([treehouseBin(host), "get", "--lease", "--json", "--lease-holder", holder, ...(hasRemote ? [] : ["--no-fetch"])], { timeoutMs: 180_000, cwd: primary });
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
  const release = () => host.exec([treehouseBin(host), "return", "--force", "--if-lease-id", info.lease_id!, path], { timeoutMs: 120_000, cwd: primary });
  try {
    return await prepareLease(ship, host, goal ? branchForGoal(goal) : slug, primary, path, info.lease_id, release, resume, from);
  } catch (e) {
    // Never leak a lease: anything unexpected after leasing returns the worktree.
    await release();
    return { ok: false, message: `Setting up ${ship.id}'s worktree failed (${e instanceof Error ? e.message : String(e)}); voyage not started.` };
  }
}

async function prepareLease(
  ship: Pick<ShipRow, "id" | "path">,
  host: ShipHost,
  name: string,
  primary: string,
  path: string,
  leaseId: string,
  release: () => Promise<unknown>,
  resume?: Resume,
  from?: string,
): Promise<{ ok: true; worktree: VoyageWorktree } | { ok: false; message: string }> {
  const git: Git = (cwd, args) => hostGit(host, cwd, args);
  // Paths are the host's own: only this machine's can be resolved through symlinks here.
  const real = (p: string) => (host.kind === "local" ? realLocal(p) : resolve(p));
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
  let base: string | null;
  let branch: string;
  if (resume) {
    // Moving hosts: the branch was pushed from the other host; carry on from it.
    base = resume.base;
    branch = resume.branch;
    await git(path, ["fetch", "origin", branch]);
    const sw = await git(path, ["switch", "-c", branch, `origin/${branch}`]);
    if (!sw.ok) {
      await release();
      return { ok: false, message: `Could not check out ${branch} from origin on ${host.label}: ${sw.out.slice(0, 200)}` };
    }
  } else {
    const configured = readShipConfig(ship.id)?.base_branch;
    base = await defaultBase(git, path, typeof configured === "string" && /^[\w./-]{1,100}$/.test(configured) ? configured : undefined);
    if (!base) {
      await release();
      return { ok: false, message: `Could not find ${ship.id}'s default branch (origin/HEAD, main, or master); voyage not started.` };
    }
    const existing = new Set((await git(primary, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).out.split("\n").filter(Boolean));
    branch = voyageBranch(name, (b) => existing.has(b));
    // A voyage from a spec with a prototype (lib/specs.ts) starts from that pushed branch; the PR still targets base.
    let start = base;
    if (from) {
      await git(path, ["fetch", "origin", from]);
      start = `origin/${from}`;
    }
    const sw = await git(path, ["switch", "-c", branch, start]);
    if (!sw.ok) {
      await release();
      return { ok: false, message: `Could not create ${branch} from ${start}: ${sw.out.slice(0, 200)}` };
    }
  }
  const primaryBranch = (await git(primary, ["branch", "--show-current"])).out;
  const worktree: VoyageWorktree = { ship: ship.id, path, leaseId, branch, base, gitDir: real(common.out), primaryBranch, started: new Date().toISOString(), host: host.kind, repo: primary, ...(host.vm ? { vm: host.vm } : {}) };
  await mkdir(dirname(recordPath(ship.id)), { recursive: true });
  await writeFile(recordPath(ship.id), JSON.stringify(worktree, null, 2) + "\n", "utf8");
  return { ok: true, worktree };
}

/** Uncommitted changes in the voyage's worktree (files, short status lines). */
export async function worktreeChanges(w: VoyageWorktree): Promise<string[]> {
  const host = hostFor(w);
  if (!(await host.hasRepo(w.path))) return [];
  return (await hostGit(host, w.path, ["status", "--porcelain"])).out.split("\n").filter(Boolean);
}

export async function releaseVoyageWorktree(ship: Pick<ShipRow, "id" | "path">): Promise<{ ok: boolean; message: string }> {
  const w = voyageWorktree(ship.id);
  if (!w) return { ok: true, message: "" };
  const host = hostFor(w);
  const repo = w.repo ?? ship.path;
  const git: Git = (cwd, args) => hostGit(host, cwd, args);
  const changes = await worktreeChanges(w);
  if (changes.length) {
    return { ok: false, message: `${ship.id}'s voyage worktree has uncommitted work (${changes.slice(0, 5).join("; ")}${changes.length > 5 ? "; …" : ""}). Have the crew commit or discard it, then dock again.` };
  }
  // The lead may have renamed the branch (skills/git-conventions): use what the worktree is on now.
  const branch = (await git(w.path, ["branch", "--show-current"])).out || w.branch;
  const ahead = (await git(repo, ["rev-list", "--count", `${w.base}..${branch}`])).out;
  const r = await host.exec([treehouseBin(host), "return", "--force", "--if-lease-id", w.leaseId, w.path], { timeoutMs: 120_000, cwd: repo });
  if (r.exitCode !== 0) {
    return { ok: false, message: `Could not return ${ship.id}'s worktree to treehouse: ${(r.stderr || r.stdout).trim().slice(0, 200)}. The voyage stays open.` };
  }
  await rm(recordPath(ship.id), { force: true });
  const now = (await git(repo, ["branch", "--show-current"])).out;
  const tangle = w.primaryBranch && now !== w.primaryBranch ? ` Warning: your checkout of ${ship.id} moved from ${w.primaryBranch} to ${now || "a detached HEAD"} during the voyage.` : "";
  const work = Number(ahead) > 0 ? `Branch ${branch} has ${ahead} commit(s) on ${w.base}, ready for you to review and merge.` : `Branch ${branch} has no commits; nothing to merge.`;
  return { ok: true, message: `${work}${tangle}` };
}
