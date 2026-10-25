import { existsSync } from "node:fs";
import { join } from "node:path";
import { laptopHost } from "./laptop-host.ts";
import { ROOT } from "./paths.ts";
import { spawnTimed, type SpawnResult } from "./proc.ts";

/**
 * The machine that holds a voyage's repo (vault plan
 * fleet/plans/feature/remote-ship-hosts, H1). Everything a voyage does in the
 * repo goes through a ship host: leasing and returning the worktree, git state
 * for gates and the dock review, checks, the dock's push and pull request, and
 * starting a crewmate's pi with its RPC stream. Backends: **local** (the
 * machine the node runs on) and **laptop** (lib/laptop-host.ts, H2); an
 * exe.dev VM per voyage (H3) plugs in behind the same interface, and so can
 * short-lived helper agents that run where the heavy tools are.
 *
 * Paths are the host's own: a worktree path means a folder on that host.
 */

export type HostKind = "local" | "laptop" | "vm";

export type ExecOpts = { timeoutMs: number; cwd?: string; env?: Record<string, string | undefined>; stdin?: string };

/** A crewmate's pi in RPC mode: JSON lines in on stdin, events out on stdout. */
export type RpcProc = {
  pid?: number;
  stdin: { write(chunk: string): unknown; flush(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
};

/** What a host needs to start a crewmate: its ship and the voyage's worktree there. */
export type LaunchCtx = { ship?: string; worktree?: { path: string; branch: string; base: string; leaseId?: string; rig?: { project: string; port: number; slug: string } } | null };

export interface ShipHost {
  kind: HostKind;
  /** For messages and the voyage record: "this machine", "the laptop", a VM name. */
  label: string;
  /** Run a command to completion with a hard time limit. */
  exec(cmd: string[], opts: ExecOpts): Promise<SpawnResult>;
  /** Whether a folder on this host is a git checkout (a .git folder or a linked worktree's .git file). */
  hasRepo(path: string): Promise<boolean>;
  /** The ship's repo on this host (paths differ between machines); "" when it has none. */
  repoPath(ship: { id: string; path: string }): Promise<string>;
  /** Start `bin/launch rpc <agent>` on this host with the given environment added. */
  launchRpc(agentId: string, env: Record<string, string>, ctx: LaunchCtx): RpcProc;
  /** A remote host keeps crew memory itself: the hub sends it at voyage start (relative paths under the inbox)... */
  putMemory?(files: Record<string, string>): Promise<void>;
  /** ...and reads it back at dock or when the voyage moves. */
  getMemory?(ship: string, agents: string[]): Promise<Record<string, string>>;
  /** Copy the ship's rig env files from this host's own store into a worktree here (lib/rig.ts); local hosts copy directly. */
  copyRigEnv?(shipId: string, cwd: string): Promise<{ ok: boolean; message: string }>;
  /** Whether a new voyage may sail here now. */
  available(): Promise<boolean>;
}

export const localHost: ShipHost = {
  kind: "local",
  label: "this machine",
  exec: (cmd, opts) => spawnTimed(cmd, opts),
  hasRepo: async (path) => Boolean(path) && existsSync(join(path, ".git")),
  repoPath: async (ship) => ship.path,
  available: async () => true,
  launchRpc(agentId, env, _ctx) {
    const proc = Bun.spawn(["python3", join(ROOT, "bin/launch"), "rpc", agentId], {
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    return {
      pid: proc.pid,
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: (signal) => proc.kill(signal),
    };
  },
};

const defaults = (): Partial<Record<HostKind, ShipHost>> => ({ local: localHost, laptop: laptopHost });
let backends = defaults();

/** Replace a backend (tests: a fake). Passing null restores the default. */
export function setShipHost(kind: HostKind, host: ShipHost | null): void {
  if (host) backends[kind] = host;
  else backends = { ...backends, [kind]: defaults()[kind] };
}

/** The backend for a host name; none (records from before hosts) is the local machine. */
export function shipHost(kind: string | undefined): ShipHost {
  return backends[(kind ?? "local") as HostKind] ?? backends.local!;
}

/** Hosts a new voyage can sail on right now (the "Sail on" choice). */
export async function availableHosts(): Promise<HostKind[]> {
  const out: HostKind[] = [];
  for (const kind of ["local", "laptop", "vm"] as HostKind[]) if (backends[kind] && (await backends[kind]!.available())) out.push(kind);
  return out;
}

/** git on a host: ok when it exited 0 in time, with its output (stdout, else stderr) trimmed. */
export async function hostGit(host: ShipHost, cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string }> {
  const r = await host.exec(["git", ...args], { timeoutMs, cwd });
  return { ok: !r.timedOut && r.exitCode === 0, out: (r.stdout || r.stderr).trim() };
}

/** The (cmd, cwd) → {code, out} runner the dock delivery takes, on a host. */
export function hostRunner(host: ShipHost, timeoutMs = 120_000): (cmd: string[], cwd: string) => Promise<{ code: number; out: string }> {
  return async (cmd, cwd) => {
    const r = await host.exec(cmd, { timeoutMs, cwd });
    return { code: r.exitCode, out: `${r.stdout}\n${r.stderr}`.trim() };
  };
}
