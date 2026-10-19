import { recentManeuvers, type Maneuver } from "./ship-maneuvers.ts";
import { recentShipEvents, type ShipEvent } from "./ship-log.ts";
import { listTasks, type VoyageTask } from "./voyage-tasks.ts";
import type { Voyage } from "./shipyard.ts";

/**
 * A voyage's visible progress (a number in [0, 1]) and its condition, derived
 * from tasks, maneuver phases, the ship's log, and the live agent state. Pure
 * functions over those shapes, plus one reader (voyageProgress) that assembles
 * them. Everything the harbor chart, the deck bar, and Alice's narration draw
 * comes from here, so they agree.
 */

// Thresholds, tuned later in real voyages. Times are ms; windows compare
// event timestamps (Date.parse) against `now` (defaults to Date.now()).
export const HARBOR_MOUTH_PROGRESS = 0.04;
export const STORM_WINDOW_MS = 30 * 60_000;
export const STORM_TURN_ERRORS = 3;
export const BECALMED_IDLE_MS = 20 * 60_000;
export const HEADWAY_IDLE_MS = 20 * 60_000;

export const CONDITIONS = ["needs-you", "storm", "becalmed", "blocked", "headway", "docked", "yard"] as const;
export type Condition = (typeof CONDITIONS)[number];
export type ShipState = "yard" | "sailing" | "docked";

export const CONDITION_LABEL: Record<Condition, string> = {
  "needs-you": "Needs you",
  storm: "Storm",
  becalmed: "Becalmed",
  blocked: "Blocked",
  headway: "Headway",
  docked: "Docked",
  yard: "In the yard",
};

const PASSED_PHASES = ["pass", "ok", "done"];
const FAILED_PHASES = ["fail", "error"];

/**
 * How far one task is: done is 1, blocked/open are 0. A working crew task is 0
 * (no sub-steps to trust); a working maneuver counts its passed phases as a
 * fraction of its total (0 when the phases are empty/unknown or no maneuver
 * matches the task's adwId).
 */
export function taskScore(task: VoyageTask, maneuvers: Maneuver[]): number {
  if (task.status === "done") return 1;
  if (task.status !== "working") return 0;
  if (task.kind !== "maneuver" || !task.adwId) return 0;
  const maneuver = maneuvers.find((m) => m.adwId === task.adwId);
  if (!maneuver || maneuver.phases.length === 0) return 0;
  return maneuver.phases.filter((p) => PASSED_PHASES.includes(p.status)).length / maneuver.phases.length;
}

/** Mean task score, or the harbor mouth when the lead has not plotted tasks yet. */
export function progressOf(tasks: VoyageTask[], maneuvers: Maneuver[]): number {
  if (tasks.length === 0) return HARBOR_MOUTH_PROGRESS;
  const total = tasks.reduce((sum, t) => sum + taskScore(t, maneuvers), 0);
  return Math.min(1, Math.max(0, total / tasks.length));
}

export type ConditionInput = {
  tasks: VoyageTask[];
  maneuvers: Maneuver[];
  events: ShipEvent[];
  state: ShipState;
  running: boolean;
  needsYou: boolean;
  now?: number;
};

/** The most recent timestamp we have for a maneuver: when it ended, else when it began. */
function maneuverTime(m: Maneuver): number {
  const raw = m.endedAt || m.startedAt;
  return raw ? Date.parse(raw) : Number.NaN;
}

/**
 * One condition, highest priority wins (order below). Events are newest-first
 * from the ship log; windows are `now - window` through `now`, so any
 * non-finite Date.parse simply falls outside.
 */
export function conditionOf(input: ConditionInput): Condition {
  const now = input.now ?? Date.now();
  const { tasks, maneuvers, events, state, running, needsYou } = input;

  // 1. A crewmate is waiting on the captain.
  if (needsYou) return "needs-you";

  // 2. A maneuver phase failed recently, or the last few turns keep erroring.
  const stormSince = now - STORM_WINDOW_MS;
  const phaseFailed = maneuvers.some((m) => {
    const ts = maneuverTime(m);
    return Number.isFinite(ts) && ts >= stormSince && m.phases.some((p) => FAILED_PHASES.includes(p.status));
  });
  const turnErrors = events.filter((e) => {
    if (e.kind !== "turn-end" || !e.payload?.error) return false;
    const ts = Date.parse(e.ts);
    return Number.isFinite(ts) && ts >= stormSince;
  }).length;
  if (phaseFailed || turnErrors >= STORM_TURN_ERRORS) return "storm";

  // 3. Under sail but idle: no turns, tools, or task updates recently.
  if (state === "sailing" && !running) {
    const idleSince = now - BECALMED_IDLE_MS;
    const active = events.some((e) => {
      if (e.kind !== "turn-end" && e.kind !== "tool" && e.kind !== "task") return false;
      const ts = Date.parse(e.ts);
      return Number.isFinite(ts) && ts >= idleSince;
    });
    if (!active) return "becalmed";
  }

  // 4. A task is stuck and nobody is actively working one.
  if (tasks.some((t) => t.status === "blocked") && !tasks.some((t) => t.status === "working")) return "blocked";

  // 5. Making way: someone is running, or a task moved recently.
  if (state === "sailing") {
    if (running) return "headway";
    const headwaySince = now - HEADWAY_IDLE_MS;
    if (events.some((e) => e.kind === "task" && Number.isFinite(Date.parse(e.ts)) && Date.parse(e.ts) >= headwaySince)) return "headway";
  }

  // 6. As shipState() today: yard or docked.
  return state === "yard" ? "yard" : "docked";
}

/**
 * The one entry the views call. Reads the ship's tasks ([] when no voyage),
 * its recent maneuvers ([] when no voyage), and the last 200 log events, then
 * folds them into progress and condition with the live agent state.
 */
export function voyageProgress(
  ship: { id: string; path: string },
  voyage: Voyage | null,
  live: { state: ShipState; running: boolean; needsYou: boolean },
): { progress: number; condition: Condition } {
  const tasks = voyage ? listTasks(ship.id, voyage.file) : [];
  const maneuvers = voyage ? recentManeuvers(ship.path) : [];
  const events = recentShipEvents(ship.id, 200);
  return {
    progress: progressOf(tasks, maneuvers),
    condition: conditionOf({ tasks, maneuvers, events, ...live }),
  };
}
