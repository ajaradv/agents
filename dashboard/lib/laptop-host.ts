import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { laptopCan, laptopFetch, laptopToken } from "./laptop.ts";
import { nodeStateDir } from "./paths.ts";
import type { SpawnResult } from "./proc.ts";
import { readShipConfig } from "./ship-config.ts";
import type { LaunchCtx, RpcProc, ShipHost } from "./ship-host.ts";

/**
 * The captain's laptop as a ship host (vault plan
 * fleet/plans/feature/remote-ship-hosts, H2): a voyage sailed "on the laptop"
 * keeps its worktree there, runs its checks and its crew's pi there (Gondolin
 * works on macOS), and reports to the hub's node like any crew. The laptop
 * side is dashboard/worker.ts with lib/hosted.ts deciding what it accepts.
 *
 * The captain directs it from the Harbor: **Laptop voyages** on means ships
 * may sail on the laptop while it is awake; off (closing it for the day) means
 * new voyages sail on the hub, and open laptop voyages can be moved to the hub.
 */

const statePath = () => join(nodeStateDir(), "laptop-voyages.json");

export type LaptopVoyages = { on: boolean; at?: string };

export function laptopVoyages(): LaptopVoyages {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as LaptopVoyages;
    return { on: j.on === true, at: j.at };
  } catch {
    return { on: false };
  }
}

export function setLaptopVoyages(on: boolean): LaptopVoyages {
  const s = { on, at: new Date().toISOString() };
  mkdirSync(dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s) + "\n");
  return s;
}

/** The hub's node as crews on the laptop reach it (Tailscale Serve; FLEET_NODE_PUBLIC_URL in services.env). */
export const nodePublicUrl = () => (process.env.FLEET_NODE_PUBLIC_URL ?? "").replace(/\/+$/, "");

/** Can a voyage sail on the laptop right now: the captain allows it, the worker is up, the node is reachable. */
export async function laptopSailable(): Promise<{ ok: boolean; why: string }> {
  if (!laptopVoyages().on) return { ok: false, why: "laptop voyages are off in the Harbor" };
  if (!nodePublicUrl()) return { ok: false, why: "the hub's node has no tailnet address (FLEET_NODE_PUBLIC_URL)" };
  if (!(await laptopCan("ship-host"))) return { ok: false, why: "the laptop is not available" };
  return { ok: true, why: "" };
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const r = await laptopFetch(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`laptop: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** The RPC stream of a crewmate on the laptop, over the worker's WebSocket. Exits with LINK_LOST when the link drops (the laptop slept). */
function remoteRpc(agentId: string, crewToken: string, ctx: LaunchCtx): RpcProc {
  const enc = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
  const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) });
  let settle!: (c: number | null) => void;
  const exited = new Promise<number | null>((r) => (settle = r));
  let ws: WebSocket | null = null;
  let code: number | null = null;
  let stopped = false;
  let ended = false;
  const queue: string[] = [];
  let pending = "";

  const end = (why?: string) => {
    if (ended) return;
    ended = true;
    if (why) err.enqueue(enc.encode(`${why}\n`));
    out.close();
    err.close();
    settle(code ?? LINK_LOST);
  };
  const send = (m: unknown) => {
    const line = JSON.stringify(m);
    if (ws?.readyState === WebSocket.OPEN) ws.send(line);
    else queue.push(line);
  };
  const connect = (token: string) => {
    if (stopped) return end("stopped before the laptop answered");
    const url = `${(process.env.FLEET_LAPTOP_URL ?? "").replace(/\/+$/, "").replace(/^http/, "ws")}/host/rpc`;
    // Bun's WebSocket takes headers in its options (the browser's API has none).
    const sock = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
    ws = sock;
    sock.onopen = () => {
      const w = ctx.worktree;
      sock.send(JSON.stringify({ start: { agent: agentId, ship: ctx.ship, config: readShipConfig(ctx.ship ?? "") ?? {}, worktree: w ? { path: w.path, branch: w.branch, base: w.base, leaseId: w.leaseId, ...(w.rig ? { rig: { project: w.rig.project, port: w.rig.port, slug: w.rig.slug } } : {}) } : null, hubUrl: nodePublicUrl(), crewToken } }));
      for (const line of queue.splice(0)) sock.send(line);
    };
    sock.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { o?: string; e?: string; x?: number };
      if (m.o) out.enqueue(enc.encode(m.o));
      if (m.e) err.enqueue(enc.encode(m.e));
      if (typeof m.x === "number") code = m.x;
    };
    sock.onerror = () => {
      if (sock.readyState !== WebSocket.OPEN && code === null) err.enqueue(enc.encode("could not reach the laptop worker\n"));
    };
    sock.onclose = () => end();
  };
  laptopToken().then(connect, (e) => end(`no laptop worker token (${e instanceof Error ? e.message : String(e)})`));

  return {
    stdin: {
      write: (chunk: string) => void (pending += chunk),
      flush: () => {
        if (pending) send({ i: pending });
        pending = "";
      },
    },
    stdout,
    stderr,
    exited,
    kill: (signal = "SIGTERM") => {
      stopped = true;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ k: signal }));
      if (signal === "SIGKILL") ws?.close();
    },
  };
}

/** Exit code of a hosted crewmate whose link to the laptop dropped (asleep or offline), not a crash. */
export const LINK_LOST = -1;

export const laptopHost: ShipHost = {
  kind: "laptop",
  label: "the laptop",
  async exec(cmd, opts): Promise<SpawnResult> {
    const t0 = Date.now();
    try {
      // The voyage's rig names only (the laptop checks them and adds its own config's vars).
      const rig = opts.env?.COMPOSE_PROJECT_NAME ? { project: opts.env.COMPOSE_PROJECT_NAME, port: Number(opts.env.FLEET_RIG_PORT), slug: opts.env.FLEET_RIG_SLUG } : undefined;
      return await post<SpawnResult>("/host/exec", { cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...(rig ? { rig } : {}) }, opts.timeoutMs + 15_000);
    } catch (e) {
      return { stdout: "", stderr: `the laptop is not reachable (${e instanceof Error ? e.message : String(e)})`, exitCode: 125, timedOut: false, ms: Date.now() - t0 };
    }
  },
  async hasRepo(path) {
    return (await laptopHost.exec(["git", "rev-parse", "--is-inside-work-tree"], { timeoutMs: 15_000, cwd: path })).exitCode === 0;
  },
  async repoPath(ship) {
    try {
      const r = await laptopFetch("/host/ships", { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { ships?: { id: string; path: string }[] };
      return j.ships?.find((s) => s.id === ship.id)?.path ?? "";
    } catch {
      return "";
    }
  },
  // Only the crew token goes to the laptop: it uses its own keys, never the hub's.
  launchRpc: (agentId, env, ctx) => remoteRpc(agentId, env.FLEET_CREW_TOKEN ?? "", ctx),
  async putMemory(files) {
    await post("/host/memory", { put: files }, 30_000);
  },
  async copyRigEnv(_ship, cwd) {
    return await post<{ ok: boolean; message: string }>("/host/rig-env", { cwd }, 30_000);
  },
  async getMemory(ship, agents) {
    return (await post<{ files: Record<string, string> }>("/host/memory", { ship, agents }, 30_000)).files ?? {};
  },
  available: async () => (await laptopSailable()).ok,
};
