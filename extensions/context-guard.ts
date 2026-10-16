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
 *   session (file-based memory; the session is not the only record).
 *
 * It compacts again only after context has grown by FLEET_COMPACT_GROWTH
 * percent of the window (default 15) since the last time, so a session whose
 * floor (system prompt + kept recent turns) sits high cannot loop.
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

/** Where an agent's compaction handoff lives, or null outside the fleet. */
export function stateFile(env: Record<string, string | undefined> = process.env): string | null {
  const id = env.FLEET_AGENT_ID;
  const inbox = env.FLEET_INBOX;
  return id && inbox && /^[a-z][a-z0-9_-]{0,63}$/.test(id) ? join(inbox.replace(/^~/, env.HOME ?? ""), id, "memory", "state.md") : null;
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

  const compact = (ctx: ExtensionContext, percent: number, why: string) => {
    stage = "compacting";
    if (ctx.hasUI) ctx.ui.notify(`Context at ${Math.round(percent)}%: compacting ${why}.`, "info");
    ctx.compact({
      ...(FOCUS ? { customInstructions: FOCUS } : {}),
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
    if (!path || !summary) return;
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      const text = `# State handoff\n\nWritten ${new Date().toISOString()} after a ${event.reason} compaction. The session's summary of everything before it:\n\n${summary.trim()}\n`;
      writeFileSync(path + ".tmp", text, "utf8");
      renameSync(path + ".tmp", path);
    } catch {
      /* the session still has the summary */
    }
  });
}
