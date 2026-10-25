import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendAgentChat,
  appendChatError,
  appendChatLine,
  questionsText,
  type ChatLine,
  type ChatQuestion,
} from "./chat.ts";
import { chatTarget } from "./chat-targets.ts";
import { agentKeyEnv } from "./fleet-env.ts";
import { dashLog } from "./log.ts";
import { notifyCaptain } from "./notify.ts";
import { recordToolFailure } from "./tool-failures.ts";
import { LINK_LOST } from "./laptop-host.ts";
import { localHost, type RpcProc } from "./ship-host.ts";
import { voyageHost, voyageWorktree } from "./voyage-worktree.ts";
import { toolFailed } from "../../extensions/cache-watch.ts";
import { fleetInboxRoot, NODE_PORT } from "./paths.ts";

/**
 * Agent host: one long-lived `pi --mode rpc` process per agent with
 * `runtime: rpc` in agent.yaml (started through `bin/launch rpc <id>`). It runs
 * inside the fleet node (node.ts), so a dashboard restart leaves agents working.
 *
 * - Captain messages become RPC `prompt` commands; a message sent while the
 *   agent works is queued as a steer (read between its steps).
 * - Assistant text streams to the drawer as ephemeral events; each finished
 *   assistant message is saved as a chat line.
 * - Extension dialogs (select/confirm/input/editor, e.g. ask_captain or
 *   cursor_ask_question) become question lines; the captain's answer goes back
 *   as `extension_ui_response` while the tool waits.
 * - Idle agents are stopped after IDLE_MS; the Pi session persists on disk, so
 *   the next message resumes it.
 *
 * Firstmate is not hosted here: it stays a TUI (vendored agent, run as designed).
 */

export type HostEvent =
  | { kind: "stream"; text: string }
  | { kind: "activity"; text: string }
  | { kind: "running"; running: boolean }
  | { kind: "notice"; text: string; level: "info" | "warning" | "error" }
  | { kind: "agent-status"; key: string; text: string | null };

export type HostHooks = {
  line: (agentId: string, line: ChatLine) => void;
  event: (agentId: string, ev: HostEvent) => void;
  settled: (agentId: string, outcome: { ok: boolean; ms: number; error?: string; cost: number; tokens: number; cacheRead?: number; prompt?: number; model?: string }) => void;
};

const IDLE_MS = 20 * 60_000;
const STREAM_THROTTLE_MS = 120;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
// A provider stream cut off mid-response. Pi only retries errors it recognises
// as network failures; a proxy that ends the response
// mid-event surfaces as a parse error instead.
const STREAM_DROPPED = /Could not parse .*SSE event|Unexpected end of JSON input|stream (ended|closed|terminated)|terminated|ECONNRESET|socket hang up/i;
const STREAM_RETRIES = 2;
const BILLING_ERROR = /\b402\b|billing|insufficient|quota|out of credits|requires more credits|balance/i;
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid (api )?key|authentication failed/i;

/**
 * The agent's model cannot work today (out of credits, key rejected): record it
 * so bin/launch starts the next session on fallback_model until midnight.
 */
/**
 * Mark today's primary model as failed for this agent, so bin/launch starts it
 * on fallback_model until tomorrow. True only for the first failure today (the
 * caller continues the work once; a second failure means the backup failed too).
 */
async function recordModelFailure(agentId: string, reason: string): Promise<boolean> {
  const model = chatTarget(agentId)?.model;
  if (!model) return false;
  const day = new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local, like Python's date.today()
  const path = join(fleetInboxRoot(), agentId, "model-fallback.json");
  try {
    const prev = JSON.parse(await readFile(path, "utf8")) as { day?: string; model?: string };
    if (prev.day === day && prev.model === model) return false;
  } catch {
    /* no marker yet */
  }
  try {
    await mkdir(join(fleetInboxRoot(), agentId), { recursive: true });
    await writeFile(path, JSON.stringify({ day, model, reason: reason.slice(0, 300) }) + "\n", "utf8");
    return true;
  } catch {
    return false; /* the launcher just tries the primary again */
  }
}

/** Why a turn's provider error should move the agent to its backup model, or null. */
export function fallbackReason(error: string): "billing" | "auth" | "stream" | null {
  if (BILLING_ERROR.test(error)) return "billing";
  if (AUTH_ERROR.test(error)) return "auth";
  // Only reached once the in-place retries are used up.
  if (STREAM_DROPPED.test(error)) return "stream";
  return null;
}

type Dialog = { method: string; lineTs: string; timer?: ReturnType<typeof setTimeout> };

type AgentProc = {
  id: string;
  proc: RpcProc;
  nextId: number;
  pending: Map<string, (r: Record<string, unknown>) => void>;
  running: boolean;
  startedAt: number;
  lastActive: number;
  streamText: string;
  streamTimer: ReturnType<typeof setTimeout> | null;
  dialogs: Map<string, Dialog>;
  stderrTail: string;
  lastCaptainTs: string | null;
  turnError: string | null;
  /** Running tool calls' short summaries, by call id (for the failure log). */
  toolArgs: Map<string, string>;
  /** provider/model of the latest reply. */
  model: string;
  /** The voyage worktree this crewmate started in ("" for the repo or a non-crewmate). */
  worktree: string;
  /** Continues sent for the current captain line after a dropped stream. */
  streamRetries: number;
  /** This turn's billed cost and tokens, summed from Pi's assistant message usage. */
  turnCost: number;
  turnTokens: number;
  /** Prompt tokens this turn read from the provider's cache, and all prompt tokens (cache share = read / prompt). */
  turnCacheRead: number;
  turnPrompt: number;
};

let hooks: HostHooks = { line: () => {}, event: () => {}, settled: () => {} };
const procs = new Map<string, AgentProc>();

export function registerHostHooks(h: HostHooks): void {
  hooks = h;
}

export function hostRunning(agentId: string): boolean {
  return procs.get(agentId)?.running ?? false;
}

/** A live agent is blocked on the captain: an ask_captain (or other) dialog is open. */
export function hostWaiting(agentId: string): boolean {
  return (procs.get(agentId)?.dialogs.size ?? 0) > 0;
}

export function hostAlive(agentId: string): boolean {
  return procs.has(agentId);
}

/** Agents with a live process right now. */
export function hostIds(): string[] {
  return [...procs.keys()];
}

function send(p: AgentProc, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `dash-${p.nextId++}`;
  return new Promise((resolve) => {
    p.pending.set(id, resolve);
    try {
      p.proc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
      p.proc.stdin.flush();
    } catch (e) {
      p.pending.delete(id);
      resolve({ success: false, error: e instanceof Error ? e.message : "write failed" });
    }
  });
}

function sendNoReply(p: AgentProc, rec: Record<string, unknown>): void {
  try {
    p.proc.stdin.write(JSON.stringify(rec) + "\n");
    p.proc.stdin.flush();
  } catch {
    /* process gone; the exit handler reports it */
  }
}

function toolSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url;
  const detail = typeof pick === "string" ? pick.replace(/\s+/g, " ").slice(0, 120) : "";
  return detail ? `${name}: ${detail}` : name;
}

function assistantText(message: unknown): string {
  const m = message as { content?: unknown };
  if (typeof m?.content === "string") return m.content.trim();
  if (!Array.isArray(m?.content)) return "";
  return m.content
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("\n\n")
    .trim();
}

/** Dollars a tool's own model calls cost: pi's result usage, or the subagent extension's per-task usage. */
export function toolSpend(result: unknown): number {
  const r = result as { usage?: { cost?: { total?: number } | number }; details?: { results?: { usage?: { cost?: number } }[] } } | undefined;
  const own = r?.usage?.cost;
  const fromUsage = typeof own === "number" ? own : (own?.total ?? 0);
  if (fromUsage > 0) return fromUsage;
  return (r?.details?.results ?? []).reduce((sum, x) => sum + (Number(x?.usage?.cost) || 0), 0);
}

function flushStream(p: AgentProc): void {
  if (p.streamTimer) return;
  p.streamTimer = setTimeout(() => {
    p.streamTimer = null;
    hooks.event(p.id, { kind: "stream", text: p.streamText });
  }, STREAM_THROTTLE_MS);
}

async function onDialog(p: AgentProc, req: Record<string, unknown>): Promise<void> {
  const id = String(req.id ?? "");
  const method = String(req.method ?? "");
  if (!id) return;
  const title = String(req.title ?? "Question");
  const message = typeof req.message === "string" && req.message.trim() ? `\n${req.message.trim()}` : "";
  const options =
    method === "select" && Array.isArray(req.options)
      ? req.options.map((o) => String(o)).slice(0, 12)
      : method === "confirm"
        ? ["Yes", "No"]
        : [];
  const recommended = options.find((o) => /(\s\(recommended\)|\s[—–-]\s*recommended)$/i.test(o));
  const question: ChatQuestion = {
    id,
    question: `${title}${message}`,
    options,
    ...(recommended ? { recommended } : {}),
  };
  const timeoutMs = typeof req.timeout === "number" && req.timeout > 0 ? req.timeout : undefined;
  const line: ChatLine = {
    ts: new Date().toISOString(),
    from: p.id,
    kind: "question",
    text: questionsText("", [question]),
    questions: [question],
    dialog: { id, method, ...(timeoutMs ? { timeoutMs } : {}) },
  };
  const dialog: Dialog = { method, lineTs: line.ts };
  if (timeoutMs) {
    // Pi resolves the dialog itself at the timeout; just stop offering it.
    dialog.timer = setTimeout(() => {
      if (p.dialogs.delete(id)) hooks.event(p.id, { kind: "notice", text: `"${title}" timed out unanswered.`, level: "warning" });
    }, timeoutMs);
  }
  p.dialogs.set(id, dialog);
  hooks.line(p.id, await appendChatLine(p.id, line));
}

async function onRecord(p: AgentProc, rec: Record<string, unknown>): Promise<void> {
  p.lastActive = Date.now();
  switch (rec.type) {
    case "response": {
      const id = typeof rec.id === "string" ? rec.id : "";
      const resolve = p.pending.get(id);
      if (resolve) {
        p.pending.delete(id);
        resolve(rec);
      }
      return;
    }
    case "agent_start":
      if (!p.running) {
        p.running = true;
        p.startedAt = Date.now();
        p.turnError = null;
        p.turnCost = 0;
        p.turnTokens = 0;
        p.turnCacheRead = 0;
        p.turnPrompt = 0;
        hooks.event(p.id, { kind: "running", running: true });
      }
      return;
    case "message_start":
      if ((rec.message as { role?: string })?.role === "assistant") p.streamText = "";
      return;
    case "message_update": {
      const ev = rec.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ev?.type === "text_delta" && ev.delta) {
        p.streamText += ev.delta;
        flushStream(p);
      }
      return;
    }
    case "message_end": {
      const msg = rec.message as
        | { role?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }
        | undefined;
      if (msg?.role !== "assistant") return;
      const u = msg.usage;
      if (u) {
        p.turnCost += u.cost?.total ?? 0;
        p.turnTokens += (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        p.turnCacheRead += u.cacheRead ?? 0;
        p.turnPrompt += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
      }
      p.streamText = "";
      hooks.event(p.id, { kind: "stream", text: "" });
      if (msg.stopReason === "error" && msg.errorMessage) p.turnError = msg.errorMessage;
      const m = rec.message as { provider?: string; model?: string };
      if (m.model) p.model = m.provider ? `${m.provider}/${m.model}` : m.model;
      const text = assistantText(msg);
      // Text in a message that ends in a tool call is narration on the way (a step), not the answer.
      if (text) hooks.line(p.id, await appendAgentChat(p.id, p.id, text, { step: msg.stopReason === "toolUse" }));
      return;
    }
    case "tool_execution_end": {
      // Tools that run models of their own (sub-agents) report what they spent; it is part of this turn.
      p.turnCost += toolSpend(rec.result);
      const id = String(rec.toolCallId ?? "");
      const args = p.toolArgs.get(id) ?? "";
      p.toolArgs.delete(id);
      const content = ((rec.result as { content?: { type: string; text?: string }[] } | undefined)?.content ?? []).filter((c) => c && typeof c.type === "string");
      if (toolFailed(Boolean(rec.isError), content)) {
        const error = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ");
        try {
          recordToolFailure({ agent: p.id, tool: String(rec.toolName ?? "tool"), args, error, model: p.model });
        } catch (e) {
          void dashLog("agent-host", `tool failure not recorded: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    case "tool_execution_start": {
      const summary = toolSummary(String(rec.toolName ?? "tool"), rec.args);
      if (rec.toolCallId) p.toolArgs.set(String(rec.toolCallId), summary);
      hooks.event(p.id, { kind: "activity", text: summary });
      return;
    }
    case "auto_retry_start":
      hooks.event(p.id, { kind: "notice", text: `Retrying: ${String(rec.errorMessage ?? "provider error")}`, level: "warning" });
      return;
    case "extension_error":
      hooks.event(p.id, { kind: "notice", text: `Extension error: ${String(rec.error ?? "")}`.slice(0, 300), level: "error" });
      return;
    case "agent_settled": {
      if (!p.running) return;
      p.running = false;
      hooks.event(p.id, { kind: "running", running: false });
      hooks.event(p.id, { kind: "activity", text: "" });
      const ms = Date.now() - p.startedAt;
      // Every turn that ended on a provider error goes in the failure log, retried or not.
      if (p.turnError) {
        try {
          recordToolFailure({ agent: p.id, tool: "turn", error: p.turnError, model: p.model });
        } catch {
          /* the log is best effort */
        }
      }
      if (p.turnError && STREAM_DROPPED.test(p.turnError) && p.streamRetries < STREAM_RETRIES) {
        // The work so far is in the session; ask the agent to carry on from there.
        p.streamRetries += 1;
        void dashLog("agent-host", `${p.id} stream dropped (${p.turnError.slice(0, 80)}); continue ${p.streamRetries}/${STREAM_RETRIES}`);
        hooks.event(p.id, { kind: "notice", text: "The model's connection dropped mid-reply; continuing where it left off.", level: "warning" });
        setTimeout(() => {
          void send(p, {
            type: "prompt",
            message:
              "Your last reply was cut off by a dropped connection to the model provider. Continue exactly where you left off; do not redo finished steps. If you were writing a large file, write it in parts: a skeleton first, then one section per edit, each under about 120 lines.",
          });
        }, 2000);
        return;
      }
      if (p.turnError && p.lastCaptainTs) {
        hooks.line(p.id, await appendChatError(p.id, p.turnError, p.lastCaptainTs));
        hooks.settled(p.id, { ok: false, ms, error: p.turnError, cost: p.turnCost, tokens: p.turnTokens, cacheRead: p.turnCacheRead, prompt: p.turnPrompt, model: p.model });
        const why = fallbackReason(p.turnError);
        if (why) {
          // Out of credits, key rejected, or the stream kept dropping after the retries:
          // stop, mark the primary failed for today (bin/launch then uses fallback_model),
          // and, the first time today, carry on with the work on the backup at once.
          const error = p.turnError;
          const first = await recordModelFailure(p.id, error);
          const what = why === "stream" ? "kept dropping its connection to the model" : why === "billing" ? "ran out of credits or quota" : "had its key refused";
          void dashLog("agent-host", `${p.id} ${what}; moving to its fallback model${first ? " and continuing" : " (already failed today: stopping)"}`);
          hooks.event(p.id, {
            kind: "notice",
            text: first ? `It ${what}; continuing on its backup model.` : `It ${what} on its backup model too; it stops here. Send a message to try again.`,
            level: "warning",
          });
          if (first) {
            try {
              notifyCaptain({ from: p.id, kind: "info", summary: `${p.id} ${what} and moved to its backup model for today.`, detail: error.slice(0, 300), ref: "Health, tool failures" });
            } catch {
              /* the notice is best effort */
            }
          }
          setTimeout(async () => {
            await stopHost(p.id);
            if (!first) return;
            await submitToHost(p.id, {
              ts: new Date().toISOString(),
              from: "router",
              kind: "chat",
              text: `Your last turn ended on a provider error (${error.slice(0, 160)}). You are now on your backup model. Continue exactly where you left off; do not redo finished steps.`,
            });
          }, 0);
        }
      } else {
        hooks.settled(p.id, { ok: true, ms, cost: p.turnCost, tokens: p.turnTokens, cacheRead: p.turnCacheRead, prompt: p.turnPrompt, model: p.model });
      }
      return;
    }
    case "extension_ui_request": {
      const method = String(rec.method ?? "");
      if (DIALOG_METHODS.has(method)) return onDialog(p, rec);
      if (method === "notify") {
        const level = rec.notifyType === "error" || rec.notifyType === "warning" ? rec.notifyType : "info";
        hooks.event(p.id, { kind: "notice", text: String(rec.message ?? ""), level });
      } else if (method === "setStatus") {
        hooks.event(p.id, {
          kind: "agent-status",
          key: String(rec.statusKey ?? "status"),
          text: typeof rec.statusText === "string" ? rec.statusText : null,
        });
      }
      return;
    }
  }
}

async function pump(p: AgentProc): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of p.proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(raw);
      } catch {
        // Not RPC: a launcher's own output before pi starts (a VM's setup prints "installed …", rsync lines).
        console.error(`[dashboard] agent-host ${p.id}: not RPC: ${raw.slice(0, 160)}`);
        continue;
      }
      try {
        await onRecord(p, rec);
      } catch (e) {
        console.error(`[dashboard] agent-host ${p.id}:`, e);
      }
    }
  }
}

async function drainStderr(p: AgentProc): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of p.proc.stderr) {
    p.stderrTail = (p.stderrTail + decoder.decode(chunk, { stream: true })).slice(-4000);
  }
}

/** Crew API credentials: token → the agent whose process holds it. */
const crewTokens = new Map<string, string>();

/** Who is calling the crew API, from the token only that agent's process was given. */
export function crewCaller(token: string): string | null {
  return (token && crewTokens.get(token)) || null;
}

function start(agentId: string, keys: Record<string, string>): AgentProc {
  const crewToken = crypto.randomUUID();
  crewTokens.set(crewToken, agentId);
  // On the ship host of the crewmate's voyage (lib/ship-host.ts); officers and idle ships run here.
  // Crewmates call back into the fleet node (extensions/crew.ts) and prove
  // who they are with FLEET_CREW_TOKEN, never with a name in the request.
  const ship = chatTarget(agentId)?.ship;
  const host = ship ? voyageHost(ship) : localHost;
  const proc = host.launchRpc(agentId, { ...keys, FLEET_DASHBOARD_URL: `http://127.0.0.1:${NODE_PORT}`, FLEET_CREW_TOKEN: crewToken }, { ship, worktree: ship ? voyageWorktree(ship) : null });
  const p: AgentProc = {
    id: agentId,
    proc,
    nextId: 1,
    pending: new Map(),
    running: false,
    startedAt: 0,
    lastActive: Date.now(),
    streamText: "",
    streamTimer: null,
    dialogs: new Map(),
    stderrTail: "",
    lastCaptainTs: null,
    turnError: null,
    toolArgs: new Map(),
    model: "",
    worktree: worktreeFor(agentId),
    streamRetries: 0,
    turnCost: 0,
    turnTokens: 0,
    turnCacheRead: 0,
    turnPrompt: 0,
  };
  procs.set(agentId, p);
  void dashLog("agent-host", `start ${agentId} pid=${proc.pid}`);
  void pump(p);
  void drainStderr(p);
  void proc.exited.then(async (code) => {
    crewTokens.delete(crewToken);
    if (procs.get(agentId) === p) procs.delete(agentId);
    for (const [, d] of p.dialogs) if (d.timer) clearTimeout(d.timer);
    for (const [, resolve] of p.pending) resolve({ success: false, error: "agent process exited" });
    p.pending.clear();
    await dashLog("agent-host", `exit ${agentId} code=${code}`);
    // The link to a remote host dropped (the laptop slept or went offline): away, not crashed.
    // Its session stays there; the next message (or the watchdog's nudge) starts it again.
    if (code === LINK_LOST) {
      hooks.event(agentId, { kind: "running", running: false });
      hooks.event(agentId, { kind: "stream", text: "" });
      hooks.event(agentId, { kind: "notice", text: `Lost the link to ${host.label} (asleep or offline): this crewmate is away${p.running ? " and its turn stopped" : ""}. It picks up from its session when ${host.label} is back.`, level: "warning" });
      if (p.running) hooks.settled(agentId, { ok: true, ms: Date.now() - p.startedAt, cost: 0, tokens: 0 });
      return;
    }
    const expected = code === 0 || code === 143 || code === null;
    // A dock returns the voyage worktree, and treehouse ends the processes inside it: that is
    // the voyage ending, not a crash (the lead that asked for the dock was mid-turn).
    if (code === 143 && p.running && p.worktree) {
      await Bun.sleep(1500); // the dock removes the worktree record right after the return
      if (worktreeFor(agentId) !== p.worktree) {
        hooks.event(agentId, { kind: "running", running: false });
        hooks.event(agentId, { kind: "stream", text: "" });
        hooks.event(agentId, { kind: "notice", text: "The voyage docked; this crewmate's turn ended with it.", level: "info" });
        hooks.settled(agentId, { ok: true, ms: Date.now() - p.startedAt, cost: 0, tokens: 0 });
        return;
      }
    }
    if (p.running || !expected) {
      const why = (p.stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `exit ${code}`).slice(0, 500);
      const reason = `${agentId} stopped${p.running ? " mid-task" : ""}: ${why}`;
      hooks.event(agentId, { kind: "running", running: false });
      hooks.event(agentId, { kind: "stream", text: "" });
      if (p.lastCaptainTs) hooks.line(agentId, await appendChatError(agentId, reason, p.lastCaptainTs));
      hooks.settled(agentId, { ok: false, ms: p.running ? Date.now() - p.startedAt : 0, error: reason, cost: 0, tokens: 0 });
    }
  });
  return p;
}

/** The open voyage's worktree for a crewmate's ship, or "" (bin/launch starts crewmates there). */
function worktreeFor(agentId: string): string {
  const ship = chatTarget(agentId)?.ship;
  return ship ? (voyageWorktree(ship)?.path ?? "") : "";
}

/** Hand a captain line to the agent's live session (starting it when needed). */
export async function submitToHost(agentId: string, line: ChatLine): Promise<void> {
  let p = procs.get(agentId);
  // A voyage started or docked since this crewmate launched: restart it in the right folder
  // (between turns only; the session carries over).
  if (p && !p.running && p.worktree !== worktreeFor(agentId)) {
    void dashLog("agent-host", `${agentId} working folder changed (voyage worktree); restarting`);
    await stopHost(agentId);
    p = undefined;
  }
  if (!p) {
    const keys = await agentKeyEnv();
    p = procs.get(agentId) ?? start(agentId, keys);
  }
  p.lastCaptainTs = line.ts;
  p.streamRetries = 0;
  p.lastActive = Date.now();
  // Always "steer": an idle agent starts a turn, a busy one reads it before its
  // next step. Deciding from p.running raced: messages sent in quick succession
  // ("Let's start a task", "for project", "test") reached a turn that had been
  // prompted but had not reported agent_start yet, and pi rejected them.
  const r = await send(p, { type: "prompt", message: line.text, streamingBehavior: "steer" });
  if (r.success && (r.data as { disposition?: string } | undefined)?.disposition === "queued") {
    hooks.event(agentId, { kind: "notice", text: "Sent while it works; it reads this before its next step.", level: "info" });
    return;
  }
  if (!r.success) {
    const error = String(r.error ?? "prompt rejected");
    if (/No API key found/i.test(error)) {
      // Launched while the secrets pipe was silent: this process will never have
      // the key. Stop it so the next message relaunches with fresh keys.
      await stopHost(agentId);
      void dashLog("agent-host", `${agentId} started without a provider key; stopped for relaunch`);
      hooks.line(agentId, await appendChatError(agentId, `${error.split("\n")[0]} The agent was restarted without its keys; send the message again.`, line.ts));
      return;
    }
    hooks.line(agentId, await appendChatError(agentId, error, line.ts));
  }
}

/** Answer a pending dialog. Returns false when it is no longer waiting. */
export async function answerDialog(
  agentId: string,
  dialogId: string,
  answer: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const p = procs.get(agentId);
  const d = p?.dialogs.get(dialogId);
  if (!p || !d) return { ok: false, error: "That question is no longer waiting for an answer." };
  p.dialogs.delete(dialogId);
  if (d.timer) clearTimeout(d.timer);
  p.lastActive = Date.now();
  let rec: Record<string, unknown>;
  let text: string;
  if (answer.cancelled) {
    rec = { type: "extension_ui_response", id: dialogId, cancelled: true };
    text = "Skipped";
  } else if (d.method === "confirm") {
    const yes = answer.confirmed ?? /^y(es)?$/i.test(String(answer.value ?? ""));
    rec = { type: "extension_ui_response", id: dialogId, confirmed: yes };
    text = yes ? "Yes" : "No";
  } else {
    // Send the option string exactly as offered; the asking tool maps it back.
    const value = String(answer.value ?? "").trim();
    if (!value) return { ok: false, error: "Empty answer." };
    rec = { type: "extension_ui_response", id: dialogId, value };
    text = value;
  }
  sendNoReply(p, rec);
  hooks.line(
    agentId,
    await appendChatLine(agentId, { ts: new Date().toISOString(), from: "captain", kind: "answer", text, ref: d.lineTs }),
  );
  return { ok: true };
}

export async function abortHost(agentId: string): Promise<boolean> {
  const p = procs.get(agentId);
  if (!p?.running) return false;
  await send(p, { type: "abort" });
  hooks.event(agentId, { kind: "notice", text: "Stopped. Send a message to continue.", level: "info" });
  return true;
}

/** Stop an agent's process (idle, or before its TUI opens on the same session). */
export async function stopHost(agentId: string): Promise<void> {
  const p = procs.get(agentId);
  if (!p) return;
  procs.delete(agentId);
  try {
    p.proc.kill("SIGTERM");
  } catch {
    /* gone */
  }
  await Promise.race([p.proc.exited, Bun.sleep(5000)]);
  try {
    p.proc.kill("SIGKILL");
  } catch {
    /* gone */
  }
}

export function startHostReaper(): void {
  setInterval(() => {
    const now = Date.now();
    for (const p of procs.values()) {
      if (!p.running && p.dialogs.size === 0 && now - p.lastActive > IDLE_MS) {
        void dashLog("agent-host", `idle stop ${p.id}`);
        void stopHost(p.id);
      }
    }
  }, 60_000);
}
