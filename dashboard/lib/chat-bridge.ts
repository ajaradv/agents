import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAgentChat,
  appendChatError,
  appendChatLine,
  chatLogPath,
  readCaptainChat,
  takePendingQuestions,
  type ChatLine,
} from "./chat.ts";
import { hostRunning, registerHostHooks, submitToHost, type HostEvent } from "./agent-host.ts";
import { allChatTargetIds, chatTarget } from "./chat-targets.ts";
import { logCrewEvent, logCrewLine, logCrewTurn } from "./ship-events.ts";
import { budgetRefusal } from "./shipyard.ts";
import { dashLog } from "./log.ts";
import { spawnTimed } from "./proc.ts";
import { fleetInboxRoot, ROOT } from "./paths.ts";
import {
  firstmateTuiReachable,
  formatFirstmateSendError,
  sendFmText,
  sendToFirstmateTui,
  type FmSendResult,
} from "./firstmate-chat.ts";

export type ChatBroadcaster = (agentId: string, line: ChatLine) => void;
/** Ephemeral live events from RPC agents (streaming text, tool steps, notices); never saved. */
export type ChatEventBroadcaster = (agentId: string, ev: HostEvent) => void;

export type LastChatTurn = {
  at: string;
  status: "ok" | "error" | "timeout";
  ms: number;
  error?: string;
};

let broadcast: ChatBroadcaster = () => {};
let broadcastEvent: ChatEventBroadcaster = () => {};
let onTurnComplete: () => void = () => {};

export function setChatTurnEmitter(fn: () => void): void {
  onTurnComplete = fn;
}

const TURN_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;
const CONTEXT_LINES = 12;

/**
 * Per-thread state. `queue` + `running` is the send lock: one turn per thread
 * at a time, later captain lines wait in order.
 */
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

export function registerChatEventBroadcaster(fn: ChatEventBroadcaster): void {
  broadcastEvent = fn;
}

registerHostHooks({
  line: (agentId, line) => {
    logCrewLine(agentId, line);
    emitOwn(agentId, line);
  },
  event: (agentId, ev) => {
    logCrewEvent(agentId, ev);
    broadcastEvent(agentId, ev);
  },
  settled: (agentId, outcome) => {
    logCrewTurn(agentId, outcome);
    recordTurn(agentId, {
      at: new Date().toISOString(),
      status: outcome.ok ? "ok" : "error",
      ms: outcome.ms,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    onTurnComplete();
  },
});

export function getHeadlessChatState(agentId: string): {
  thinking: boolean;
  lastTurn: LastChatTurn | null;
} {
  const s = state.get(agentId);
  return {
    thinking: Boolean(s?.running) || hostRunning(agentId),
    lastTurn: s?.lastTurn ?? null,
  };
}

export function getAllLastChatTurns(): Record<string, LastChatTurn | null> {
  const out: Record<string, LastChatTurn | null> = {};
  for (const id of allChatTargetIds()) {
    out[id] = state.get(id)?.lastTurn ?? null;
  }
  return out;
}

function parseChatLine(raw: string): ChatLine | null {
  try {
    const o = JSON.parse(raw) as ChatLine;
    if ((o.kind !== "chat" && o.kind !== "error" && o.kind !== "question") || !o.text) return null;
    return o;
  } catch {
    return null;
  }
}

function buildTurnPrompt(history: ChatLine[]): string {
  const thread = history
    .filter((l) => l.kind === "chat" || l.kind === "question")
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

/** Write and broadcast a line the bridge produced itself, so the poller skips it. */
function emitOwn(agentId: string, line: ChatLine): void {
  agentState(agentId).seenKeys.add(lineKey(line));
  broadcast(agentId, line);
}

async function failTurn(
  agentId: string,
  captainLine: ChatLine,
  status: "error" | "timeout",
  ms: number,
  reason: string,
): Promise<void> {
  recordTurn(agentId, { at: new Date().toISOString(), status, ms, error: reason });
  emitOwn(agentId, await appendChatError(agentId, reason, captainLine.ts));
}

async function finishFmSend(
  agentId: string,
  captainLine: ChatLine,
  res: FmSendResult,
  ack: string,
): Promise<void> {
  await dashLog(
    "chat-turn",
    `${agentId} ${res.ms}ms exit=${res.exitCode} timedOut=${res.timedOut}`,
  );
  if (res.timedOut) {
    await failTurn(agentId, captainLine, "timeout", res.ms, "fm-send timed out.");
    return;
  }
  if (!res.ok) {
    await failTurn(
      agentId,
      captainLine,
      "error",
      res.ms,
      formatFirstmateSendError(res.stderr, res.stdout),
    );
    return;
  }
  recordTurn(agentId, { at: new Date().toISOString(), status: "ok", ms: res.ms });
  emitOwn(agentId, await appendAgentChat(agentId, "system", ack));
}

async function runFirstmateTurn(captainLine: ChatLine): Promise<void> {
  const agentId = "firstmate";
  await dashLog("chat-turn", `start ${agentId} (fm-send)`);
  const reachable = await firstmateTuiReachable();
  if (!reachable.ok) {
    await failTurn(agentId, captainLine, "error", 0, reachable.reason ?? "TUI off");
    return;
  }
  await finishFmSend(
    agentId,
    captainLine,
    await sendToFirstmateTui(captainLine.text),
    "Sent to Firstmate TUI (fm-send). Reply in the attached pane; dashboard shows bus/chat when Firstmate writes back.",
  );
}

async function runTaskTurn(taskId: string, captainLine: ChatLine): Promise<void> {
  await dashLog("chat-turn", `start ${taskId} (fm-send task)`);
  await finishFmSend(
    taskId,
    captainLine,
    await sendFmText(taskId, captainLine.text),
    "Sent to this worker's steering inbox (fm-send). Its reply arrives through Firstmate.",
  );
}

/** What a stopped turn already reported on Firstmate's bus, so a timeout does not read as "did nothing". */
async function busWorkSince(agentId: string, since: string): Promise<string> {
  let text = "";
  try {
    text = await readFile(join(fleetInboxRoot(), "firstmate", "events.jsonl"), "utf8");
  } catch {
    return "";
  }
  const done: string[] = [];
  for (const raw of text.trim().split("\n").slice(-200)) {
    try {
      const o = JSON.parse(raw) as { ts?: string; from?: string; summary?: string; ref?: unknown };
      if (o.from !== agentId || !o.ts || new Date(o.ts) < new Date(since)) continue;
      const refs = Array.isArray(o.ref) ? o.ref.join(", ") : typeof o.ref === "string" ? o.ref : "";
      done.push(`${o.summary ?? ""}${refs ? ` (${refs})` : ""}`.trim());
    } catch {
      /* skip */
    }
  }
  return done.length ? ` Before it stopped it reported: ${done.join("; ")}` : "";
}

async function runHeadlessTurn(agentId: string, captainLine: ChatLine): Promise<void> {
  const history = await readCaptainChat(agentId, CONTEXT_LINES * 2);
  const prompt = buildTurnPrompt(history);
  const launch = join(ROOT, "bin/launch");
  const timeoutMs = (chatTarget(agentId)?.turnTimeoutSec ?? 0) * 1000 || TURN_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  await dashLog("chat-turn", `start ${agentId}`);
  let res;
  try {
    res = await spawnTimed(["python3", launch, "headless", agentId], {
      timeoutMs,
      stdin: prompt,
      cwd: ROOT,
      env: process.env,
    });
  } catch (e) {
    await failTurn(agentId, captainLine, "error", 0, e instanceof Error ? e.message : "spawn failed");
    return;
  }

  await dashLog(
    "chat-turn",
    `${agentId} ${res.ms}ms exit=${res.exitCode} timedOut=${res.timedOut}`,
  );

  if (res.timedOut || res.exitCode !== 0) {
    const asked = await takePendingQuestions(agentId);
    if (asked) emitOwn(agentId, asked);
  }
  if (res.timedOut) {
    await failTurn(
      agentId,
      captainLine,
      "timeout",
      res.ms,
      `${agentId} did not reply in time (${timeoutMs / 1000}s); the turn was stopped.` +
        (await busWorkSince(agentId, startedAt)),
    );
    return;
  }
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || "headless turn failed").slice(0, 800);
    await failTurn(agentId, captainLine, "error", res.ms, detail.slice(0, 500));
    return;
  }
  const text = res.stdout.trim();
  const asked = await takePendingQuestions(agentId);
  if (!text && !asked) {
    await failTurn(agentId, captainLine, "error", res.ms, `${agentId} returned an empty reply.`);
    return;
  }
  recordTurn(agentId, { at: new Date().toISOString(), status: "ok", ms: res.ms });
  if (text) emitOwn(agentId, await appendAgentChat(agentId, agentId, text));
  if (asked) emitOwn(agentId, asked);
}

async function drainQueue(agentId: string): Promise<void> {
  const st = agentState(agentId);
  if (st.running) return;
  const nextTs = st.queue.shift();
  if (!nextTs) return;
  st.running = true;
  let line: ChatLine | undefined;
  try {
    const history = await readCaptainChat(agentId, 50);
    line = history.find((l) => l.ts === nextTs && (l.from === "captain" || l.kind === "crew"));
    const target = chatTarget(agentId);
    if (line && target) {
      if (target.kind === "firstmate") await runFirstmateTurn(line);
      else if (target.kind === "task") await runTaskTurn(agentId, line);
      else if (target.runtime === "rpc") {
        const refusal = target.ship ? await budgetRefusal(target.ship, agentId) : null;
        if (refusal) await failTurn(agentId, line, "error", 0, refusal);
        else if (line.kind === "crew") {
          await submitToHost(agentId, { ...line, text: `Message from ${line.from} (crewmate aboard, not the captain):\n\n${line.text}` });
        } else await submitToHost(agentId, line);
      } else if (line.kind === "crew") {
        await failTurn(agentId, line, "error", 0, `${agentId} only takes crew messages as a live crewmate.`);
      }
      else await runHeadlessTurn(agentId, line);
    } else if (line) {
      await failTurn(agentId, line, "error", 0, `${agentId} is no longer on the rail.`);
    }
  } catch (e) {
    console.error(`[dashboard] chat-turn ${agentId}:`, e);
    const msg = e instanceof Error ? e.message : "turn failed";
    try {
      if (line) await failTurn(agentId, line, "error", 0, msg);
      else recordTurn(agentId, { at: new Date().toISOString(), status: "error", ms: 0, error: msg });
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

/**
 * The server calls this right after it appends a captain line, so a send never
 * depends on the poller having seen the thread first.
 */
/** A crewmate messages another crewmate aboard the same ship; it starts a turn there. */
export async function acceptCrewLine(to: string, from: string, text: string): Promise<ChatLine> {
  const line = await appendChatLine(to, { ts: new Date().toISOString(), from, kind: "crew", text: text.slice(0, 8000) });
  emitOwn(to, line);
  logCrewLine(to, line);
  enqueueCaptainTurn(to, line);
  return line;
}

export async function acceptCaptainLine(agentId: string, line: ChatLine): Promise<void> {
  const fresh = !state.has(agentId);
  const st = agentState(agentId);
  if (fresh) st.offset = await fileSize(chatLogPath(agentId));
  const key = lineKey(line);
  if (st.seenKeys.has(key)) return; // the poller already queued it
  st.seenKeys.add(key);
  logCrewLine(agentId, line);
  enqueueCaptainTurn(agentId, line);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function pollAgentFile(agentId: string): Promise<void> {
  const path = chatLogPath(agentId);
  // First sight of a thread: start at its end so old captain lines are not replayed.
  if (!state.has(agentId)) {
    agentState(agentId).offset = await fileSize(path);
    return;
  }
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
  for (const raw of chunk.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line = parseChatLine(trimmed);
    if (!line) continue;
    const key = lineKey(line);
    if (st.seenKeys.has(key)) continue;
    st.seenKeys.add(key);
    logCrewLine(agentId, line);

    if (line.from === "captain") {
      enqueueCaptainTurn(agentId, line);
      continue;
    }
    broadcast(agentId, line);
  }
}

async function pollOnce(): Promise<void> {
  for (const id of allChatTargetIds()) {
    await pollAgentFile(id);
  }
}

/** Call after chat targets have loaded once, so first-sight offsets are taken at boot. */
export function startChatBridge(): void {
  const tick = () => {
    pollOnce().catch((e) => console.error("[dashboard] chat-bridge:", e));
  };
  tick();
  setInterval(tick, POLL_MS);
}
