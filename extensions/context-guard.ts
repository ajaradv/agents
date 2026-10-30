/**
 * context-guard: compact long-lived sessions while they are idle and the
 * provider's prompt cache is still warm, instead of letting them run to the
 * edge of the window (where Pi's own threshold compacts mid-task, and a big
 * system prompt can make it compact again minutes later).
 *
 * - Idle: once context is at or above FLEET_COMPACT_IDLE_AT percent (default
 *   40), the session is compacted FLEET_COMPACT_IDLE_SECS (default 150) after
 *   a run settles, unless a new run starts first. 150s sits inside the
 *   shortest common cache lifetime (5 minutes), so the summary request reads
 *   the history from cache: fast and cheap.
 * - Now: at or above FLEET_COMPACT_AT percent (default 65) it compacts right
 *   after the run settles.
 * - Stow first: with FLEET_STOW_BEFORE_COMPACT=1 (Firstmate) the agent is first
 *   asked to run its stow routine, so open work records and durable knowledge
 *   are on disk; the compaction follows when that settles.
 * - Handoff file: after every compaction (ours or Pi's), the summary is written
 *   to $FLEET_INBOX/<agent>/memory/state.md, the starting point for a new
 *   session (file-based memory; the session is not the only record). The file
 *   is short-term only: at most 1.5 KB, cut at a line; state.full.md beside it
 *   keeps the whole summary.
 *
 * It compacts again only after context has grown by FLEET_COMPACT_GROWTH
 * percent of the window (default 15) since the last time, so a session whose
 * floor (system prompt + kept recent turns) sits high cannot loop.
 * - Moved on (Jev, the compaction advisor): percent lines fire late on a large
 *   window (40% of 1M tokens is 400k). Below them, once context holds
 *   FLEET_COMPACT_JEV_MIN_TOKENS (default 60000) and the session has had two
 *   requests, a settled run asks the node whether the work has moved on (a new
 *   task, or a finished unit that needs little history; dashboard/lib/
 *   compaction-advisor.ts). FLEET_COMPACT_JEV: observe (default) only logs the
 *   verdict for measurement; on compacts while idle, with Jev's pick of where
 *   the live work starts in the summary instructions; off skips it.
 * bin/launch loads this for every assistant; Firstmate lists it.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number(v) || d));
const AT = clamp(process.env.FLEET_COMPACT_AT, 20, 95, 65);
const IDLE_AT = clamp(process.env.FLEET_COMPACT_IDLE_AT, 10, 95, 40);
const IDLE_MS = clamp(process.env.FLEET_COMPACT_IDLE_SECS, 15, 1800, 150) * 1000;
const GROWTH = clamp(process.env.FLEET_COMPACT_GROWTH, 5, 50, 15);
const STOW_FIRST = process.env.FLEET_STOW_BEFORE_COMPACT === "1";
const FOCUS = process.env.FLEET_COMPACT_FOCUS ?? "";
const JEV_MODE = ["off", "observe", "on"].includes(process.env.FLEET_COMPACT_JEV ?? "") ? (process.env.FLEET_COMPACT_JEV as string) : "observe";
const JEV_MIN_TOKENS = clamp(process.env.FLEET_COMPACT_JEV_MIN_TOKENS, 5000, 2_000_000, 60_000);
const NODE = (process.env.FLEET_DASHBOARD_URL ?? "").replace(/\/$/, "");
const TOKEN = process.env.FLEET_CREW_TOKEN ?? "";

const textOf = (m: unknown): string => {
  const c = (m as { content?: unknown })?.content;
  return (Array.isArray(c) ? c.filter((x) => (x as { type?: string })?.type === "text").map((x) => (x as { text?: string }).text ?? "").join("\n") : String(c ?? "")).trim();
};

async function askNode<T>(path: string, body: unknown): Promise<T | null> {
  if (!NODE || !TOKEN) return null;
  try {
    const res = await fetch(`${NODE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-fleet-crew-token": TOKEN }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Where an agent's compaction handoff lives, or null outside the fleet. */
export function stateFile(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.FLEET_AGENT_ID;
  const inbox = env.FLEET_INBOX;
  return id && inbox && /^[a-z][a-z0-9_-]{0,63}$/.test(id) ? join(inbox.replace(/^~/, env.HOME ?? ""), id, "memory", "state.md") : null;
}

export const STATE_CAP = 1500;
const STATE_CUT = "[cut at 1.5 KB; the session summary has the rest]";

/** The handoff file's text: a header and the summary, cut at a line boundary so the whole stays within STATE_CAP bytes. */
export function stateText(summary: string, reason: string, now = new Date()): string {
  const head = `# State handoff\n\nWritten ${now.toISOString()} after a ${reason} compaction. The session's summary of everything before it:\n\n`;
  const body = summary.trim();
  const whole = `${head}${body}\n`;
  if (Buffer.byteLength(whole) <= STATE_CAP) return whole;
  const room = STATE_CAP - Buffer.byteLength(head) - Buffer.byteLength(`\n${STATE_CUT}\n`);
  // Whole lines that fit (a single over-long line is cut mid-line rather than dropped).
  const kept: string[] = [];
  let used = 0;
  for (const line of body.split("\n")) {
    const n = Buffer.byteLength(line) + 1;
    if (used + n > room) break;
    kept.push(line);
    used += n;
  }
  const text = kept.length ? kept.join("\n") : Buffer.from(body).subarray(0, Math.max(0, room)).toString("utf8").replace(/\uFFFD+$/, "");
  return `${head}${text.trimEnd()}\n${STATE_CUT}\n`;
}

/** Which action a settled run calls for. */
export function decide(percent: number, floor: number): "now" | "idle" | "none" {
  if (percent < floor + GROWTH) return "none";
  if (percent >= AT) return "now";
  if (percent >= IDLE_AT) return "idle";
  return "none";
}

export default function (pi: ExtensionAPI) {
  let stage: "idle" | "stowing" | "compacting" = "idle";
  /** Context percent right after the last compaction (its new floor). */
  let floor = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelIdle = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** What the advisor sees: the requests so far, and the last turn's text and tools. */
  const requests: string[] = [];
  let lastSummary = "";
  let lastReply = "";
  let lastTools: string[] = [];
  /** Jev's pick of where the live work starts, for the next compaction (on mode only). */
  let cutInstructions = "";

  const compact = (ctx: ExtensionContext, percent: number, why: string) => {
    stage = "compacting";
    if (ctx.hasUI) ctx.ui.notify(`Context at ${Math.round(percent)}%: compacting ${why}.`, "info");
    const instructions = [FOCUS, cutInstructions].filter(Boolean).join("\n");
    cutInstructions = "";
    ctx.compact({
      ...(instructions ? { customInstructions: instructions } : {}),
      onComplete: () => {
        stage = "idle";
        const after = ctx.getContextUsage()?.percent;
        floor = typeof after === "number" ? after : IDLE_AT / 4;
      },
      onError: (e) => {
        stage = "idle";
        floor = percent; // do not retry until it grows
        if (ctx.hasUI) ctx.ui.notify(`Compaction did not run: ${e.message}`, "warning");
      },
    });
  };

  /** Stow first when configured, else compact. */
  const start = (ctx: ExtensionContext, percent: number, why: string) => {
    if (STOW_FIRST) {
      stage = "stowing";
      if (ctx.hasUI) ctx.ui.notify(`Context at ${Math.round(percent)}%: stowing, then compacting.`, "info");
      pi.sendUserMessage(
        `Housekeeping (automatic, not from the captain): your context is ${Math.round(percent)}% full and will be compacted after this. ` +
          "First run your stow routine now, exactly as /stow does (load the stow skill): persist the open work records this session holds and any durable knowledge not yet on disk. " +
          "Do not start other work. Reply with one line when done: stowed.",
      );
      return;
    }
    compact(ctx, percent, why);
  };

  pi.on("agent_start", async () => cancelIdle());

  pi.on("message_end", async (event) => {
    const m = (event as { message?: { role?: string } }).message;
    if (m?.role === "user") requests.push(textOf(m).slice(0, 600));
    else if (m?.role === "assistant") lastReply = textOf(m).slice(0, 600);
  });
  pi.on("tool_execution_end", async (event) => {
    lastTools = [...lastTools.slice(-19), String((event as { toolName?: string }).toolName ?? "")];
  });

  /** Below the percent lines: has the work moved on? (observe logs only; on schedules an idle compaction) */
  const askAdvisor = async (ctx: ExtensionContext, percent: number) => {
    const tokens = ctx.getContextUsage()?.tokens ?? 0;
    if (JEV_MODE === "off" || tokens < JEV_MIN_TOKENS || requests.length < 2) return;
    const previous = [...requests.slice(0, -1).slice(-12).map((r) => r.slice(0, 200)), lastSummary ? `Summary so far: ${lastSummary.slice(0, 400)}` : ""].filter(Boolean).join("\n");
    const state = { current_request: requests.at(-1) ?? "", previous_work: previous, recent_turn: lastReply || `(tool calls only: ${lastTools.join(", ") || "none"})`, tools_this_turn: lastTools };
    lastTools = [];
    const r = await askNode<{ ok: boolean; verdict?: { movedOn: boolean; reason: string } }>("/api/compaction/advise", { mode: JEV_MODE, tokens, percent, state });
    if (JEV_MODE !== "on" || !r?.verdict?.movedOn || stage !== "idle") return;
    const cut = await askNode<{ instructions: string | null }>("/api/compaction/cut", { requests });
    cutInstructions = cut?.instructions ?? "";
    timer = setTimeout(() => {
      timer = null;
      if (stage !== "idle") return;
      start(ctx, ctx.getContextUsage()?.percent ?? percent, `while idle: ${r.verdict!.reason}`);
    }, IDLE_MS);
  };

  pi.on("agent_settled", async (_event, ctx) => {
    cancelIdle();
    if (stage === "compacting") return;
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number") return;
    if (stage === "stowing") {
      compact(ctx, percent, "after stowing");
      return;
    }
    const action = decide(percent, floor);
    if (action === "none") {
      void askAdvisor(ctx, percent);
      return;
    }
    if (action === "now") start(ctx, percent, "now, between tasks");
    else if (action === "idle") {
      timer = setTimeout(() => {
        timer = null;
        if (stage !== "idle") return;
        const p = ctx.getContextUsage()?.percent ?? percent;
        start(ctx, p, "while idle, cache still warm");
      }, IDLE_MS);
    }
  });

  // Every compaction, ours or Pi's: keep the summary as a file the next session can start from.
  pi.on("session_compact", async (event) => {
    const path = stateFile();
    const summary = (event.compactionEntry as { summary?: string } | undefined)?.summary;
    if (summary) lastSummary = summary;
    if (!path || !summary) return;
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      // The whole summary beside it, so the cut loses nothing.
      writeFileSync(path.replace(/state\.md$/, "state.full.md"), `${summary.trim()}\n`, "utf8");
      writeFileSync(path + ".tmp", stateText(summary, event.reason), "utf8");
      renameSync(path + ".tmp", path);
    } catch {
      /* the session still has the summary */
    }
  });
}
