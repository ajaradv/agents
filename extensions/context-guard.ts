/**
 * context-guard: compact long-lived sessions early, at a calm moment, instead
 * of letting them run to the edge of the window (where Pi's own threshold
 * compacts mid-task and a big system prompt can make it compact again minutes
 * later).
 *
 * After each run settles, if context use is at or above FLEET_COMPACT_AT
 * percent (default 65), the session is compacted. With
 * FLEET_STOW_BEFORE_COMPACT=1 (Firstmate) the agent is first asked to run its
 * stow routine, so open work records and durable knowledge are on disk before
 * the summary replaces the history; the compaction follows when that settles.
 *
 * It compacts again only after context has grown by FLEET_COMPACT_GROWTH
 * percent of the window (default 15) since the last time, so a session whose
 * floor (system prompt + kept recent turns) sits above the threshold cannot
 * loop. bin/launch loads this for every assistant; Firstmate lists it.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const AT = Math.min(95, Math.max(20, Number(process.env.FLEET_COMPACT_AT) || 65));
const GROWTH = Math.min(50, Math.max(5, Number(process.env.FLEET_COMPACT_GROWTH) || 15));
const STOW_FIRST = process.env.FLEET_STOW_BEFORE_COMPACT === "1";
const FOCUS = process.env.FLEET_COMPACT_FOCUS ?? "";

export default function (pi: ExtensionAPI) {
  let stage: "idle" | "stowing" | "compacting" = "idle";
  /** Context percent right after the last compaction we triggered (its new floor). */
  let floor = 0;

  const compact = (ctx: ExtensionContext, percent: number) => {
    stage = "compacting";
    if (ctx.hasUI) ctx.ui.notify(`Context at ${Math.round(percent)}%: compacting now, between tasks.`, "info");
    ctx.compact({
      ...(FOCUS ? { customInstructions: FOCUS } : {}),
      onComplete: () => {
        stage = "idle";
        const after = ctx.getContextUsage()?.percent;
        // Unknown right after compaction: assume a floor of about a quarter of the threshold.
        floor = typeof after === "number" ? after : AT / 4;
      },
      onError: (e) => {
        stage = "idle";
        floor = percent; // do not retry until it grows
        if (ctx.hasUI) ctx.ui.notify(`Early compaction failed: ${e.message}`, "warning");
      },
    });
  };

  pi.on("agent_settled", async (_event, ctx) => {
    if (stage === "compacting") return;
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    if (typeof percent !== "number") return;
    if (stage === "stowing") {
      // The stow run just finished: knowledge is on disk, compact now.
      compact(ctx, percent);
      return;
    }
    if (percent < AT || percent < floor + GROWTH) return;
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
    compact(ctx, percent);
  });
}
