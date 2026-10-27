import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { readShips, type ShipRow } from "./fleet-layers.ts";
import { enqueue, flush, pendingCount, type OutboxEvent } from "./outbox.ts";
import { nodeStateDir, ROOT } from "./paths.ts";
import { checkVerdict, spawnTimed, type SpawnResult } from "./proc.ts";
import { readSecret, writeSecret } from "./secret-store.ts";
import { readShipConfig } from "./ship-config.ts";
import { copyRigEnv, rigEnv, rigStore, validRig } from "./rig.ts";
import { validEventKey } from "./ulid.ts";
import { INGEST_SOURCE } from "./worker-host.ts";

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
  return { FLEET_SHIP_REPO: ship.path, FLEET_AGENTS: ROOT, ...rigEnv(ship.rig ?? null, validRig(rig), ship.id), ...workerDockerEnv() };
}

/**
 * Docker for what the worker runs (rigs, checks, crew shells). Docker
 * Desktop's credential helper (credsStore "desktop") hangs when the worker, a
 * background bun under launchd, is the process responsible for it (macOS waits
 * on an invisible privacy prompt), so every image pull and build metadata
 * lookup timed out ("DeadlineExceeded"). The worker gets its own DOCKER_CONFIG:
 * the captain's config without the credential helper (public images pull
 * anonymously), with links to their CLI plugins, contexts, and builders.
 */
export function workerDockerEnv(home = homedir(), dir = join(ROOT, "fleet", "home", "docker"), platform: string = process.platform): Record<string, string> {
  if (platform !== "darwin") return {};
  const src = join(home, ".docker");
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(readFileSync(join(src, "config.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (!cfg.credsStore && !cfg.credHelpers) return {};
  try {
    mkdirSync(dir, { recursive: true });
    const { credsStore: _s, credHelpers: _h, ...rest } = cfg;
    writeFileSync(join(dir, "config.json"), JSON.stringify(rest, null, 2) + "\n");
    for (const name of readdirSync(src)) {
      if (name === "config.json" || existsSync(join(dir, name))) continue;
      symlinkSync(join(src, name), join(dir, name));
    }
    return { DOCKER_CONFIG: dir };
  } catch {
    return {};
  }
}

/** Copy a ship's rig env files from this machine's store into one of its worktrees here. */
export async function hostedRigEnv(cwd: string, ships?: HostedShip[]): Promise<{ ok: boolean; message: string }> {
  const ship = await shipForFolder(cwd, ships ?? (await hostedShips()));
  if (!ship) return { ok: false, message: "that folder is not a ship repo or worktree on the laptop" };
  if (!ship.rig) return { ok: false, message: `${ship.id} declares no rig on the laptop` };
  if (real(cwd) === real(ship.path)) return { ok: false, message: "rig env goes into a voyage worktree, not the captain's checkout" };
  return copyRigEnv(ship.id, ship.rig, cwd);
}

export const ENV_STORE_LIMITS = { files: 50, bytes: 256 * 1024 } as const;

/** Why the hub may not put these files in a ship's env store here, or null. Never production files, macOS `._*` files, or paths that leave the store. */
export function envStoreRefusal(shipId: string, files: unknown, ships: Pick<HostedShip, "id">[]): string | null {
  if (!ships.some((s) => s.id === shipId)) return `${shipId} is not a ship on this machine`;
  if (!files || typeof files !== "object" || Array.isArray(files)) return "files must be an object of path to content";
  const entries = Object.entries(files);
  if (!entries.length) return "no files";
  if (entries.length > ENV_STORE_LIMITS.files) return `more than ${ENV_STORE_LIMITS.files} files`;
  let bytes = 0;
  for (const [rel, text] of entries) {
    if (typeof text !== "string") return `${rel}: content must be text`;
    bytes += Buffer.byteLength(text);
    const parts = rel.split("/");
    if (!rel || rel.startsWith("/") || rel.includes("\0") || parts.some((x) => x === ".." || x === "." || x === "")) return `${rel}: not a relative path inside the store`;
    if (parts.some((x) => x.startsWith("._"))) return `${rel}: macOS metadata files are not stored`;
    if (/production/i.test(rel)) return `${rel}: production files are never stored here`;
  }
  return bytes > ENV_STORE_LIMITS.bytes ? `more than ${ENV_STORE_LIMITS.bytes / 1024} KB in all` : null;
}

/** Write the files the hub sends into this machine's rig env store for a ship (dirs 0700, files 0600, each replaced atomically). */
export async function putEnvStore(shipId: string, files: unknown, ships?: HostedShip[]): Promise<{ ok: boolean; message: string; written: number }> {
  const refusal = envStoreRefusal(shipId, files, ships ?? (await hostedShips()));
  if (refusal) return { ok: false, message: refusal, written: 0 };
  const root = rigStore(shipId);
  let written = 0;
  for (const [rel, text] of Object.entries(files as Record<string, string>)) {
    const file = join(root, rel);
    // Every directory from the store down is ours to lock: mkdir's mode only applies to the ones it makes.
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    for (let d = dirname(file); d.length >= root.length; d = dirname(d)) await chmod(d, 0o700);
    await writeFile(`${file}.tmp`, text, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    written++;
  }
  return { ok: true, message: `${written} file(s) stored for ${shipId}`, written };
}

/** On a Linux VM containers run as root, so a check that mounts the worktree leaves root-owned files behind: chown the folder back after a ship check. */
export function chownAfter(cmd: string[], kind: string | undefined): boolean {
  const [bin, flag, script, ...more] = cmd;
  return kind === "vm" && (bin === "/bin/bash" || bin === "/bin/zsh") && flag === "-lc" && typeof script === "string" && !more.length;
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
  // A check in a login shell: zsh from the hub to the laptop, bash to a Linux VM (lib/ship-checks.ts checkShell).
  if ((bin === "/bin/zsh" || bin === "/bin/bash") && sub === "-lc" && rest.length === 1) {
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
  return { ok: true, env: { FLEET_INBOX: inbox, FLEET_HOSTED: "1", ...rig, ...workerDockerEnv(), ...(guest ? { FLEET_GUEST_SHIP: ship.id } : {}) }, ship };
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

/**
 * The outbox (lib/outbox.ts): this machine's records for the hub. The hub says
 * where to send them and with which token (POST /host/ingest-config; the token
 * is the secret ingest-token here, the rest a small state file), and the
 * worker sends on a timer and soon after something is queued.
 */
export type IngestConfig = { url: string; token: string; source: string };
const ingestFile = () => join(nodeStateDir(), "ingest.json");

/** Keep the hub's ingest settings. The token is stored first: without it the file would point nowhere. */
export async function setIngestConfig(b: unknown, write: (name: string, value: string) => Promise<boolean> = writeSecret): Promise<{ ok: boolean; message: string }> {
  const { url, token, source } = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
  if (typeof url !== "string" || !/^https?:\/\/[^\s/]+(\/[^\s]*)?\/v1\/ingest$/.test(url)) return { ok: false, message: "url must be the node's /v1/ingest address" };
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return { ok: false, message: "a token of 32 to 256 letters, digits, - or _" };
  if (typeof source !== "string" || !INGEST_SOURCE.test(source)) return { ok: false, message: "source must be laptop or a VM name" };
  if (!(await write("ingest-token", token))) return { ok: false, message: "could not store the token" };
  mkdirSync(dirname(ingestFile()), { recursive: true });
  writeFileSync(ingestFile(), JSON.stringify({ url, source }) + "\n");
  return { ok: true, message: "ingest settings stored" };
}

export async function readIngestConfig(read: (name: string) => Promise<string> = readSecret): Promise<IngestConfig | null> {
  try {
    const f = JSON.parse(readFileSync(ingestFile(), "utf8")) as { url?: string; source?: string };
    const token = await read("ingest-token");
    return f.url && f.source && token ? { url: f.url, source: f.source, token } : null;
  } catch {
    return null;
  }
}

/**
 * The record of a check the hub asked for, to queue before answering: the
 * hub's `run` descriptor says which key and whose check; the result is what
 * ran here. Null when there is nothing to record (no descriptor, a bad one,
 * or one for another ship than the folder's).
 */
export function runEvent(run: unknown, ship: Pick<HostedShip, "id">, res: Pick<SpawnResult, "exitCode" | "timedOut" | "ms">, now = new Date()): OutboxEvent | null {
  const r = (run && typeof run === "object" ? run : {}) as Record<string, unknown>;
  if (!validEventKey(r.event_key) || r.kind !== "check" || r.ship !== ship.id) return null;
  if (typeof r.agent !== "string" || !r.agent || typeof r.name !== "string" || !r.name) return null;
  return {
    table: "runs",
    event_key: r.event_key,
    data: { ship: ship.id, agent: r.agent, kind: "check", name: r.name, ok: !res.timedOut && res.exitCode === 0, ms: res.ms, detail: checkVerdict(res, Math.round(res.ms / 1000)), commit_sha: typeof r.commit === "string" ? r.commit : "", dirty: r.dirty === true, ts: now.toISOString() },
  };
}

/** Queue a check's record; the answer to the hub never waits on or fails for it. */
export function queueRun(run: unknown, ship: Pick<HostedShip, "id">, res: Pick<SpawnResult, "exitCode" | "timedOut" | "ms">): boolean {
  try {
    const e = runEvent(run, ship, res);
    return e ? enqueue(e) : false;
  } catch (e) {
    console.error("[outbox]", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Sends the outbox every `everyMs` while something is pending, and `debounceMs` after a kick. */
export function ingestLoop(deps: { config?: () => Promise<IngestConfig | null>; send?: typeof flush; pending?: () => number; everyMs?: number; debounceMs?: number } = {}): { start(): void; kick(): void; stop(): void; once(): Promise<void> } {
  const config = deps.config ?? readIngestConfig;
  const send = deps.send ?? flush;
  const pending = deps.pending ?? pendingCount;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  const once = async () => {
    if (busy) return;
    busy = true;
    try {
      const c = await config();
      if (c && pending() > 0) await send(c);
    } catch (e) {
      console.error("[outbox]", e instanceof Error ? e.message : e);
    } finally {
      busy = false;
    }
  };
  return {
    once,
    start() {
      timer ??= setInterval(() => void once(), deps.everyMs ?? 30_000);
    },
    kick() {
      soon ??= setTimeout(() => {
        soon = null;
        void once();
      }, deps.debounceMs ?? 2000);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      timer = soon = null;
    },
  };
}
