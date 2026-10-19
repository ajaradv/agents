import { describe, expect, test } from "bun:test";
import type { ShipEvent } from "./ship-log.ts";
import type { Maneuver, ManeuverPhase } from "./ship-maneuvers.ts";
import type { VoyageTask } from "./voyage-tasks.ts";
import {
  BECALMED_IDLE_MS,
  CONDITION_LABEL,
  CONDITIONS,
  conditionOf,
  HARBOR_MOUTH_PROGRESS,
  HEADWAY_IDLE_MS,
  progressOf,
  STORM_TURN_ERRORS,
  STORM_WINDOW_MS,
  taskScore,
  type Condition,
  type ConditionInput,
} from "./voyage-progress.ts";

const NOW = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const task = (over: Partial<VoyageTask> = {}): VoyageTask => ({
  id: 1, voyage: "/v.md", title: "t", detail: "", assignee: null, kind: "crew", adwId: null,
  status: "open", note: "", blockedBy: [], role: null, createdBy: "lead", createdAt: "", updatedAt: "",
  ...over,
});

const phase = (seq: number, status: string): ManeuverPhase => ({ seq, name: `phase ${seq}`, owner: "", status, error: null, attempt: 0 });

const maneuver = (over: Partial<Maneuver> = {}): Maneuver => ({
  adwId: "m1", adwName: "adw", request: "", status: "running", startedAt: "", endedAt: null, cost: 0, phases: [],
  ...over,
});

const ev = (id: number, ts: string, kind: string, payload: Record<string, unknown> | null = null): ShipEvent => ({ id, ts, actor: "x", kind, summary: kind, payload });

const cond = (over: Partial<ConditionInput> = {}): Condition => conditionOf({
  tasks: [], maneuvers: [], events: [], state: "docked", running: false, needsYou: false, now: NOW,
  ...over,
});

describe("taskScore", () => {
  const maneuvers: Maneuver[] = [maneuver({ adwId: "m1", phases: [phase(1, "pass"), phase(2, "ok"), phase(3, "running"), phase(4, "fail")] })];

  test("done is 1, blocked and open are 0", () => {
    expect(taskScore(task({ status: "done" }), maneuvers)).toBe(1);
    expect(taskScore(task({ status: "blocked" }), maneuvers)).toBe(0);
    expect(taskScore(task({ status: "open" }), maneuvers)).toBe(0);
  });

  test("a working crew task has no sub-steps to trust, so 0", () => {
    expect(taskScore(task({ status: "working", kind: "crew" }), maneuvers)).toBe(0);
  });

  test("a working maneuver counts passed phases over total: 2 of 4 is 0.5", () => {
    expect(taskScore(task({ status: "working", kind: "maneuver", adwId: "m1" }), maneuvers)).toBe(0.5);
  });

  test("a working maneuver with no matching maneuver is 0", () => {
    expect(taskScore(task({ status: "working", kind: "maneuver", adwId: "nope" }), maneuvers)).toBe(0);
  });

  test("a working maneuver with empty phases is 0", () => {
    expect(taskScore(task({ status: "working", kind: "maneuver", adwId: "m1" }), [maneuver({ adwId: "m1", phases: [] })])).toBe(0);
  });

  test("a done maneuver is 1 even without phases", () => {
    expect(taskScore(task({ status: "done", kind: "maneuver", adwId: "m1" }), [])).toBe(1);
  });
});

describe("progressOf", () => {
  test("2 tasks with 1 done is 0.5", () => {
    expect(progressOf([task({ id: 1, status: "done" }), task({ id: 2, status: "open" })], [])).toBe(0.5);
  });

  test("no tasks sits at the harbor mouth (0.04)", () => {
    expect(progressOf([], [])).toBe(HARBOR_MOUTH_PROGRESS);
    expect(progressOf([], [])).toBe(0.04);
  });

  test("maneuver fractions blend with crew tasks", () => {
    const maneuvers = [maneuver({ adwId: "m1", phases: [phase(1, "pass"), phase(2, "running")] })];
    const tasks = [
      task({ id: 1, status: "done" }),
      task({ id: 2, status: "working", kind: "maneuver", adwId: "m1" }),
    ];
    expect(progressOf(tasks, maneuvers)).toBe(0.75);
  });
});

describe("conditionOf", () => {
  test("priority: needs-you beats storm beats becalmed beats blocked beats headway beats docked/yard", () => {
    const stormManeuver = [maneuver({ adwId: "m1", startedAt: iso(NOW - 1000), endedAt: iso(NOW), phases: [phase(1, "fail")] })];
    const blockedTask = [task({ status: "blocked" })];

    // needs-you beats storm.
    expect(cond({ needsYou: true, state: "sailing", maneuvers: stormManeuver })).toBe("needs-you");
    // storm beats becalmed (under sail, idle, failed phase).
    expect(cond({ needsYou: false, state: "sailing", running: false, maneuvers: stormManeuver })).toBe("storm");
    // becalmed beats blocked (idle under sail with a blocked task).
    expect(cond({ needsYou: false, state: "sailing", running: false, tasks: blockedTask })).toBe("becalmed");
    // blocked beats headway (running, but a task is blocked and none working).
    expect(cond({ needsYou: false, state: "sailing", running: true, tasks: blockedTask })).toBe("blocked");
    // headway beats the docked fallback (under sail and running).
    expect(cond({ needsYou: false, state: "sailing", running: true })).toBe("headway");
  });

  test("storm via a maneuver phase fail within the window", () => {
    const inWindow = cond({ state: "docked", maneuvers: [maneuver({ adwId: "m1", startedAt: iso(NOW - 60_000), endedAt: iso(NOW), phases: [phase(1, "fail")] })] });
    expect(inWindow).toBe("storm");
    const inWindowError = cond({ state: "docked", maneuvers: [maneuver({ adwId: "m1", startedAt: iso(NOW - 60_000), endedAt: iso(NOW), phases: [phase(1, "error")] })] });
    expect(inWindowError).toBe("storm");
  });

  test("a phase fail outside the window is not a storm", () => {
    const outside = cond({ state: "docked", maneuvers: [maneuver({ adwId: "m1", startedAt: iso(NOW - STORM_WINDOW_MS - 1000), endedAt: iso(NOW - STORM_WINDOW_MS - 500), phases: [phase(1, "fail")] })] });
    expect(outside).toBe("docked");
  });

  test("storm via STORM_TURN_ERRORS turn-end errors within the window", () => {
    const events = Array.from({ length: STORM_TURN_ERRORS }, (_, i) => ev(i + 1, iso(NOW - i * 1000), "turn-end", { error: "boom" }));
    expect(cond({ state: "docked", events })).toBe("storm");
  });

  test("two turn-end errors within the window are not enough for a storm", () => {
    const events = [ev(1, iso(NOW - 1000), "turn-end", { error: "boom" }), ev(2, iso(NOW - 2000), "turn-end", { error: "boom" })];
    expect(cond({ state: "docked", events })).toBe("docked");
  });

  test("becalmed only under sail, not running, with no recent turn/tool/task", () => {
    expect(cond({ state: "sailing", running: false, events: [] })).toBe("becalmed");
    // Running under sail is headway, not becalmed.
    expect(cond({ state: "sailing", running: true, events: [] })).toBe("headway");
    // A recent tool event means the ship is not becalmed.
    expect(cond({ state: "sailing", running: false, events: [ev(1, iso(NOW - 1000), "tool")] })).not.toBe("becalmed");
    // A stale event (outside the idle window) still leaves the ship becalmed.
    expect(cond({ state: "sailing", running: false, events: [ev(1, iso(NOW - BECALMED_IDLE_MS - 1000), "turn-end")] })).toBe("becalmed");
    // Docked is never becalmed.
    expect(cond({ state: "docked", running: false, events: [] })).toBe("docked");
  });

  test("blocked when a task is blocked and none is working", () => {
    // A recent tool event keeps the ship out of becalmed so blocked shows.
    const events = [ev(1, iso(NOW - 1000), "tool")];
    expect(cond({ state: "sailing", running: false, events, tasks: [task({ status: "blocked" }), task({ status: "open" })] })).toBe("blocked");
  });

  test("not blocked when a task is working", () => {
    const tasks = [task({ id: 1, status: "blocked" }), task({ id: 2, status: "working" })];
    expect(cond({ state: "sailing", running: true, tasks })).toBe("headway");
  });

  test("headway when running under sail", () => {
    expect(cond({ state: "sailing", running: true })).toBe("headway");
  });

  test("headway from a recent task event without running", () => {
    const tasks = [task({ id: 1, status: "working" })];
    expect(cond({ state: "sailing", running: false, tasks, events: [ev(1, iso(NOW - 1000), "task")] })).toBe("headway");
    // A task event older than the headway window leaves the ship becalmed.
    expect(cond({ state: "sailing", running: false, tasks, events: [ev(1, iso(NOW - HEADWAY_IDLE_MS - 1000), "task")] })).toBe("becalmed");
  });

  test("docked and yard are the fallback", () => {
    expect(cond({ state: "docked" })).toBe("docked");
    expect(cond({ state: "yard" })).toBe("yard");
  });
});

describe("constants and labels", () => {
  test("every condition has a label and the order is the priority order", () => {
    expect(CONDITIONS).toEqual(["needs-you", "storm", "becalmed", "blocked", "headway", "docked", "yard"]);
    for (const c of CONDITIONS) expect(CONDITION_LABEL[c]).toBeTypeOf("string");
    expect(CONDITION_LABEL["needs-you"]).toBe("Needs you");
    expect(CONDITION_LABEL.yard).toBe("In the yard");
  });
});
