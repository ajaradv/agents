import { join } from "node:path";
import {
  appendAgentChat,
  appendChatError,
  appendChatLine,
  questionsText,
  type ChatLine,
  type ChatQuestion,
} from "./chat.ts";
import { agentKeyEnv } from "./fleet-env.ts";
import { dashLog } from "./log.ts";
import { PORT, ROOT } from "./paths.ts";

/**
 * Agent host: one long-lived `pi --mode rpc` process per agent with
 * `runtime: rpc` in agent.yaml (started through `bin/launch rpc <id>`).
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
  settled: (agentId: string, outcome: { ok: boolean; ms: number; error?: string; cost: number; tokens: number }) => void;
};

const IDLE_MS = 20 * 60_000;
const STREAM_THROTTLE_MS = 120;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
// A provider stream cut off mid-response. Pi only retries errors it recognises
// as network failures; a proxy (e.g. the Junie bridge) that ends the response
// mid-event surfaces as a parse error instead.
const STREAM_DROPPED = /Could not parse .*SSE event|Unexpected end of JSON input|stream (ended|closed|terminated)|terminated|ECONNRESET|socket hang up/i;
const STREAM_RETRIES = 2;
const BILLING_ERROR = /\b402\b|billing|insufficient|quota|out of credits|requires more credits|balance/i;

type Dialog = { method: string; lineTs: string; timer?: ReturnType<typeof setTimeout> };

type AgentProc = {
  id: string;
  proc: ReturnType<typeof Bun.spawn>;
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
  /** Continues sent for the current captain line after a dropped stream. */
  streamRetries: number;
  /** This turn's billed cost and tokens, summed from Pi's assistant message usage. */
  turnCost: number;
  turnTokens: number;
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

function send(p: AgentProc, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `dash-${p.nextId++}`;
  return new Promise((resolve) => {
    p.pending.set(id, resolve);
    try {
      const sink = p.proc.stdin as import("bun").FileSink;
      sink.write(JSON.stringify({ ...cmd, id }) + "\n");
      sink.flush();
    } catch (e) {
      p.pending.delete(id);
      resolve({ success: false, error: e instanceof Error ? e.message : "write failed" });
    }
  });
}

function sendNoReply(p: AgentProc, rec: Record<string, unknown>): void {
  try {
    const sink = p.proc.stdin as import("bun").FileSink;
    sink.write(JSON.stringify(rec) + "\n");
    sink.flush();
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
      }
      p.streamText = "";
      hooks.event(p.id, { kind: "stream", text: "" });
      if (msg.stopReason === "error" && msg.errorMessage) p.turnError = msg.errorMessage;
      const text = assistantText(msg);
      if (text) hooks.line(p.id, await appendAgentChat(p.id, p.id, text));
      return;
    }
    case "tool_execution_start":
      hooks.event(p.id, { kind: "activity", text: toolSummary(String(rec.toolName ?? "tool"), rec.args) });
      return;
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
        hooks.settled(p.id, { ok: false, ms, error: p.turnError, cost: p.turnCost, tokens: p.turnTokens });
        if (BILLING_ERROR.test(p.turnError)) {
          // Out of credits: the next message relaunches through bin/launch, which
          // moves a Junie agent to its fallback_model once Junie credits are gone.
          void dashLog("agent-host", `${p.id} hit a billing error; stopped so the next message relaunches`);
          setTimeout(() => void stopHost(p.id), 0);
        }
      } else {
        hooks.settled(p.id, { ok: true, ms, cost: p.turnCost, tokens: p.turnTokens });
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
  for await (const chunk of p.proc.stdout as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      try {
        await onRecord(p, JSON.parse(raw));
      } catch (e) {
        console.error(`[dashboard] agent-host ${p.id}:`, e);
      }
    }
  }
}

async function drainStderr(p: AgentProc): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of p.proc.stderr as ReadableStream<Uint8Array>) {
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
  const proc = Bun.spawn(["python3", join(ROOT, "bin/launch"), "rpc", agentId], {
    cwd: ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Crewmates call back into this dashboard (extensions/crew.ts) and prove
    // who they are with FLEET_CREW_TOKEN, never with a name in the request.
    env: { ...process.env, ...keys, FLEET_DASHBOARD_URL: `http://127.0.0.1:${PORT}`, FLEET_CREW_TOKEN: crewToken },
  });
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
    streamRetries: 0,
    turnCost: 0,
    turnTokens: 0,
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
    const expected = code === 0 || code === 143 || code === null;
    if (p.running || !expected) {
      const why = (p.stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" ") || `exit ${code}`).slice(0, 500);
      const reason = `${agentId} stopped${p.running ? " mid-task" : ""}: ${why}`;
      hooks.event(agentId, { kind: "running", running: false });
      hooks.event(agentId, { kind: "stream", text: "" });
      if (p.lastCaptainTs) hooks.line(agentId, await appendChatError(agentId, reason, p.lastCaptainTs));
      hooks.settled(agentId, { ok: false, ms: p.running ? Date.now() - p.startedAt : 0, error: reason });
    }
  });
  return p;
}

/** Hand a captain line to the agent's live session (starting it when needed). */
export async function submitToHost(agentId: string, line: ChatLine): Promise<void> {
  let p = procs.get(agentId);
  if (!p) {
    const keys = await agentKeyEnv();
    p = procs.get(agentId) ?? start(agentId, keys);
  }
  p.lastCaptainTs = line.ts;
  p.streamRetries = 0;
  p.lastActive = Date.now();
  if (p.running) {
    const r = await send(p, { type: "prompt", message: line.text, streamingBehavior: "steer" });
    if (r.success) {
      hooks.event(agentId, { kind: "notice", text: "Sent while it works; it reads this before its next step.", level: "info" });
      return;
    }
    hooks.line(agentId, await appendChatError(agentId, String(r.error ?? "steer failed"), line.ts));
    return;
  }
  const r = await send(p, { type: "prompt", message: line.text });
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
