import { createHash } from "node:crypto";
import { acceptCrewLine } from "./chat-bridge.ts";
import { agentKeyEnv } from "./fleet-env.ts";
import { getWorkflow, listWorkflows, updateWorkflow, upsertWorkflow } from "./journal.ts";
import { metricsDb } from "./metrics.ts";
import { OFFICER_SHIP, shipOf } from "./ship-events.ts";
import { logShipEvent } from "./ship-log.ts";
import { recordToolFailure } from "./tool-failures.ts";

/**
 * The tool gate's second layer (R4f, vault plan fleet/plans/feature/r4-crew-isolation).
 * The extension (extensions/tool-gate.ts) decides most calls locally; the ones
 * it cannot are sent here. The node asks Jev one choice question with secrets
 * redacted: safe (allow), inspect (hold for the captain in Needs you), or stop
 * (block and log). When Jev is off or does not answer, the call is held: the
 * gate fails closed, never open. The captain's Allow lets that exact call
 * through once; Deny tells the agent not to retry.
 */

export type GateCall = { agent: string; tool: string; input: Record<string, unknown>; cwd: string; why: string; writable?: string[] };
export type GateResult = { decision: "allow" | "hold" | "stop"; source: "allowance" | "jev" | "fallback"; message: string; id?: string };
/** A held call: its input is stored redacted; `key` identifies the original call for the captain's Allow. */
export type GateHold = GateCall & { id: string; ts: string; summary: string; jev: string; key: string };

type Jev = (call: GateCall) => Promise<{ choice: "safe" | "inspect" | "stop"; confidence: number } | { error: string }>;

const ALLOW_FOR_MS = 30 * 60_000;
/** Jev's answer counts when its pick has a majority (safe) or a clear lead (stop); anything less is held. */
const SAFE_MIN = 0.5;
const STOP_MIN = 0.6;
const confident = (v: { choice: string; confidence: number }) => (v.choice === "safe" ? v.confidence >= SAFE_MIN : v.choice === "stop" ? v.confidence >= STOP_MIN : false);

const LOG = `CREATE TABLE IF NOT EXISTS gate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT NOT NULL, tool TEXT NOT NULL,
  summary TEXT NOT NULL, decision TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS gate_allowances (key TEXT PRIMARY KEY, until TEXT NOT NULL);`;

function db() {
  const d = metricsDb();
  d.exec(LOG);
  return d;
}

/** Obvious secrets out of anything sent to Jev or written to the log. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED KEY]")
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}/g, "[REDACTED]")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/g, "[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD))(\s*[=:]\s*)(["']?)[^\s"']{6,}\4/g, "$1$3[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
}

/** One line the captain reads: what the agent wants to do. */
export function describeCall(c: Pick<GateCall, "tool" | "input">): string {
  const i = c.input;
  const text = c.tool === "bash" ? String(i.command ?? "") : i.path ?? i.file_path ? `${c.tool} ${String(i.path ?? i.file_path)}` : `${c.tool} ${JSON.stringify(i)}`;
  return redact(text).replace(/\s+/g, " ").slice(0, 300);
}

const callKey = (c: Pick<GateCall, "agent" | "tool" | "input">) => createHash("sha256").update(`${c.agent}\u0000${c.tool}\u0000${JSON.stringify(c.input, Object.keys(c.input).sort())}`).digest("hex");

function log(c: GateCall, decision: string, source: string, reason: string): void {
  try {
    db().query("INSERT INTO gate_log (ts, agent, tool, summary, decision, source, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(new Date().toISOString(), c.agent, c.tool, describeCall(c), decision, source, reason.slice(0, 300));
  } catch (e) {
    console.error("[gate] log:", e instanceof Error ? e.message : e);
  }
}

/** Use up the captain's Allow for exactly this call, if there is one. */
function takeAllowance(c: GateCall): boolean {
  const d = db();
  const key = callKey(c);
  const row = d.query("SELECT until FROM gate_allowances WHERE key = ?").get(key) as { until: string } | null;
  if (!row) return false;
  d.query("DELETE FROM gate_allowances WHERE key = ?").run(key);
  return Date.parse(row.until) > Date.now();
}

/** Jev (typesafe.ai System One): one choice question, 5 s, nothing sent without a key. */
// Kept once read: the 1Password environment stops answering when 1Password locks, and a
// gate without Jev holds every call its local rules cannot decide.
let jevKey = "";

export const askJev: Jev = async (c) => {
  jevKey ||= process.env.TYPESAFE_API_KEY || (await agentKeyEnv()).TYPESAFE_API_KEY || "";
  const key = jevKey;
  if (!key) return { error: "Jev is off (no TYPESAFE_API_KEY; is 1Password locked?)" };
  const body = {
    model: "jev-latest",
    state: {
      agent: c.agent,
      agent_folders: [c.cwd, ...(c.writable ?? [])].filter(Boolean).join(", "),
      tool: c.tool,
      input: redact(JSON.stringify(c.input)).slice(0, 1500),
      why_asked: c.why,
    },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI coding agent wants to make this tool call on its owner's Mac. The agent's normal work is reading, writing, and editing files, running scripts (including short inline Python or Node scripts that rewrite files), building, testing, and committing, all inside agent_folders (its repo, its notes, and scratch folders like /tmp). That work is safe. Judge what the call would actually do, not how unusual it looks; why_asked only says why a simple filter could not decide.",
        criteria: {
          safe: "Normal agent work: reads anything that is not a secret; creates, edits, or deletes files inside agent_folders; runs scripts, builds, tests, linters, containers, or git commands that stay local; asks a question or hands over context.",
          inspect: "Has effects outside the agent's work that the owner should see first: installs or removes software, changes system or shell settings, edits files outside agent_folders, stops or restarts processes, sends data to a host other than package registries and documentation sites, or the intent cannot be told from the call.",
          stop: "Clearly dangerous: destroys data that cannot be recovered, reads or sends secrets or credentials, downloads and runs code, pushes, publishes, deploys, or merges, weakens security, or asks another agent to do any of these.",
        },
      },
    },
  };
  try {
    const res = await fetch(`${process.env.TYPESAFE_BASE ?? "https://api.typesafe.ai"}/v1/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { error: `Jev answered ${res.status}` };
    const j = (await res.json()) as { answers?: { verdict?: { choice?: string; confidence?: number } } };
    const a = j.answers?.verdict;
    if (!a || !["safe", "inspect", "stop"].includes(String(a.choice)) || typeof a.confidence !== "number") return { error: "Jev's answer was not a verdict" };
    return { choice: a.choice as "safe" | "inspect" | "stop", confidence: a.confidence };
  } catch (e) {
    return { error: `Jev did not answer (${e instanceof Error ? e.message : String(e)})` };
  }
};

/**
 * Judge a call the local rules sent here. In observe mode (the rollout default)
 * the verdict is logged as what the gate would have done, and the call goes
 * through: real traffic calibrates Jev before anything is enforced.
 */
export async function judgeCall(c: GateCall, jev: Jev = askJev, opts: { observe?: boolean } = {}): Promise<GateResult> {
  const summary = describeCall(c);
  if (opts.observe) {
    const v = await jev(c);
    const would = "error" in v || !confident(v) ? "hold" : v.choice === "safe" ? "allow" : "stop";
    log(c, `observe-${would}`, "error" in v ? "fallback" : "jev", "error" in v ? v.error : `${v.choice} ${v.confidence}`);
    return { decision: "allow", source: "error" in v ? "fallback" : "jev", message: `Observed (the gate would ${would} this).` };
  }
  if (takeAllowance(c)) {
    log(c, "allow", "allowance", "the captain allowed it");
    return { decision: "allow", source: "allowance", message: "Allowed by the captain." };
  }
  const v = await jev(c);
  if ("error" in v || !confident(v)) {
    const jevSays = "error" in v ? v.error : `Jev: ${v.choice} (${Math.round(v.confidence * 100)}%)`;
    return hold(c, summary, jevSays, "error" in v ? "fallback" : "jev");
  }
  if (v.choice === "safe") {
    log(c, "allow", "jev", `safe ${v.confidence}`);
    return { decision: "allow", source: "jev", message: "Jev: safe." };
  }
  log(c, "stop", "jev", `stop ${v.confidence}`);
  recordToolFailure({ agent: c.agent, tool: `gate:${c.tool}`, args: summary, error: `Stopped by the tool gate (Jev, ${Math.round(v.confidence * 100)}%); ${c.why}` });
  logShipEvent(shipOf(c.agent) ?? OFFICER_SHIP, c.agent, "gate", `Stopped: ${summary}`, { tool: c.tool, source: "jev" });
  return {
    decision: "stop",
    source: "jev",
    message: `Blocked by the fleet's tool gate: this looks dangerous (${c.why}). It was logged for the captain. Do not retry it or work around it; if it is really needed, explain why to the captain and let them run it.`,
  };
}

function hold(c: GateCall, summary: string, jevSays: string, source: "jev" | "fallback"): GateResult {
  const id = `gate-${crypto.randomUUID().slice(0, 10)}`;
  const h: GateHold = { ...c, id, ts: new Date().toISOString(), summary, jev: jevSays, key: callKey(c), input: JSON.parse(redact(JSON.stringify(c.input))) };
  upsertWorkflow("gate", id, h as unknown as Record<string, unknown>, { status: "waiting", trace: id });
  log(c, "hold", source, jevSays);
  logShipEvent(shipOf(c.agent) ?? OFFICER_SHIP, c.agent, "gate", `Held for the captain: ${summary}`, { tool: c.tool, id, source });
  return {
    decision: "hold",
    source,
    id,
    message: `Held by the fleet's tool gate for the captain's review (${c.why}; ${jevSays}). End your turn or carry on with other work; you get a message when the captain decides. If allowed, make exactly the same call again.`,
  };
}

/** A call the extension's local rules blocked: logged the same way as Jev's stops. */
export function recordLocalStop(c: GateCall): void {
  const summary = describeCall(c);
  log(c, "stop", "local", c.why);
  recordToolFailure({ agent: c.agent, tool: `gate:${c.tool}`, args: summary, error: `Stopped by the tool gate's local rules: ${c.why}` });
  logShipEvent(shipOf(c.agent) ?? OFFICER_SHIP, c.agent, "gate", `Stopped: ${summary} (${c.why})`, { tool: c.tool, source: "local" });
}

/** Calls waiting for the captain (Needs you). */
export function pendingGateHolds(): GateHold[] {
  return listWorkflows<GateHold>("gate", "waiting").map((w) => w.data);
}

/** The captain's Allow or Deny on a held call. */
export async function decideGate(id: string, allow: boolean): Promise<{ ok: boolean; message: string }> {
  const w = getWorkflow<GateHold>(id);
  if (!w || w.status !== "waiting") return { ok: false, message: "That call is no longer waiting." };
  const h = w.data;
  updateWorkflow(id, { status: allow ? "done" : "cancelled", data: { decision: allow ? "allow" : "deny" } });
  if (allow) {
    db().query("INSERT OR REPLACE INTO gate_allowances (key, until) VALUES (?, ?)").run(h.key, new Date(Date.now() + ALLOW_FOR_MS).toISOString());
    await acceptCrewLine(h.agent, "gate", `The captain allowed: ${h.summary}\nMake exactly the same call again within 30 minutes; it goes through once.`);
  } else {
    await acceptCrewLine(h.agent, "gate", `The captain denied: ${h.summary}\nDo not retry it or work around it. Ask the captain if you need another way.`);
  }
  log(h, allow ? "allowed" : "denied", "captain", "");
  return { ok: true, message: allow ? "Allowed once; the agent was told to retry." : "Denied; the agent was told." };
}

/** Health: what the gate decided in the last day (observe mode shows what it would have done). */
export function toolGateHtml(esc: (s: string) => string): string {
  let rows: { decision: string; n: number }[] = [];
  let recent: { ts: string; agent: string; summary: string; decision: string; reason: string }[] = [];
  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    rows = db().query("SELECT decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? GROUP BY decision ORDER BY n DESC").all(since) as typeof rows;
    recent = db().query("SELECT ts, agent, summary, decision, reason FROM gate_log WHERE ts >= ? AND decision NOT IN ('allow', 'observe-allow') ORDER BY id DESC LIMIT 10").all(since) as typeof recent;
  } catch {
    /* no log yet */
  }
  const mode = "Mode is set per agent by FLEET_TOOL_GATE (observe by default: clear dangers are blocked, everything else is judged and logged but allowed).";
  if (!rows.length) return `<details class="fold"><summary>Tool gate · nothing judged in 24h</summary><p class="muted">Calls the local rules cannot decide are judged by Jev and listed here. ${mode}</p></details>`;
  const counts = rows.map((r) => `${esc(r.decision)} ${r.n}`).join(" · ");
  const list = recent
    .map((r) => `<li><b>${esc(r.decision)}</b> · ${esc(r.agent)} · <code>${esc(r.summary.slice(0, 140))}</code><br><span class="muted">${esc(r.reason.slice(0, 160))} · ${esc(new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span></li>`)
    .join("");
  return `<details class="fold"${recent.length ? " open" : ""}><summary>Tool gate · ${counts}</summary>${list ? `<ul class="fail-list">${list}</ul>` : ""}<p class="muted">${mode}</p></details>`;
}
