import { describe, expect, test } from "bun:test";
import type { ShipRow } from "./fleet-layers.ts";
import type { Maneuver, ManeuverPhase } from "./ship-maneuvers.ts";
import type { Voyage } from "./shipyard.ts";
import type { VoyageTask } from "./voyage-tasks.ts";
import { HARBOR_MOUTH_PROGRESS } from "./voyage-progress.ts";
import {
  berthPositions,
  chartGeometry,
  CHART_SIZE,
  fnv1a,
  ISLAND_MARGIN_Y_FRAC,
  ISLAND_MIN_GAP_FRAC,
  ISLAND_MIN_X_FRAC,
  ISLAND_SHAPES,
  islandsFor,
  routeWaypoints,
  shipPosition,
  type Point,
} from "./harbor-chart.ts";

const ship = (id: string): ShipRow => ({
  id,
  path: "",
  mode: "local-only",
  factory: null,
  declaredAdws: [],
  adws: [],
  orchestrator: "lead",
  crew: [],
  crewModels: {},
  isolation: "host",
  vmAllow: [],
  checks: {},
  gates: { task: [], dock: [] },
  maneuvers: [],
  rig: null,
});

const voyage = (file: string, over: Partial<Voyage> = {}): Voyage => ({
  file,
  ship: "s",
  status: "sailing",
  goal: "Sail home",
  to: "s-lead",
  started: "2026-10-19T00:00:00.000Z",
  ...over,
});

const task = (over: Partial<VoyageTask> = {}): VoyageTask => ({
  id: 1,
  voyage: "/v.md",
  title: "t",
  detail: "",
  assignee: null,
  kind: "crew",
  adwId: null,
  status: "open",
  note: "",
  blockedBy: [],
  role: null,
  createdBy: "lead",
  createdAt: "",
  updatedAt: "",
  ...over,
});

const phase = (seq: number, status: string): ManeuverPhase => ({ seq, name: `phase ${seq}`, owner: "", status, error: null, attempt: 0 });

const maneuver = (over: Partial<Maneuver> = {}): Maneuver => ({
  adwId: "m1",
  adwName: "adw",
  request: "",
  status: "running",
  startedAt: "",
  endedAt: null,
  cost: 0,
  phases: [],
  ...over,
});

describe("fnv1a", () => {
  test("is deterministic and unsigned", () => {
    expect(fnv1a("2026-10-19-sail-home.md")).toBe(fnv1a("2026-10-19-sail-home.md"));
    expect(fnv1a("2026-10-19-sail-home.md")).toBeGreaterThanOrEqual(0);
    expect(fnv1a("2026-10-19-sail-home.md")).toBeLessThanOrEqual(0xffffffff);
  });

  test("differs across file names", () => {
    expect(fnv1a("2026-10-19-a.md")).not.toBe(fnv1a("2026-10-19-b.md"));
  });
});

describe("berthPositions", () => {
  test("spreads ships evenly along the left edge, index order", () => {
    const berths = berthPositions(3);
    expect(berths).toHaveLength(3);
    for (const b of berths) expect(b.x).toBe(0);
    expect(berths[0]!.y).toBeLessThan(berths[1]!.y);
    expect(berths[1]!.y).toBeLessThan(berths[2]!.y);
    // Evenly spaced: half the height between neighbours.
    expect(berths[1]!.y - berths[0]!.y).toBeCloseTo(CHART_SIZE.h / 3);
  });
});

describe("islandsFor", () => {
  const files = ["2026-10-19-a.md", "2026-10-19-b.md", "2026-10-19-c.md", "2026-10-19-d.md"];

  test("placement is stable: same voyage file name, same island, across calls", () => {
    expect(islandsFor(files)).toEqual(islandsFor(files));
    expect(islandsFor(files)[0]).toEqual(islandsFor(files)[0]);
  });

  test("islands stay in the right 55% of the chart with a shape from the 6 tiles", () => {
    for (const island of islandsFor(files)) {
      expect(island.x).toBeGreaterThanOrEqual(ISLAND_MIN_X_FRAC * CHART_SIZE.w);
      expect(island.x).toBeLessThanOrEqual(CHART_SIZE.w);
      expect(island.y).toBeGreaterThanOrEqual(ISLAND_MARGIN_Y_FRAC * CHART_SIZE.h);
      expect(island.y).toBeLessThanOrEqual((1 - ISLAND_MARGIN_Y_FRAC) * CHART_SIZE.h);
      expect(island.shape).toBeGreaterThanOrEqual(0);
      expect(island.shape).toBeLessThan(ISLAND_SHAPES);
    }
  });

  test("islands never overlap: every pair is at least 10% of the width apart", () => {
    const islands = islandsFor(files);
    const minGap = ISLAND_MIN_GAP_FRAC * CHART_SIZE.w;
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const a = islands[i]!;
        const b = islands[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(minGap);
      }
    }
  });
});

describe("shipPosition", () => {
  const berth: Point = { x: 0, y: 10 };
  const island: Point = { x: 100, y: 50 };

  test("progress 0 is the berth, 1 is the island, fractions interpolate", () => {
    expect(shipPosition(berth, island, 0)).toEqual(berth);
    expect(shipPosition(berth, island, 1)).toEqual(island);
    expect(shipPosition(berth, island, 0.5)).toEqual({ x: 50, y: 30 });
    expect(shipPosition(berth, island, 0.25)).toEqual({ x: 25, y: 20 });
  });
});

describe("routeWaypoints", () => {
  test("one tick per task, spaced evenly, carrying status, kind, and maneuver phase fraction", () => {
    const maneuvers = [maneuver({ adwId: "m1", phases: [phase(1, "pass"), phase(2, "ok"), phase(3, "running"), phase(4, "fail")] })];
    const tasks = [
      task({ id: 1, status: "done" }),
      task({ id: 2, status: "working", kind: "maneuver", adwId: "m1" }),
      task({ id: 3, status: "open" }),
    ];
    const waypoints = routeWaypoints({ x: 0, y: 0 }, { x: 90, y: 60 }, tasks, maneuvers);
    expect(waypoints).toHaveLength(3);
    expect(waypoints[0]!.fraction).toBeCloseTo(1 / 3);
    expect(waypoints[1]!.fraction).toBeCloseTo(2 / 3);
    expect(waypoints[2]!.fraction).toBeCloseTo(1);
    // Reuses taskScore: done is 1, the working maneuver counts its passed phases (2/4).
    expect(waypoints[0]!.status).toBe("done");
    expect(waypoints[0]!.phase).toBe(1);
    expect(waypoints[1]!.kind).toBe("maneuver");
    expect(waypoints[1]!.phase).toBe(0.5);
    expect(waypoints[2]!.status).toBe("open");
    expect(waypoints[2]!.phase).toBe(0);
  });
});

describe("chartGeometry", () => {
  const ships = [ship("b"), ship("a")]; // readShips order is alphabetical; chartGeometry takes them as given.
  const file = "/vault/fleet/voyages/a/2026-10-19-sail-home.md";

  test("a voyage with no tasks sits at the harbor mouth", () => {
    const g = chartGeometry(
      ships,
      new Map([["a", voyage(file)], ["b", null]]),
      new Map([["a", []], ["b", []]]),
      new Map(),
    );
    const a = g.find((x) => x.shipId === "a")!;
    expect(a.progress).toBe(HARBOR_MOUTH_PROGRESS);
    expect(a.island).not.toBeNull();
    const expected = shipPosition(a.berthPos, a.island!, HARBOR_MOUTH_PROGRESS);
    expect(a.position).toEqual(expected);
    expect(a.position.x).toBeGreaterThan(a.berthPos.x);
    expect(a.position.x).toBeLessThan(a.island!.x);
    expect(a.waypoints).toEqual([]);
  });

  test("all tasks done puts the ship on its island; a fraction interpolates", () => {
    const done = chartGeometry(
      [ship("a")],
      new Map([["a", voyage(file)]]),
      new Map([["a", [task({ id: 1, status: "done" }), task({ id: 2, status: "done" })]]]),
      new Map(),
    );
    const a = done[0]!;
    expect(a.progress).toBe(1);
    expect(a.position.x).toBeCloseTo(a.island!.x);
    expect(a.position.y).toBeCloseTo(a.island!.y);

    const half = chartGeometry(
      [ship("a")],
      new Map([["a", voyage(file)]]),
      new Map([["a", [task({ id: 1, status: "done" }), task({ id: 2, status: "open" })]]]),
      new Map(),
    );
    expect(half[0]!.progress).toBe(0.5);
    expect(half[0]!.position).toEqual(shipPosition(half[0]!.berthPos, half[0]!.island!, 0.5));
  });

  test("a ship with no voyage stays at its berth with no island or route", () => {
    const g = chartGeometry([ship("yard")], new Map([["yard", null]]), new Map(), new Map());
    const s = g[0]!;
    expect(s.progress).toBe(0);
    expect(s.island).toBeNull();
    expect(s.position).toEqual(s.berthPos);
    expect(s.waypoints).toEqual([]);
  });

  test("berths are assigned in ship order, index 0..n-1", () => {
    const g = chartGeometry(ships, new Map([["a", null], ["b", null]]), new Map(), new Map());
    expect(g.map((s) => s.berth)).toEqual([0, 1]);
    expect(g[0]!.berthPos.y).toBeLessThan(g[1]!.berthPos.y);
  });
});
