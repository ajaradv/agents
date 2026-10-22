/**
 * The stalled-voyage watchdog (ported from Firstmate's stale-worker supervision;
 * vault firstmate-deep-dive R3). Nothing used to act on a voyage that went
 * quiet: phase 2 sat nine hours after an empty `look`, phase 3 two days after a
 * budget refusal, both shown on the chart as becalmed and seen by nobody.
 *
 * A ship becalmed (under sail, nobody running, no turns, tools, or task
 * updates for 20 minutes; lib/voyage-progress.ts) for NUDGE_AFTER_MS more gets
 * one nudge to its lead: dock if every task is done, otherwise find the stuck
 * crewmate. Still becalmed TELL_AFTER_MS after the nudge, the captain gets one
 * notice. Any activity resets it. Pure decisions here; the dashboard runs it
 * (runWatchdog): the nudge is a line on the lead's bus, which the event router
 * turns into a turn.
 */

export const NUDGE_AFTER_MS = 10 * 60_000;
export const TELL_AFTER_MS = 30 * 60_000;

export type WatchedShip = {
  id: string;
  condition: string;
  voyage: { file: string; label: string } | null;
  tasks: { id: number; title: string; status: string }[];
  /** The ship's lead can be messaged (a lead is aboard). */
  hasLead: boolean;
};

type Watch = { voyage: string; since: number; nudgedAt?: number; told?: boolean };
export type WatchState = Map<string, Watch>;

export type WatchAction =
  | { kind: "nudge"; ship: string; to: string; text: string }
  | { kind: "tell"; ship: string; summary: string; detail: string };

function openTasks(s: WatchedShip) {
  return s.tasks.filter((t) => t.status !== "done");
}

/** The nudge, short enough for the event router's one-line summary (it keeps 200 characters). */
export function nudgeText(s: WatchedShip, idleMin: number): string {
  const open = openTasks(s);
  if (!open.length) return `No activity for ~${idleMin} min and all ${s.tasks.length} tasks are done: re-check what is unverified, then ask to dock (voyage_dock), or tell the captain what blocks it.`.slice(0, 200);
  const list = open.slice(0, 3).map((t) => `#${t.id} (${t.status})`).join(", ");
  return `No activity for ~${idleMin} min; open: ${list}. Find who is stuck (voyage_status), re-send or reassign, or tell the captain what blocks the voyage.`.slice(0, 200);
}

/** One pass: what to do now for each ship, given what was seen before (mutates `state`). */
export function watchdogStep(ships: WatchedShip[], state: WatchState, now = Date.now()): WatchAction[] {
  const actions: WatchAction[] = [];
  const seen = new Set<string>();
  for (const s of ships) {
    seen.add(s.id);
    if (s.condition !== "becalmed" || !s.voyage) {
      state.delete(s.id);
      continue;
    }
    let w = state.get(s.id);
    if (!w || w.voyage !== s.voyage.file) {
      w = { voyage: s.voyage.file, since: now };
      state.set(s.id, w);
    }
    // Becalmed already means 20 idle minutes before we first saw it.
    const idleMin = Math.round((now - w.since) / 60_000) + 20;
    if (!w.nudgedAt && now - w.since >= NUDGE_AFTER_MS) {
      w.nudgedAt = now;
      if (s.hasLead) actions.push({ kind: "nudge", ship: s.id, to: `${s.id}-lead`, text: nudgeText(s, idleMin) });
      else w.nudgedAt = now - TELL_AFTER_MS; // nobody to nudge: tell the captain now
    }
    if (w.nudgedAt && !w.told && now - w.nudgedAt >= TELL_AFTER_MS) {
      w.told = true;
      const open = openTasks(s);
      actions.push({
        kind: "tell",
        ship: s.id,
        summary: `${s.id}'s voyage has stalled (no activity for about ${idleMin} minutes)`,
        detail: `${open.length ? `Open tasks: ${open.map((t) => `#${t.id} ${t.title} (${t.status})`).join("; ")}.` : `All ${s.tasks.length} tasks are done but nobody asked to dock.`}${s.hasLead ? " The lead was nudged and nothing moved." : " The ship has no lead to nudge."} Open the ship's deck to see the crew, or tell the lead what to do.`,
      });
    }
  }
  for (const id of [...state.keys()]) if (!seen.has(id)) state.delete(id);
  return actions;
}

// ---------------------------------------------------------------- the runner (dashboard)

const watchState: WatchState = new Map();

/** Every minute from the dashboard: read the chart's ships, act on what the step decides. */
export async function runWatchdog(now = Date.now()): Promise<WatchAction[]> {
  const { harborChartJson } = await import("./harbor-chart.ts");
  const { chatTarget } = await import("./chat-targets.ts");
  const chart = await harborChartJson();
  const ships: WatchedShip[] = chart.ships.map((s) => ({
    id: s.id,
    condition: s.condition,
    voyage: s.voyage ? { file: s.voyage.file, label: s.voyage.label } : null,
    tasks: s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
    hasLead: Boolean(chatTarget(`${s.id}-lead`)),
  }));
  const actions = watchdogStep(ships, watchState, now);
  if (!actions.length) return actions;
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { fleetInboxRoot } = await import("./paths.ts");
  const { notifyCaptain } = await import("./notify.ts");
  const { logShipEvent } = await import("./ship-log.ts");
  for (const a of actions) {
    if (a.kind === "nudge") {
      const dir = join(fleetInboxRoot(), a.to);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "events.jsonl"), `${JSON.stringify({ ts: new Date(now).toISOString(), from: "watchdog", kind: "voyage-stalled", ship: a.ship, summary: a.text })}\n`);
      logShipEvent(a.ship, "watchdog", "notice", `Voyage quiet; nudged ${a.to}: ${a.text}`, { level: "warning" });
    } else {
      notifyCaptain({ from: "watchdog", kind: "blocked", summary: a.summary, detail: a.detail, ref: a.ship });
      logShipEvent(a.ship, "watchdog", "notice", a.summary, { level: "warning" });
    }
  }
  return actions;
}
