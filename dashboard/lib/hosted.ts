import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { ROOT } from "./paths.ts";
import { spawnTimed } from "./proc.ts";
import { readShipConfig } from "./ship-config.ts";
import { copyRigEnv, rigEnv, validRig } from "./rig.ts";

/**
 * This machine as a ship host for the hub (the laptop side of
 * lib/laptop-host.ts; vault plan fleet/plans/feature/remote-ship-hosts, H2).
 * The laptop worker serves these to the hub only, with the shared token. A
 * stolen token must not become a shell on the laptop, so what the hub may ask
 * is decided here, from this machine's own ship config:
 *
 * - **Folders:** a ship's repo on this machine, or one of its git worktrees.
 * - **Commands:** git (the subcommands a voyage uses, no option that runs
 *   programs or writes files elsewhere, pushes only of a voyage branch),
 *   `gh pr view|create`, `treehouse get|return`, and a check by its command
 *   as this machine's ship config lists it (the hub cannot add one).
 * - **Crewmates:** `<ship>-<role>` for a ship configured here and a role the
 *   fleet has. Security settings (isolation, env, VM allowlist, checks, path)
 *   come from this machine's config; from the hub only the crew, models,
 *   budgets, gates, maneuvers, and base branch.
 *
 * Hosted crews keep their sessions and memory in fleet/hosted (FLEET_INBOX for
 * their launches), apart from the laptop's own fleet/inbox.
 */

export const hostedInbox = () => process.env.FLEET_HOSTED_INBOX ?? join(ROOT, "fleet", "hosted");

/** The flagship officers who may come aboard a ship here for a design or spec session (lib/sessions.ts). */
export const GUEST_OFFICERS = ["designer", "architect"];

/** Ship config keys the hub may set for a hosted launch; everything else is this machine's. */
export const HUB_KEYS = ["crew", "crew_models", "crew_budgets", "orchestrator", "gates", "maneuvers", "base_branch"] as const;

const GIT_SUBCOMMANDS = new Set(["rev-parse", "status", "switch", "for-each-ref", "branch", "rev-list", "diff", "log", "merge-base", "symbolic-ref", "remote", "push", "fetch", "worktree"]);
/** git options that run a program, read another repo's config, or write a file (global options such as -c never pass: the subcommand comes first). */
const GIT_BAD_ARG = /^(--config\b|--config-env|--exec-path|--upload-pack|--receive-pack|--ext-diff|--textconv|--output|--git-dir|--work-tree|--namespace|--super-prefix|--exec\b|-o$|--open-files-in-pager)/;
const SAFE_REF = /^[A-Za-z0-9][\w./-]{0,120}$/;
const PROTECTED = new Set(["main", "master", "develop", "trunk", "HEAD"]);

export type HostedShip = Pick<ShipRow, "id" | "path" | "checks" | "isolation"> & { rig?: ShipRow["rig"] };

export async function hostedShips(): Promise<HostedShip[]> {
  return (await readShips()).filter((s) => s.path && existsSync(join(s.path, ".git"))).map((s) => ({ id: s.id, path: s.path, checks: s.checks, isolation: s.isolation, rig: s.rig }));
}

/** Environment for a command the hub runs here: this machine's paths and, for a voyage, its rig (checked; vars from this machine's config). */
export function hostedExecEnv(ship: HostedShip, rig: unknown): Record<string, string> {
  return { FLEET_SHIP_REPO: ship.path, FLEET_AGENTS: ROOT, ...rigEnv(ship.rig ?? null, validRig(rig), ship.id) };
}

/** Copy a ship's rig env files from this machine's store into one of its worktrees here. */
export async function hostedRigEnv(cwd: string, ships?: HostedShip[]): Promise<{ ok: boolean; message: string }> {
  const ship = await shipForFolder(cwd, ships ?? (await hostedShips()));
  if (!ship) return { ok: false, message: "that folder is not a ship repo or worktree on the laptop" };
  if (!ship.rig) return { ok: false, message: `${ship.id} declares no rig on the laptop` };
  if (real(cwd) === real(ship.path)) return { ok: false, message: "rig env goes into a voyage worktree, not the captain's checkout" };
  return copyRigEnv(ship.id, ship.rig, cwd);
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The worktrees of a repo (git worktree list), real paths. */
async function worktreesOf(repo: string): Promise<string[]> {
  const r = await spawnTimed(["git", "worktree", "list", "--porcelain"], { timeoutMs: 15_000, cwd: repo });
  return r.exitCode === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice(9))) : [];
}

/** The ship whose repo or worktree holds `cwd`, or null. */
export async function shipForFolder(cwd: string, ships: HostedShip[], worktrees: (repo: string) => Promise<string[]> = worktreesOf): Promise<HostedShip | null> {
  if (!cwd || !existsSync(cwd)) return null;
  const at = real(cwd);
  for (const s of ships) if (within(at, real(s.path))) return s;
  for (const s of ships) if ((await worktrees(s.path)).some((w) => within(at, w))) return s;
  return null;
}

/** Why the hub may not run `cmd` in `cwd` here, or null when it may. */
export function commandRefusal(cmd: string[], ship: HostedShip | null): string | null {
  if (!ship) return "that folder is not a ship repo or worktree on the laptop";
  const [bin, sub, ...rest] = cmd;
  if (bin === "git") {
    if (!sub || !GIT_SUBCOMMANDS.has(sub)) return `git ${sub ?? ""} is not allowed`;
    if ([sub, ...rest].some((a) => GIT_BAD_ARG.test(a))) return "that git option is not allowed";
    if (sub === "worktree" && rest[0] !== "list") return "only git worktree list";
    if (sub === "push") {
      const [u, remote, branch, ...more] = rest;
      if (u !== "-u" || remote !== "origin" || !branch || more.length || !SAFE_REF.test(branch) || PROTECTED.has(branch)) return "only git push -u origin <voyage branch>";
    }
    return null;
  }
  if (bin === "gh") return sub === "pr" && (rest[0] === "view" || rest[0] === "create") ? null : "only gh pr view and gh pr create";
  if (bin === "treehouse") return sub === "get" || sub === "return" ? null : "only treehouse get and return";
  if (bin === "/bin/zsh" && sub === "-lc" && rest.length === 1) {
    return Object.values(ship.checks).includes(rest[0]!) ? null : "that command is not one of this ship's checks on the laptop";
  }
  return `${bin} is not allowed`;
}

export type LaunchContext = {
  agent: string;
  /** The ship a session guest comes aboard (crewmates name theirs in the agent id). */
  ship?: string;
  /** The hub's merged ship config; only HUB_KEYS are used. */
  config: Record<string, unknown>;
  worktree?: { path: string; branch: string; base: string; leaseId?: string; rig?: unknown } | null;
};

/**
 * Get a hosted crewmate's launch ready: check who it is, then write the
 * ship's config view and the voyage's worktree record where bin/launch reads
 * them (with FLEET_INBOX=fleet/hosted). Returns the environment to launch with, or why not.
 */
export async function prepareHostedLaunch(ctx: LaunchContext, ships?: HostedShip[]): Promise<{ ok: true; env: Record<string, string>; ship: HostedShip } | { ok: false; message: string }> {
  const all = ships ?? (await hostedShips());
  // A session guest (lib/sessions.ts): the flagship's designer or architect, only in a worktree of a ship here.
  const guest = GUEST_OFFICERS.includes(ctx.agent);
  const ship = guest ? all.find((s) => s.id === ctx.ship) : all.filter((s) => ctx.agent.startsWith(`${s.id}-`)).sort((a, b) => b.id.length - a.id.length)[0];
  if (!ship) return { ok: false, message: guest ? `${ctx.ship ?? "that ship"} is not a ship on the laptop` : `${ctx.agent} is not a crewmate of a ship on the laptop` };
  if (guest) {
    if (!ctx.worktree) return { ok: false, message: `${ctx.agent} comes aboard ${ship.id} only for a session, in its worktree` };
  } else {
    const role = ctx.agent.slice(ship.id.length + 1);
    const crew = Array.isArray(ctx.config.crew) ? ctx.config.crew.map(String) : [];
    if (!/^[a-z][a-z0-9_-]*$/.test(role) || !crew.includes(role) || !existsSync(join(ROOT, "agents", role))) return { ok: false, message: `${role} is not aboard ${ship.id}` };
  }
  const inbox = hostedInbox();
  const own = readShipConfig(ship.id) ?? {};
  const fromHub = Object.fromEntries(HUB_KEYS.filter((k) => k in ctx.config).map((k) => [k, ctx.config[k]]));
  await mkdir(join(inbox, ".node", "ships"), { recursive: true });
  await writeFile(join(inbox, ".node", "ships", `${ship.id}.json`), JSON.stringify({ ...own, ...fromHub, id: ship.id, path: ship.path }, null, 2));
  const record = join(inbox, "ships", ship.id, "worktree.json");
  await mkdir(dirname(record), { recursive: true });
  if (ctx.worktree) {
    if ((await shipForFolder(ctx.worktree.path, [ship]))?.id !== ship.id || real(ctx.worktree.path) === real(ship.path)) return { ok: false, message: `${ctx.worktree.path} is not a worktree of ${ship.id} on the laptop` };
    await writeFile(record, JSON.stringify({ ship: ship.id, ...ctx.worktree, gitDir: join(real(ship.path), ".git"), host: "laptop", ...(guest ? { guest: ctx.agent } : {}) }, null, 2));
  } else {
    await writeFile(record, "{}");
  }
  // A rigged voyage: the crew's shells reach the voyage's own stack (lib/rig.ts).
  const rec = validRig(ctx.worktree?.rig);
  const rig = rec ? rigEnv(ship.rig ?? null, rec) : {};
  return { ok: true, env: { FLEET_INBOX: inbox, FLEET_HOSTED: "1", ...rig, ...(guest ? { FLEET_GUEST_SHIP: ship.id } : {}) }, ship };
}

/**
 * Crew memory files (relative to the hosted inbox) a voyage carries between
 * hosts: the ship's and each crewmate's memory notes, and a crewmate's
 * current session id (a fresh one at Set sail).
 */
// Crewmates (<ship>-<role>) and the session guests (designer, architect).
const MEMORY_FILE = /^(ships\/[a-z][a-z0-9_-]*\/memory|[a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*\/memory|(designer|architect)\/memory)\/[a-z][a-z0-9_-]*\.md$/;
const SESSION_FILE = /^([a-z][a-z0-9_-]*-[a-z][a-z0-9_-]*|designer|architect)\/sessions\/current$/;

export const memoryPathOk = (rel: string, text = "") => !rel.includes("..") && (MEMORY_FILE.test(rel) || (SESSION_FILE.test(rel) && /^(dashboard-[\w.-]{1,120}\n?)?$/.test(text)));

/** Write the memory files the hub sends (an empty text removes the file: voyage memory cleared at dock). */
export async function putMemory(files: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  for (const [rel, text] of Object.entries(files)) if (!memoryPathOk(rel, String(text))) return { ok: false, message: `${rel} is not a crew memory file` };
  for (const [rel, text] of Object.entries(files)) {
    const file = join(hostedInbox(), rel);
    if (!text) {
      await rm(file, { force: true });
      continue;
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, String(text).slice(0, 200_000));
  }
  return { ok: true, message: `${Object.keys(files).length} file(s)` };
}

/** Read back a ship's memory and its crewmates' (at dock, or moving the voyage). */
export async function getMemory(ship: string, agents: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const dir of [`ships/${ship}/memory`, ...agents.map((a) => `${a}/memory`)]) {
    let names: string[] = [];
    try {
      names = await readdir(join(hostedInbox(), dir));
    } catch {
      continue;
    }
    for (const n of names) {
      const rel = `${dir}/${n}`;
      if (memoryPathOk(rel)) out[rel] = await readFile(join(hostedInbox(), rel), "utf8");
    }
  }
  return out;
}
