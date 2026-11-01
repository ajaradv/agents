import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readShips } from "./fleet-layers.ts";
import { ROOT } from "./paths.ts";
import { localHost, type ShipHost } from "./ship-host.ts";
import { voyageHost, voyageWorktree } from "./voyage-worktree.ts";

/**
 * git_read (extensions/crew.ts): the lead's and helmsman's read-only git in the
 * ship's worktree, replacing bash for `git status`, `log`, `diff`, `show`.
 * The crewmate picks an operation and plain arguments; the argv is fixed per
 * operation and never passes through a shell, so it cannot write or run a
 * command (a ref never starts with `-`, a path never leaves the tree).
 */

export const GIT_OPS = ["status", "log", "diff", "show", "branch"] as const;
export type GitOp = (typeof GIT_OPS)[number];
export type GitReadArgs = { op?: unknown; n?: unknown; ref?: unknown; paths?: unknown };

const OUTPUT_MAX = 16_000;
const TIMEOUT_MS = 30_000;
const LOG_DEFAULT = 10;
const LOG_MAX = 50;
const PATHS_MAX = 20;
/** Branch, tag, sha, HEAD~2, origin/main, main..HEAD, HEAD:file. Never an option (no leading dash). */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._\/@{}~^:+=,-]{0,199}$/;

/** Roles that may read git aboard: the lead and the helmsman of this ship. */
export function gitReadAllowed(shipId: string, from: string): boolean {
  return from === `${shipId}-lead` || from === `${shipId}-helmsman`;
}

function badPath(p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return "a path is empty";
  if (p.length > 300 || /[\0\r\n]/.test(p)) return `path ${JSON.stringify(p.slice(0, 40))} is not a plain path`;
  if (p.startsWith("/") || p.startsWith("~") || p.startsWith("-") || p.startsWith(":")) return `path ${p} must be relative to the worktree`;
  if (p.split(/[\\/]/).includes("..")) return `path ${p} leaves the worktree`;
  return null;
}

/** The git arguments for one operation, or why the request is refused. */
export function gitReadArgv(a: GitReadArgs): { ok: true; argv: string[] } | { ok: false; message: string } {
  const op = a.op;
  if (typeof op !== "string" || !(GIT_OPS as readonly string[]).includes(op)) return { ok: false, message: `Unknown op "${String(op)}". Ops: ${GIT_OPS.join(", ")}.` };
  // --no-optional-locks: a read must not touch the index; the ext-diff and textconv switches keep configured programs from running.
  const base = ["git", "--no-pager", "--no-optional-locks"];
  if (op === "status") return { ok: true, argv: [...base, "status", "--short", "--branch"] };
  if (op === "branch") return { ok: true, argv: [...base, "branch", "--show-current"] };
  if (op === "log") {
    const n = a.n === undefined ? LOG_DEFAULT : Number(a.n);
    if (!Number.isInteger(n) || n < 1) return { ok: false, message: `n must be a whole number from 1 to ${LOG_MAX}.` };
    return { ok: true, argv: [...base, "log", "--oneline", "--decorate", "-n", String(Math.min(n, LOG_MAX))] };
  }
  const ref = a.ref === undefined || a.ref === "" ? undefined : a.ref;
  if (ref !== undefined && (typeof ref !== "string" || !REF.test(ref))) return { ok: false, message: `ref ${JSON.stringify(ref)} is not a plain ref (a branch, tag, sha, HEAD~2, or a..b).` };
  const paths = a.paths === undefined ? [] : a.paths;
  if (!Array.isArray(paths) || paths.length > PATHS_MAX) return { ok: false, message: `paths must be a list of at most ${PATHS_MAX} relative paths.` };
  for (const p of paths) {
    const why = badPath(p);
    if (why) return { ok: false, message: `${why}.` };
  }
  const rest = [...(ref ? [ref] : op === "show" ? ["HEAD"] : []), ...(paths.length ? ["--", ...(paths as string[])] : [])];
  return { ok: true, argv: [...base, op, "--no-ext-diff", "--no-textconv", ...rest] };
}

/** Run one validated git argv on a host, in a directory; the output cut to fit an agent's context. */
async function runGit(argv: string[], cwd: string, host: ShipHost): Promise<{ ok: boolean; message: string }> {
  const r = await host.exec(argv, { timeoutMs: TIMEOUT_MS, cwd });
  if (r.timedOut) return { ok: false, message: "git did not answer in time." };
  if (r.unreachable) return { ok: false, message: "The ship's host did not answer." };
  const out = r.stdout.trim();
  if (r.exitCode !== 0) return { ok: false, message: (r.stderr.trim() || out || `git exited ${r.exitCode}`).slice(0, 2000) };
  if (!out) return { ok: true, message: "(no output)" };
  return { ok: true, message: out.length <= OUTPUT_MAX ? out : `${out.slice(0, OUTPUT_MAX)}\n[… ${out.length - OUTPUT_MAX} more characters cut; narrow it with paths or a smaller n …]` };
}

/** Run one read-only git operation for a crewmate, on the voyage's host, in its worktree (else the ship's repo). */
export async function gitRead(shipId: string, from: string, args: GitReadArgs, deps: { host?: ShipHost; cwd?: string } = {}): Promise<{ ok: boolean; message: string }> {
  if (!gitReadAllowed(shipId, from)) return { ok: false, message: "git_read is for the ship's lead and helmsman." };
  const cmd = gitReadArgv(args);
  if (!cmd.ok) return cmd;
  let cwd = deps.cwd ?? voyageWorktree(shipId)?.path;
  if (!cwd) {
    const ship = (await readShips()).find((s) => s.id === shipId);
    if (!ship) return { ok: false, message: `No ship ${shipId}.` };
    cwd = ship.path;
  }
  // The same host as run_check: a VM voyage's worktree exists only on its VM.
  return runGit(cmd.argv, cwd, deps.host ?? voyageHost(shipId) ?? localHost);
}

/**
 * Where a registered ship's repo is on this machine. The registry (fleet/ships/*.yaml) holds the laptop's
 * paths (/Users/<you>/Workspace/<repo>); on the hub the same repo is a clone under its own home
 * (~/Workspace/<repo>). Null when neither exists.
 */
export function localShipPath(path: string, deps: { home?: string; exists?: (p: string) => boolean } = {}): string | null {
  const exists = deps.exists ?? existsSync;
  if (path && exists(path)) return path;
  const m = path.match(/^\/(?:Users|home)\/[^/]+\/(.+)$/);
  if (!m) return null;
  const here = join(deps.home ?? homedir(), m[1]!);
  return exists(here) ? here : null;
}

const FRESHEN_EVERY_MS = 10 * 60_000;
const freshened = new Map<string, number>();

/**
 * Bring a read-only clone up to date before the Architect reads it: fetch at most every 10 minutes, then
 * fast-forward the checked-out branch when the clone is clean. The fleet's own checkout (ROOT) is only
 * fetched: on the hub it is the live code, which only a deploy moves. Returns a note when the fetch failed.
 */
export async function freshenClone(cwd: string, host: ShipHost, deps: { now?: number; root?: string } = {}): Promise<string> {
  const now = deps.now ?? Date.now();
  const last = freshened.get(cwd);
  if (last !== undefined && now - last < FRESHEN_EVERY_MS) return "";
  freshened.set(cwd, now);
  const git = (args: string[]) => host.exec(["git", "--no-pager", ...args], { timeoutMs: 20_000, cwd });
  const fetched = await git(["fetch", "--quiet", "origin"]);
  if (fetched.exitCode !== 0 || fetched.timedOut || fetched.unreachable) {
    freshened.delete(cwd);
    return `(fetch failed: ${(fetched.stderr.trim() || "no answer").slice(0, 160)}; this is the last fetched state)\n`;
  }
  if (resolve(cwd) === resolve(deps.root ?? ROOT)) return "";
  const dirty = await git(["status", "--porcelain"]);
  if (dirty.exitCode === 0 && !dirty.stdout.trim()) await git(["merge", "--ff-only", "--quiet", "@{upstream}"]);
  return "";
}

/** The Architect's git_read (extensions/decisions.ts): any registered ship's repo, not a voyage worktree. */
export async function architectGitRead(from: string, args: GitReadArgs & { ship?: unknown }, deps: { host?: ShipHost; cwd?: string } = {}): Promise<{ ok: boolean; message: string }> {
  if (from !== "architect") return { ok: false, message: "git_read here is the architect's." };
  if (typeof args.ship !== "string" || !args.ship) return { ok: false, message: "ship is required (a ship id; fleet is this repo)." };
  const cmd = gitReadArgv(args);
  if (!cmd.ok) return cmd;
  const host = deps.host ?? localHost;
  let cwd = deps.cwd;
  let note = "";
  if (!cwd) {
    const ship = (await readShips()).find((s) => s.id === args.ship);
    if (!ship) return { ok: false, message: `No ship ${args.ship}.` };
    const here = localShipPath(ship.path);
    if (!here) return { ok: false, message: `${args.ship}'s repo is not on this machine (${ship.path}, or the same path under ${homedir()}).` };
    cwd = here;
    note = await freshenClone(cwd, host);
  }
  const r = await runGit(cmd.argv, cwd, host);
  return note && r.ok ? { ...r, message: note + r.message } : r;
}
