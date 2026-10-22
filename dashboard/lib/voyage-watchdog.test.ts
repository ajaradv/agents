import { describe, expect, test } from "bun:test";
import { NUDGE_AFTER_MS, TELL_AFTER_MS, watchdogStep, type WatchedShip, type WatchState } from "./voyage-watchdog.ts";

const ship = (over: Partial<WatchedShip> = {}): WatchedShip => ({
  id: "fleet",
  condition: "becalmed",
  voyage: { file: "2026-10-19-phase-3.md", label: "Game mechanics phase 3" },
  tasks: [{ id: 12, title: "fixture", status: "done" }, { id: 13, title: "Polish", status: "working" }],
  hasLead: true,
  ...over,
});
const MIN = 60_000;

describe("the stalled-voyage watchdog", () => {
  test("a becalmed voyage nudges its lead once, then tells the captain once; the phase-3 stall would have been caught", () => {
    const st: WatchState = new Map();
    const t0 = 1_000_000_000_000;
    expect(watchdogStep([ship()], st, t0)).toEqual([]);
    const nudge = watchdogStep([ship()], st, t0 + NUDGE_AFTER_MS);
    expect(nudge).toHaveLength(1);
    expect(nudge[0]).toMatchObject({ kind: "nudge", to: "fleet-lead" });
    expect((nudge[0] as { text: string }).text).toContain("#13 (working)");
    expect((nudge[0] as { text: string }).text.length).toBeLessThanOrEqual(200);
    expect(watchdogStep([ship()], st, t0 + NUDGE_AFTER_MS + MIN)).toEqual([]);
    const tell = watchdogStep([ship()], st, t0 + NUDGE_AFTER_MS + TELL_AFTER_MS);
    expect(tell).toEqual([expect.objectContaining({ kind: "tell", ship: "fleet" })]);
    expect(watchdogStep([ship()], st, t0 + NUDGE_AFTER_MS + TELL_AFTER_MS + 10 * MIN)).toEqual([]);
  });
  test("all tasks done but nobody docked: the nudge asks to dock (the phase-2 stall)", () => {
    const st: WatchState = new Map();
    watchdogStep([ship({ tasks: [{ id: 4, title: "a", status: "done" }] })], st, 0);
    const [a] = watchdogStep([ship({ tasks: [{ id: 4, title: "a", status: "done" }] })], st, NUDGE_AFTER_MS);
    expect((a as { text: string }).text).toContain("voyage_dock");
  });
  test("activity resets the watch; a ship with no lead goes straight to the captain; docked ships are ignored", () => {
    const st: WatchState = new Map();
    watchdogStep([ship()], st, 0);
    watchdogStep([ship({ condition: "headway" })], st, 5 * MIN);
    expect(watchdogStep([ship()], st, NUDGE_AFTER_MS)).toEqual([]);
    const lone: WatchState = new Map();
    watchdogStep([ship({ hasLead: false })], lone, 0);
    expect(watchdogStep([ship({ hasLead: false })], lone, NUDGE_AFTER_MS)).toEqual([expect.objectContaining({ kind: "tell" })]);
    expect(watchdogStep([ship({ condition: "docked", voyage: null })], new Map(), NUDGE_AFTER_MS)).toEqual([]);
  });
});
