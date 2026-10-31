import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { HostEvent } from "./agent-host.ts";
import type { LastChatTurn } from "./chat-bridge.ts";
import type { ChatLine } from "./chat.ts";
import { dashLog } from "./log.ts";
import { nodeToken } from "./node-auth.ts";
import { NODE_CODE_VERSION } from "./node-version.ts";
import { NODE_PORT, nodeStateDir } from "./paths.ts";

/**
 * The dashboard's side of the fleet node (node.ts). The node runs the agents;
 * the dashboard hands it captain lines and answers, and mirrors who is
 * running or waiting from its event stream, so status reads stay synchronous.
 *
 * The dashboard also keeps the node alive: when it cannot reach one it starts
 * it detached (its own session), so stopping or restarting the dashboard never
 * takes the node, or the agents in it, down. FLEET_NODE_SPAWN=0 turns that off.
 */

export type NodeAgentState = { running: boolean; waiting: boolean; alive: boolean; thinking: boolean; lastTurn: LastChatTurn | null };
export type NodeState = { api: number; pid: number; startedAt: string; version?: string; agents: Record<string, NodeAgentState> };

export type NodeHandlers = {
  line: (agentId: string, line: ChatLine) => void;
  host: (agentId: string, ev: HostEvent) => void;
  /** Agent state changed (running, waiting, a turn ended), or the link came or went. */
  state: () => void;
  ship: (ship: string) => void;
  rail: () => void;
  /** A fleet order changed state (lib/orders.ts). */
  orders: () => void;
  /** A fleet action is waiting for, or got, the captain's Go (lib/go-gate.ts). */
  go: () => void;
};

const BASE = `http://127.0.0.1:${NODE_PORT}`;
const OFFLINE = "The fleet node is not running, so agents cannot take messages. The dashboard is restarting it; send again in a few seconds.";

let state: NodeState | null = null;
let online = false;

export function nodeOnline(): boolean {
  return online;
}

export function nodeInfo(): { online: boolean; pid?: number; startedAt?: string; port: number; stale: boolean } {
  return { online, port: NODE_PORT, stale: nodeStale(), ...(state ? { pid: state.pid, startedAt: state.startedAt } : {}) };
}

/** The node runs older code than this dashboard (it was started before the last code change). */
export function nodeStale(): boolean {
  return Boolean(state && state.version !== NODE_CODE_VERSION);
}

let lastRestart = 0;

/**
 * Restart a stale node once nothing is in flight: no agent working, thinking,
 * or waiting on a dialog. Idle agents lose nothing (their sessions are on disk
 * and resume on the next message); the link loop starts the new node.
 */
async function restartStaleNode(): Promise<void> {
  if (!state || !nodeStale() || Date.now() - lastRestart < 60_000) return;
  const busy = Object.entries(state.agents).filter(([, a]) => a.running || a.thinking || a.waiting).map(([id]) => id);
  if (busy.length) return;
  lastRestart = Date.now();
  await dashLog("node", `fleet node ${state.pid} runs older code (${state.version ?? "unversioned"}, dashboard ${NODE_CODE_VERSION}); restarting it while idle`);
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

const agent = (id: string): NodeAgentState | undefined => state?.agents[id];

export function hostRunning(agentId: string): boolean {
  return agent(agentId)?.running ?? false;
}

export function hostWaiting(agentId: string): boolean {
  return agent(agentId)?.waiting ?? false;
}

export function hostAlive(agentId: string): boolean {
  return agent(agentId)?.alive ?? false;
}

export function getHeadlessChatState(agentId: string): { thinking: boolean; lastTurn: LastChatTurn | null } {
  const a = agent(agentId);
  return { thinking: a?.thinking ?? false, lastTurn: a?.lastTurn ?? null };
}

export function getAllLastChatTurns(): Record<string, LastChatTurn | null> {
  const out: Record<string, LastChatTurn | null> = {};
  for (const [id, a] of Object.entries(state?.agents ?? {})) out[id] = a.lastTurn;
  return out;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${nodeToken()}`, "Content-Type": "application/json" };
}

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/v1/health`, { headers: headers(), signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

let starting: Promise<boolean> | null = null;

/** A reachable node, starting one when there is none. */
export function ensureNode(): Promise<boolean> {
  starting ??= (async () => {
    if (await healthy()) return true;
    if (process.env.FLEET_NODE_SPAWN === "0") return false;
    mkdirSync(nodeStateDir(), { recursive: true });
    nodeToken();
    const log = openSync(join(nodeStateDir(), "node.log"), "a");
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "node.ts")], {
      cwd: join(import.meta.dir, "..", ".."),
      env: process.env,
      stdio: ["ignore", log, log],
      detached: true,
    });
    proc.unref();
    await dashLog("node", `started fleet node pid=${proc.pid} on ${NODE_PORT}`);
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(250);
      if (await healthy()) return true;
    }
    await dashLog("node", `fleet node on ${NODE_PORT} did not come up; see ${join(nodeStateDir(), "node.log")}`);
    return false;
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<Response | null> {
  try {
    return await fetch(`${BASE}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/** POST, starting the node and retrying once when it cannot be reached. */
async function call(path: string, body: Record<string, unknown>): Promise<Response | null> {
  const r = await post(path, body);
  if (r) return r;
  if (!(await ensureNode())) return null;
  return post(path, body);
}

/** Hand a saved captain (or crew) line to the node. Returns an error to show, or null. */
export async function submitCaptainLine(agentId: string, line: ChatLine): Promise<string | null> {
  const r = await call("/v1/captain-line", { agentId, line });
  if (!r) return OFFLINE;
  if (r.ok) return null;
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error ?? `The fleet node refused the message (${r.status}).`;
}

export async function answerDialog(
  agentId: string,
  dialogId: string,
  answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const r = await call("/v1/answer", { agentId, dialogId, ...answer });
  if (!r) return { ok: false, error: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, error: "bad reply from the fleet node" }))) as { ok: boolean; error?: string };
}

export async function abortHost(agentId: string): Promise<boolean> {
  const r = await call("/v1/abort", { agentId });
  return Boolean(r?.ok && ((await r.json().catch(() => ({}))) as { ok?: boolean }).ok);
}

export async function stopHost(agentId: string): Promise<void> {
  await call("/v1/stop", { agentId });
}

export async function newSession(agentId: string): Promise<{ ok: boolean; message: string; sessionId?: string }> {
  const r = await call("/v1/new-session", { agentId });
  if (!r) return { ok: false, message: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, message: "bad reply from the fleet node" }))) as { ok: boolean; message: string };
}

/** The captain's Allow or Deny on a call the tool gate held (lib/tool-gate.ts). */
export async function decideGate(id: string, allow: boolean): Promise<{ ok: boolean; message: string }> {
  const r = await call("/v1/gate", { id, decision: allow ? "allow" : "deny" });
  if (!r) return { ok: false, message: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, message: "bad reply from the fleet node" }))) as { ok: boolean; message: string };
}

/** The captain's Remember or Not this on a memory proposal; the node runs it, so Alice's line comes from the process that hosts her. */
export async function memoryAnswer(id: number, action: "approve" | "dismiss", label?: string): Promise<{ ok: boolean; message: string }> {
  const r = await call("/v1/memory", { id, action, label });
  if (!r) return { ok: false, message: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, message: "bad reply from the fleet node" }))) as { ok: boolean; message: string };
}

/** The captain's Go, Snooze or Done on one of Alice's proactive proposals; the node runs it, since Go posts to Alice. */
export async function proactiveAnswer(id: number, action: "go" | "snooze" | "done"): Promise<{ ok: boolean; message: string }> {
  const r = await call("/v1/proactive", { id, action });
  if (!r) return { ok: false, message: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, message: "bad reply from the fleet node" }))) as { ok: boolean; message: string };
}

/** The captain's Go or No on a held fleet action; the node runs it and tells the officer. */
export async function decideGo(id: string, go: boolean): Promise<{ ok: boolean; message: string }> {
  const r = await call("/v1/go", { id, decision: go ? "go" : "no" });
  if (!r) return { ok: false, message: OFFLINE };
  return (await r.json().catch(() => ({ ok: false, message: "bad reply from the fleet node" }))) as { ok: boolean; message: string };
}

/** After a Go, retry, or cancel, so the watcher acts now instead of at its next poll. */
export async function kickNodeOrders(): Promise<void> {
  await post("/v1/orders/kick", {}, 5000);
}

/** After crew changes, so the node knows a new crewmate before its first message. */
export async function refreshNodeTargets(): Promise<void> {
  await post("/v1/refresh-targets", {});
}

/** Split an SSE buffer into complete frames and the unfinished rest. */
export function parseSse(buf: string): { frames: { event: string; data: string }[]; rest: string } {
  const frames: { event: string; data: string }[] = [];
  let rest = buf;
  let end: number;
  while ((end = rest.indexOf("\n\n")) >= 0) {
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = "message";
    const data: string[] = [];
    for (const l of block.split("\n")) {
      if (l.startsWith(":")) continue;
      if (l.startsWith("event:")) event = l.slice(6).trim();
      else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  return { frames, rest };
}

function dispatch(h: NodeHandlers, event: string, data: string): void {
  const j = JSON.parse(data) as Record<string, unknown>;
  if (event === "state") {
    state = j as unknown as NodeState;
    h.state();
    void restartStaleNode();
  } else if (event === "line") h.line(String(j.agentId), j.line as ChatLine);
  else if (event === "host") h.host(String(j.agentId), j.ev as HostEvent);
  else if (event === "turn") h.state();
  else if (event === "ship") h.ship(String(j));
  else if (event === "rail") h.rail();
  else if (event === "orders") h.orders();
  else if (event === "go") h.go();
}

/** Follow the node's event stream for the dashboard's life, restarting the node when it is gone. */
export function startNodeLink(h: NodeHandlers): void {
  // A stale node waiting for its agents to go idle: look again every 30s.
  setInterval(() => void restartStaleNode(), 30_000);
  const loop = async () => {
    for (let backoff = 500; ; backoff = Math.min(backoff * 2, 5000)) {
      if (await ensureNode()) {
        try {
          const res = await fetch(`${BASE}/v1/events`, { headers: headers() });
          if (res.ok && res.body) {
            online = true;
            backoff = 500;
            await dashLog("node", `linked to fleet node on ${NODE_PORT}`);
            const dec = new TextDecoder();
            let buf = "";
            for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
              const parsed = parseSse(buf + dec.decode(chunk, { stream: true }));
              buf = parsed.rest;
              for (const f of parsed.frames) {
                try {
                  dispatch(h, f.event, f.data);
                } catch (e) {
                  console.error("[dashboard] node event:", e);
                }
              }
            }
          }
        } catch {
          /* link dropped */
        }
      }
      if (online) {
        online = false;
        state = null;
        await dashLog("node", "lost the fleet node link; reconnecting");
        h.state();
      }
      await Bun.sleep(backoff);
    }
  };
  void loop();
}
