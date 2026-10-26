/**
 * The laptop worker: what the always-on hub borrows from the captain's laptop
 * while it is awake (lib/laptop.ts is the hub's side).
 *
 * - GET  /health      capabilities right now: "tts" (Kokoro is set up), "firstmate" (its TUI answers)
 * - POST /tts         {text, voice, speed} → WAV (lib/voice.ts synthesize, the M2 Max's Kokoro)
 * - POST /firstmate   {text} → typed into Firstmate's TUI (lib/firstmate-chat.ts)
 * - POST /shot        {url, width, height, mobile, wait} → PNG (browser.ts: Chrome here, started
 *                     on demand and stopped when idle), so screenshots use the laptop's memory
 * - /host/*           this laptop as a ship host for voyages sailed here (lib/hosted.ts decides
 *                     what the hub may run; lib/laptop-host.ts is the hub's side):
 *   GET  /host/ships   {ships: [{id, path}]}
 *   POST /host/exec    {cmd, cwd, timeoutMs} → {stdout, stderr, exitCode, timedOut, ms}
 *   POST /host/memory  {put: {relpath: text}} or {ship, agents} → {files}
 *   POST /host/rig-env {cwd} → {ok, message}: a ship's rig env files from this machine's store into a worktree
 *   WS   /host/rpc     a crewmate's pi in RPC mode: first message {start: {agent, config,
 *                     worktree, hubUrl, crewToken}}; then {i} stdin in, {o}/{e} out, {x} exit code
 *   POST /host/helper  {helper, task, urls?, cwd?} → {id}: a helper runs here (lib/helpers.ts),
 *                     with no tools; GET /host/helper/<id> → {done, result} (polled, so a
 *                     long job outlives any one request)
 *
 * Listens on 127.0.0.1 only; Tailscale Serve publishes it to the tailnet
 * (bin/laptop-worker --install). Every request needs the shared token
 * (secret "laptop-worker-token", the Keychain here, a 0600 file on the hub).
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeBin, Gate, gatedShot, MAX_JOBS, shotResponse } from "./browser.ts";
import { firstmateTuiReachable, sendToFirstmateTui } from "./lib/firstmate-chat.ts";
import { agentKeyEnv } from "./lib/fleet-env.ts";
import { freeSlot, helperDefs, runHelperHere, shotUrls, takeShots, takeSlot, type HelperResult } from "./lib/helpers.ts";
import { commandRefusal, getMemory, hostedExecEnv, hostedRigEnv, hostedShips, prepareHostedLaunch, putMemory, shipForFolder, type LaunchContext } from "./lib/hosted.ts";
import { ROOT } from "./lib/paths.ts";
import { spawnTimed } from "./lib/proc.ts";
import { readSecret } from "./lib/secret-store.ts";
import { synthesize, ttsAvailable } from "./lib/voice.ts";

const PORT = Number(process.env.FLEET_WORKER_PORT) || 8790;

/** Constant-time check of "Bearer <token>" against the stored token; no token stored means no access. */
export function authorized(header: string | null, token: string): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function capabilities(): Promise<string[]> {
  const caps: string[] = [];
  if (ttsAvailable()) caps.push("tts");
  if ((await firstmateTuiReachable().catch(() => ({ ok: false }))).ok) caps.push("firstmate");
  if (chromeBin()) caps.push("browser");
  caps.push("ship-host", "helpers");
  return caps;
}

/** Helper jobs the hub started here: kept until the hub reads the result, or 15 minutes after. */
const helperJobs = new Map<string, { done: boolean; result?: HelperResult; at: number }>();

/** POST /host/helper: one helper job here (lib/helpers.ts). Definitions are this laptop's own; the hub sends only the job. */
async function hostHelper(req: Request, shots: Gate): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { helper?: unknown; task?: unknown; urls?: unknown; cwd?: unknown };
  const def = (await helperDefs()).find((d) => d.name === String(b.helper ?? ""));
  if (!def || !def.hosts.includes("laptop")) return Response.json({ ok: false, message: `no helper ${String(b.helper)} runs on the laptop` }, { status: 400 });
  const task = String(b.task ?? "").slice(0, 20_000);
  if (task.trim().length < 5) return Response.json({ ok: false, message: "a task" }, { status: 400 });
  const urls = def.input === "shots" ? shotUrls(b.urls) : [];
  if (typeof urls === "string") return Response.json({ ok: false, message: urls }, { status: 400 });
  // A check helper reads in the voyage's worktree: only a ship's folder here (lib/hosted.ts).
  let cwd = "";
  if (def.input === "check") {
    cwd = String(b.cwd ?? "");
    if (!(await shipForFolder(cwd, await hostedShips()))) return Response.json({ ok: false, message: "the laptop refused: not a ship's repo or worktree" }, { status: 400 });
  }
  if (!takeSlot("laptop")) return Response.json({ ok: false, message: "all the laptop's helper slots are busy" }, { status: 429 });
  for (const [id, j] of helperJobs) if (Date.now() - j.at > 15 * 60_000) helperJobs.delete(id);
  const id = randomUUID();
  helperJobs.set(id, { done: false, at: Date.now() });
  void (async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-helper-"));
    let result: HelperResult;
    try {
      const files = urls.length ? await takeShots(urls, dir, (o) => gatedShot(shots, o)) : [];
      result = await runHelperHere(def, task, { cwd: cwd || dir, files, host: "laptop", env: { ...process.env, ...(await agentKeyEnv()) } });
    } catch (e) {
      result = { ok: false, text: `${def.name} could not start: ${e instanceof Error ? e.message : String(e)}`, cost: 0, ms: 0, model: def.model, stopped: "error" };
    } finally {
      freeSlot("laptop");
      await rm(dir, { recursive: true, force: true });
    }
    helperJobs.set(id, { done: true, result, at: Date.now() });
  })();
  return Response.json({ ok: true, id });
}

/** POST /host/exec: a command the hub may run here (lib/hosted.ts), in a ship's repo or worktree. */
async function hostExec(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { cmd?: unknown; cwd?: unknown; timeoutMs?: unknown; rig?: unknown };
  const cmd = Array.isArray(b.cmd) ? b.cmd.map(String) : [];
  const cwd = String(b.cwd ?? "");
  const ship = await shipForFolder(cwd, await hostedShips());
  const refusal = commandRefusal(cmd, ship);
  if (refusal) return Response.json({ stdout: "", stderr: `the laptop refused: ${refusal}`, exitCode: 126, timedOut: false, ms: 0 });
  const timeoutMs = Math.min(3_600_000, Math.max(1000, Number(b.timeoutMs) || 60_000));
  // A check runs as in a terminal here (the captain's PATH via the login shell), marked as CI;
  // FLEET_SHIP_REPO is the captain's checkout here, as on the hub (lib/ship-checks.ts), plus the voyage's rig.
  return Response.json(await spawnTimed(cmd, { timeoutMs, cwd, env: { ...process.env, CI: "1", ...hostedExecEnv(ship!, b.rig) } }));
}

/** One hosted crewmate's link: its process, and stdin that arrived while it was starting. */
type RpcSocket = { proc?: import("bun").Subprocess<"pipe", "pipe", "pipe">; started?: boolean; early?: string[]; closed?: boolean };

/** Hosted crewmates running now: stopped with the worker (launchd restarts it), never left behind. */
const hosted = new Set<import("bun").Subprocess>();
process.on("exit", () => {
  for (const p of hosted) p.kill("SIGKILL");
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

/** WS /host/rpc: start a hosted crewmate and bridge its RPC stream to the hub. */
async function rpcMessage(ws: import("bun").ServerWebSocket<RpcSocket>, raw: string | Buffer): Promise<void> {
  let m: { start?: LaunchContext & { hubUrl?: string; crewToken?: string }; i?: string; k?: string };
  try {
    m = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (m.start && !ws.data.started) {
    ws.data.started = true;
    const s = m.start;
    const ready = await prepareHostedLaunch({ agent: String(s.agent ?? ""), ship: typeof s.ship === "string" ? s.ship : undefined, config: (s.config ?? {}) as Record<string, unknown>, worktree: s.worktree ?? null });
    if (!ready.ok || !/^https?:\/\//.test(String(s.hubUrl ?? "")) || !s.crewToken) {
      ws.send(JSON.stringify({ e: `the laptop refused the launch: ${ready.ok ? "no hub address or crew token" : ready.message}\n` }));
      ws.send(JSON.stringify({ x: 1 }));
      ws.close();
      return;
    }
    // The laptop's own keys (its service account), never the hub's.
    const keys = await agentKeyEnv().catch(() => ({}));
    const proc = Bun.spawn(["python3", `${ROOT}/bin/launch`, "rpc", String(s.agent)], {
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...keys, ...ready.env, FLEET_DASHBOARD_URL: String(s.hubUrl).replace(/\/+$/, ""), FLEET_CREW_TOKEN: String(s.crewToken) },
    });
    ws.data.proc = proc;
    hosted.add(proc);
    if (ws.data.closed) proc.kill("SIGTERM");
    for (const chunk of ws.data.early?.splice(0) ?? []) proc.stdin.write(chunk);
    proc.stdin.flush();
    const pipe = async (stream: ReadableStream<Uint8Array>, key: "o" | "e") => {
      const dec = new TextDecoder();
      for await (const chunk of stream) ws.send(JSON.stringify({ [key]: dec.decode(chunk, { stream: true }) }));
    };
    void Promise.all([pipe(proc.stdout, "o"), pipe(proc.stderr, "e")]).catch(() => {});
    void proc.exited.then((code) => {
      hosted.delete(proc);
      try {
        ws.send(JSON.stringify({ x: code }));
        ws.close();
      } catch {
        /* the hub is gone */
      }
    });
    return;
  }
  const proc = ws.data.proc;
  if (!proc) {
    // Still starting (keys, config): keep what the hub sent for the new process.
    if (typeof m.i === "string") (ws.data.early ??= []).push(m.i);
    return;
  }
  if (typeof m.i === "string") {
    proc.stdin.write(m.i);
    proc.stdin.flush();
  }
  if (m.k === "SIGTERM" || m.k === "SIGKILL") proc.kill(m.k);
}

if (import.meta.main) {
  let token = await readSecret("laptop-worker-token");
  const shots = new Gate(MAX_JOBS);
  Bun.serve<RpcSocket>({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    async fetch(req, server) {
      if (!token) token = await readSecret("laptop-worker-token");
      if (!authorized(req.headers.get("authorization"), token)) return new Response("unauthorized", { status: 401 });
      const path = new URL(req.url).pathname;
      if (path === "/health" && req.method === "GET") return Response.json({ ok: true, capabilities: await capabilities(), host: "laptop" });
      if (path === "/tts" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { text?: string; voice?: string; speed?: number };
        const text = String(b.text ?? "").slice(0, 2000);
        if (!text.trim() || !/^[ab][fm]_[a-z]+$/.test(String(b.voice))) return Response.json({ ok: false, message: "text and a Kokoro voice id" }, { status: 400 });
        try {
          return new Response(new Uint8Array(await synthesize(text, String(b.voice), Number(b.speed) || 1.0)), { headers: { "Content-Type": "audio/wav" } });
        } catch (e) {
          return Response.json({ ok: false, message: e instanceof Error ? e.message : "speech failed" }, { status: 503 });
        }
      }
      if (path === "/firstmate" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { text?: string };
        const text = String(b.text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        if (!text) return Response.json({ ok: false, detail: "no text" }, { status: 400 });
        const r = await sendToFirstmateTui(text);
        return Response.json({ ok: r.ok, detail: r.ok ? "fm-send" : (r.stderr || r.stdout || "TUI not reachable").trim().slice(0, 400) });
      }
      if (path === "/shot" && req.method === "POST") return shotResponse(req, shots);
      if (path === "/host/ships" && req.method === "GET") return Response.json({ ships: (await hostedShips()).map((s) => ({ id: s.id, path: s.path })) });
      if (path === "/host/exec" && req.method === "POST") return hostExec(req);
      if (path === "/host/rig-env" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { cwd?: unknown };
        return Response.json(await hostedRigEnv(String(b.cwd ?? "")));
      }
      if (path === "/host/memory" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as { put?: Record<string, string>; ship?: string; agents?: string[] };
        if (b.put) return Response.json(await putMemory(b.put));
        return Response.json({ files: await getMemory(String(b.ship ?? ""), Array.isArray(b.agents) ? b.agents.map(String) : []) });
      }
      if (path === "/host/helper" && req.method === "POST") return hostHelper(req, shots);
      const job = path.match(/^\/host\/helper\/([0-9a-f-]{36})$/);
      if (job && req.method === "GET") {
        const j = helperJobs.get(job[1]!);
        if (!j) return Response.json({ done: true, result: { ok: false, text: "the laptop has no such helper job (the worker restarted?)", cost: 0, ms: 0, model: "", stopped: "error" } });
        if (j.done) helperJobs.delete(job[1]!);
        return Response.json({ done: j.done, result: j.result });
      }
      if (path === "/host/rpc" && server.upgrade(req, { data: {} as RpcSocket })) return undefined;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      // A hosted crewmate's stream stays open for hours; the hub pings by sending nothing, so no idle limit.
      idleTimeout: 0,
      message: (ws: import("bun").ServerWebSocket<RpcSocket>, raw) => void rpcMessage(ws, raw),
      // The hub went away (closed, or the laptop slept): stop the crewmate; its session resumes on the next launch.
      close(ws: import("bun").ServerWebSocket<RpcSocket>) {
        ws.data.closed = true;
        const proc = ws.data.proc;
        if (!proc) return;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5000);
      },
    },
  });
  console.log(`laptop worker http://127.0.0.1:${PORT}`);
}
