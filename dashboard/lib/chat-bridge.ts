import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAgentChat,
  chatAllowed,
  chatLogPath,
  readCaptainChat,
  type ChatLine,
} from "./chat.ts";
import { dashLog } from "./log.ts";
import { spawnTimed } from "./proc.ts";
import { ROOT } from "./paths.ts";
import {
  firstmateTuiReachable,
  formatFirstmateSendError,
  sendToFirstmateTui,
} from "./firstmate-chat.ts";

export type ChatBroadcaster = (agentId: string, line: ChatLine) => void;

export type LastChatTurn = {
  at: string;
  status: "ok" | "error" | "timeout";
  ms: number;
  error?: string;
};

let broadcast: ChatBroadcaster = () => {};
let onTurnComplete: () => void = () => {};

export function setChatTurnEmitter(fn: () => void): void {
  onTurnComplete = fn;
}

const TURN_AGENTS = ["alice", "firstmate", "architect"] as const;
const TURN_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;
const CONTEXT_LINES = 12;

type AgentState = {
  offset: number;
  seenKeys: Set<string>;
  queue: string[];
  running: boolean;
  lastTurn: LastChatTurn | null;
};

const state = new Map<string, AgentState>();

function lineKey(line: ChatLine): string {
  return `${line.ts}\t${line.from}\t${line.text}`;
}

function agentState(agentId: string): AgentState {
  let s = state.get(agentId);
  if (!s) {
    s = {
      offset: 0,
      seenKeys: new Set(),
      queue: [],
      running: false,
      lastTurn: null,
    };
    state.set(agentId, s);
  }
  return s;
}

export function registerChatBroadcaster(fn: ChatBroadcaster): void {
  broadcast = fn;
}

export function getHeadlessChatState(agentId: string): {
  thinking: boolean;
  lastTurn: LastChatTurn | null;
} {
  const s = state.get(agentId);
  return {
    thinking: Boolean(s?.running),
    lastTurn: s?.lastTurn ?? null,
  };
}

export function getAllLastChatTurns(): Record<string, LastChatTurn | null> {
  const out: Record<string, LastChatTurn | null> = {};
  for (const id of TURN_AGENTS) {
    out[id] = state.get(id)?.lastTurn ?? null;
  }
  return out;
}

async function initOffsets(): Promise<void> {
  for (const id of TURN_AGENTS) {
    if (!chatAllowed(id)) continue;
    const path = chatLogPath(id);
    try {
      const st = await stat(path);
      agentState(id).offset = st.size;
    } catch {
      agentState(id).offset = 0;
    }
  }
}

function parseChatLine(raw: string): ChatLine | null {
  try {
    const o = JSON.parse(raw) as ChatLine;
    if (o.kind !== "chat" || !o.text) return null;
    return o;
  } catch {
    return null;
  }
}

function buildTurnPrompt(history: ChatLine[]): string {
  const thread = history
    .slice(-CONTEXT_LINES)
    .map((l) => `${l.from}: ${l.text}`)
    .join("\n");
  return (
    "Captain dashboard chat thread (most recent last):\n" +
    (thread ? `${thread}\n\n` : "") +
    "Reply to the captain's latest message in plain text for the dashboard chat log."
  );
}

function recordTurn(agentId: string, turn: LastChatTurn): void {
  agentState(agentId).lastTurn = turn;
}

async function runFirstmateTurn(captainLine: ChatLine): Promise<void> {
  const agentId = "firstmate";
  await dashLog("chat-turn", `start ${agentId} (fm-send)`);
  const reachable = await firstmateTuiReachable();
  if (!reachable.ok) {
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: 0,
      error: reachable.reason,
    });
    const err = await appendAgentChat(agentId, "system", reachable.reason ?? "TUI off");
    broadcast(agentId, err);
    return;
  }
  const res = await sendToFirstmateTui(captainLine.text);
  await dashLog(
    "chat-turn",
    `${agentId} ${res.ms}ms exit=${res.exitCode} timedOut=${res.timedOut}`,
  );
  if (res.timedOut) {
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "timeout",
      ms: res.ms,
      error: "fm-send timed out",
    });
    const err = await appendAgentChat(agentId, "system", "fm-send timed out.");
    broadcast(agentId, err);
    return;
  }
  if (!res.ok) {
    const detail = formatFirstmateSendError(res.stderr, res.stdout);
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: res.ms,
      error: detail,
    });
    const err = await appendAgentChat(agentId, "system", detail);
    broadcast(agentId, err);
    return;
  }
  recordTurn(agentId, {
    at: new Date().toISOString(),
    status: "ok",
    ms: res.ms,
  });
  const ack = await appendAgentChat(
    agentId,
    "system",
    "Sent to Firstmate TUI (fm-send). Reply in the attached pane; dashboard shows bus/chat when Firstmate writes back.",
  );
  agentState(agentId).seenKeys.add(lineKey(ack));
  broadcast(agentId, ack);
}

async function runHeadlessTurn(agentId: string, _captainLine: ChatLine): Promise<void> {
  const history = await readCaptainChat(agentId, CONTEXT_LINES);
  const prompt = buildTurnPrompt(history);
  const launch = join(ROOT, "bin/launch");
  await dashLog("chat-turn", `start ${agentId}`);
  let res;
  try {
    res = await spawnTimed(["python3", launch, "headless", agentId], {
      timeoutMs: TURN_TIMEOUT_MS,
      stdin: prompt,
      cwd: ROOT,
      env: process.env,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "spawn failed";
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: 0,
      error: msg,
    });
    const err = await appendAgentChat(agentId, "system", msg);
    broadcast(agentId, err);
    return;
  }

  await dashLog(
    "chat-turn",
    `${agentId} ${res.ms}ms exit=${res.exitCode} timedOut=${res.timedOut}`,
  );

  if (res.timedOut) {
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "timeout",
      ms: res.ms,
      error: "timed out",
    });
    const err = await appendAgentChat(
      agentId,
      "system",
      `${agentId} did not reply in time (${TURN_TIMEOUT_MS / 1000}s).`,
    );
    broadcast(agentId, err);
    return;
  }
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || "headless turn failed").slice(0, 800);
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: res.ms,
      error: detail,
    });
    const err = await appendAgentChat(agentId, "system", detail.slice(0, 500));
    broadcast(agentId, err);
    return;
  }
  const text = res.stdout.trim();
  if (!text) {
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: res.ms,
      error: "empty reply",
    });
    const err = await appendAgentChat(agentId, "system", `${agentId} returned an empty reply.`);
    broadcast(agentId, err);
    return;
  }
  recordTurn(agentId, {
    at: new Date().toISOString(),
    status: "ok",
    ms: res.ms,
  });
  const reply = await appendAgentChat(agentId, agentId, text);
  const st = agentState(agentId);
  st.seenKeys.add(lineKey(reply));
  broadcast(agentId, reply);
}

async function drainQueue(agentId: string): Promise<void> {
  const st = agentState(agentId);
  if (st.running) return;
  const nextTs = st.queue.shift();
  if (!nextTs) return;
  st.running = true;
  try {
    const history = await readCaptainChat(agentId, 50);
    const line = history.find((l) => l.ts === nextTs && l.from === "captain");
    if (line) {
      if (agentId === "firstmate") {
        await runFirstmateTurn(line);
      } else {
        await runHeadlessTurn(agentId, line);
      }
    }
  } catch (e) {
    console.error(`[dashboard] chat-turn ${agentId}:`, e);
    const msg = e instanceof Error ? e.message : "turn failed";
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: "error",
      ms: 0,
      error: msg,
    });
    try {
      const err = await appendAgentChat(agentId, "system", msg);
      broadcast(agentId, err);
    } catch {
      /* ignore */
    }
  } finally {
    st.running = false;
    onTurnComplete();
    if (st.queue.length > 0) {
      void drainQueue(agentId);
    }
  }
}

function enqueueCaptainTurn(agentId: string, line: ChatLine): void {
  const st = agentState(agentId);
  if (st.queue.includes(line.ts)) return;
  st.queue.push(line.ts);
  void drainQueue(agentId);
}

async function pollAgentFile(agentId: string): Promise<void> {
  const path = chatLogPath(agentId);
  const st = agentState(agentId);
  let chunk = "";
  try {
    const fileStat = await stat(path);
    if (fileStat.size < st.offset) {
      st.offset = 0;
      st.seenKeys.clear();
    }
    if (fileStat.size === st.offset) return;
    const len = fileStat.size - st.offset;
    const buf = Buffer.alloc(len);
    const handle = await open(path, "r");
    try {
      await handle.read(buf, 0, len, st.offset);
    } finally {
      await handle.close();
    }
    st.offset = fileStat.size;
    chunk = buf.toString("utf8");
  } catch {
    return;
  }
  const parts = chunk.split("\n");
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line = parseChatLine(trimmed);
    if (!line) continue;
    const key = lineKey(line);
    if (st.seenKeys.has(key)) continue;
    st.seenKeys.add(key);

    if (line.from === "captain") {
      enqueueCaptainTurn(agentId, line);
      continue;
    }
    if (line.from === agentId || line.from === "system") {
      broadcast(agentId, line);
    }
  }
}

async function pollOnce(): Promise<void> {
  for (const id of TURN_AGENTS) {
    if (!chatAllowed(id)) continue;
    await pollAgentFile(id);
  }
}

export function startChatBridge(): void {
  void initOffsets().then(() => {
    const tick = () => {
      pollOnce().catch((e) => console.error("[dashboard] chat-bridge:", e));
    };
    tick();
    setInterval(tick, POLL_MS);
  });
}
