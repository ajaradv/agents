import { readShipConfig } from "./ship-config.ts";
import type { SpawnResult } from "./proc.ts";
import type { HostKind, LaunchCtx, RpcProc, ShipHost } from "./ship-host.ts";

/** The hub's node as crews on a worker reach it (Tailscale Serve; FLEET_NODE_PUBLIC_URL in services.env). */
export const nodePublicUrl = () => (process.env.FLEET_NODE_PUBLIC_URL ?? "").replace(/\/+$/, "");

/** How to reach one worker: its base URL, the headers that authenticate to it, and whether a voyage may sail there now. */
export type WorkerConfig = {
  kind: HostKind;
  label: string;
  url: () => string;
  /** Headers for every request and the WebSocket (the worker token, and a proxy's own token for a VM). */
  auth: () => Promise<Record<string, string>>;
  available: () => Promise<boolean>;
  /** Awaited before every HTTP call and the RPC WebSocket (a paused VM wakes here); a rejection fails the call as an unreachable worker does. */
  before?: () => Promise<void>;
  /** Test seam and the laptop's status cache. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

/** The RPC stream of a crewmate on a worker, over its WebSocket. Exits with LINK_LOST when the link drops (the laptop slept). */
function remoteRpc(cfg: WorkerConfig, agentId: string, crewToken: string, ctx: LaunchCtx): RpcProc {
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
  const connect = (headers: Record<string, string>) => {
    if (stopped) return end(`stopped before ${cfg.label} answered`);
    const url = `${cfg.url().replace(/\/+$/, "").replace(/^http/, "ws")}/host/rpc`;
    // Bun's WebSocket takes headers in its options (the browser's API has none).
    const sock = new WebSocket(url, { headers } as unknown as string[]);
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
      if (sock.readyState !== WebSocket.OPEN && code === null) err.enqueue(enc.encode(`could not reach the worker on ${cfg.label}\n`));
    };
    sock.onclose = () => end();
  };
  (cfg.before?.() ?? Promise.resolve()).then(
    () => cfg.auth().then(connect, (e) => end(`no token for the worker on ${cfg.label} (${e instanceof Error ? e.message : String(e)})`)),
    (e) => end(`could not reach the worker on ${cfg.label} (${e instanceof Error ? e.message : String(e)})`),
  );

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

/** Exit code of a hosted crewmate whose link to its worker dropped (asleep or offline), not a crash. */
export const LINK_LOST = -1;

/**
 * A ship host that is a worker (dashboard/worker.ts) reached over HTTPS: the
 * captain's laptop through Tailscale Serve, or an exe.dev voyage VM through
 * exe.dev's proxy. The worker decides what it runs from its own config
 * (lib/hosted.ts); this side only asks.
 */
export function workerHost(cfg: WorkerConfig): ShipHost {
  const call = async (path: string, init: RequestInit): Promise<Response> => {
    await cfg.before?.();
    const url = cfg.url();
    if (!url) throw new Error(`no worker configured for ${cfg.label}`);
    const headers = { ...(init.headers as Record<string, string> | undefined), ...(await cfg.auth()) };
    return (cfg.fetch ?? fetch)(`${url.replace(/\/+$/, "")}${path}`, { ...init, headers });
  };
  const post = async <T>(path: string, body: unknown, timeoutMs: number): Promise<T> => {
    const r = await call(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${cfg.label}: HTTP ${r.status}`);
    return (await r.json()) as T;
  };
  const host: ShipHost = {
  kind: cfg.kind,
  label: cfg.label,
  async exec(cmd, opts): Promise<SpawnResult> {
    const t0 = Date.now();
    try {
      // The voyage's rig names only (the laptop checks them and adds its own config's vars).
      const rig = opts.env?.COMPOSE_PROJECT_NAME ? { project: opts.env.COMPOSE_PROJECT_NAME, port: Number(opts.env.FLEET_RIG_PORT), slug: opts.env.FLEET_RIG_SLUG } : undefined;
      return await post<SpawnResult>("/host/exec", { cmd, cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...(rig ? { rig } : {}) }, opts.timeoutMs + 15_000);
    } catch (e) {
      return { stdout: "", stderr: `${cfg.label} is not reachable (${e instanceof Error ? e.message : String(e)})`, exitCode: 125, timedOut: false, ms: Date.now() - t0 };
    }
  },
  async hasRepo(path) {
    return (await host.exec(["git", "rev-parse", "--is-inside-work-tree"], { timeoutMs: 15_000, cwd: path })).exitCode === 0;
  },
  async repoPath(ship) {
    try {
      const r = await call("/host/ships", { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { ships?: { id: string; path: string }[] };
      return j.ships?.find((s) => s.id === ship.id)?.path ?? "";
    } catch {
      return "";
    }
  },
  // Only the crew token goes to a worker: it uses its own model access, never the hub's keys.
  launchRpc: (agentId, env, ctx) => remoteRpc(cfg, agentId, env.FLEET_CREW_TOKEN ?? "", ctx),
  async putMemory(files) {
    await post("/host/memory", { put: files }, 30_000);
  },
  async copyRigEnv(_ship, cwd) {
    return await post<{ ok: boolean; message: string }>("/host/rig-env", { cwd }, 30_000);
  },
  async getMemory(ship, agents) {
    return (await post<{ files: Record<string, string> }>("/host/memory", { ship, agents }, 30_000)).files ?? {};
  },
  available: cfg.available,
  };
  return host;
}
