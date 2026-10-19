import { basename } from "node:path";
import { HARBOR_MOUTH_PROGRESS, progressOf, taskScore, weatherOf, type Condition, type ShipState, type Weather } from "./voyage-progress.ts";
import type { ShipRow } from "./fleet-layers.ts";
import type { Maneuver } from "./ship-maneuvers.ts";
import type { Voyage } from "./shipyard.ts";
import type { TaskStatus, VoyageTask } from "./voyage-tasks.ts";

/**
 * The sea chart model behind GET /api/harbor/chart: berths along the harbor
 * edge, a stable destination island per sailing voyage (fnv1a of the voyage
 * file name, nudged apart when two land too close), dashed routes with one
 * waypoint tick per task, and each ship's position as berth + progress ×
 * (island − berth). Everything geometric here is a pure function of its
 * inputs; the one reader (harborChartJson) assembles them from disk, so the
 * geometry is unit-testable without a live fleet.
 *
 * The chart is a 16:7 plane in a 160×70 grid (the client scales it to its
 * canvas and snaps to its own 8 px grid). Positions are in those units.
 */

export const CHART_SIZE = { w: 160, h: 70 } as const;
export type ChartSize = { w: number; h: number };

/** Islands live in the right 55% of the chart, never touching the top/bottom 8%. */
export const ISLAND_MIN_X_FRAC = 0.45;
export const ISLAND_MARGIN_Y_FRAC = 0.08;
/** Minimum distance between island centres, as a fraction of chart width. */
export const ISLAND_MIN_GAP_FRAC = 0.1;
export const ISLAND_SHAPES = 6;

export type Point = { x: number; y: number };
export type Island = Point & { shape: number };

/** FNV-1a over UTF-8 bytes, returned as an unsigned 32-bit integer. */
export function fnv1a(text: string): number {
  const bytes = new TextEncoder().encode(text);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Berth points along the left (harbor) edge: index 0..n-1 spread evenly. */
export function berthPositions(count: number, size: ChartSize = CHART_SIZE): Point[] {
  const n = Math.max(1, count);
  return Array.from({ length: count }, (_, i) => ({ x: 0, y: ((i + 0.5) / n) * size.h }));
}

/**
 * One island per voyage file name, in the order given (so placement is
 * deterministic): position from an fnv1a hash mapped into the right 55%, the
 * shape from the same base hash, and when two points land within
 * ISLAND_MIN_GAP_FRAC of the chart width the later one re-hashes with a salt
 * until it clears. Stable run-to-run for the same set of file names.
 */
export function islandsFor(fileNames: string[], size: ChartSize = CHART_SIZE): Island[] {
  const minGap = ISLAND_MIN_GAP_FRAC * size.w;
  const placed: Island[] = [];
  for (const name of fileNames) {
    const base = fnv1a(name);
    const shape = base % ISLAND_SHAPES;
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 64; attempt++) {
      const h = attempt === 0 ? base : fnv1a(`${name}#${attempt}`);
      x = (ISLAND_MIN_X_FRAC + ((h & 0xffff) / 0xffff) * (1 - ISLAND_MIN_X_FRAC)) * size.w;
      y = (ISLAND_MARGIN_Y_FRAC + (((h >>> 16) & 0xffff) / 0xffff) * (1 - 2 * ISLAND_MARGIN_Y_FRAC)) * size.h;
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= minGap)) break;
    }
    placed.push({ x, y, shape });
  }
  return placed;
}

/** The ship's position along berth→island at a given progress (0 = berth, 1 = island). */
export function shipPosition(berth: Point, island: Point, progress: number): Point {
  return {
    x: berth.x + (island.x - berth.x) * progress,
    y: berth.y + (island.y - berth.y) * progress,
  };
}

export type Waypoint = {
  id: number;
  title: string;
  x: number;
  y: number;
  /** 1/T..1 along the route, so a ship that has finished k tasks sits on the kth tick. */
  fraction: number;
  status: TaskStatus;
  kind: "crew" | "maneuver";
  /** Maneuver phase fraction (pass|ok|done / total), via taskScore; 0 when unknown or not a maneuver. */
  phase: number;
};

/** One tick per task, spaced evenly from 1/T to 1 along berth→island. */
export function routeWaypoints(berth: Point, island: Point, tasks: VoyageTask[], maneuvers: Maneuver[]): Waypoint[] {
  const total = tasks.length;
  return tasks.map((task, i) => {
    const fraction = total === 0 ? 0 : (i + 1) / total;
    const pos = shipPosition(berth, island, fraction);
    return {
      id: task.id,
      title: task.title,
      x: pos.x,
      y: pos.y,
      fraction,
      status: task.status,
      kind: task.kind,
      phase: taskScore(task, maneuvers),
    };
  });
}

/** The assembled geometry for the chart: pure over ships, voyages, tasks, and maneuvers. */
export type ChartShipGeometry = {
  shipId: string;
  berth: number;
  berthPos: Point;
  island: Island | null;
  position: Point;
  progress: number;
  waypoints: Waypoint[];
};

export function chartGeometry(
  ships: ShipRow[],
  voyages: Map<string, Voyage | null>,
  tasks: Map<string, VoyageTask[]>,
  maneuvers: Map<string, Maneuver[]>,
  size: ChartSize = CHART_SIZE,
): ChartShipGeometry[] {
  const berths = berthPositions(ships.length, size);

  // Islands for the sailing voyages, in ship order, aligned back to the ship index.
  const islandFiles: string[] = [];
  const islandShipIdx: number[] = [];
  ships.forEach((s, i) => {
    const voyage = voyages.get(s.id) ?? null;
    if (voyage) {
      islandFiles.push(basename(voyage.file));
      islandShipIdx.push(i);
    }
  });
  const islands = islandsFor(islandFiles, size);
  const islandByShip = new Map<number, Island>();
  islandShipIdx.forEach((shipIdx, k) => islandByShip.set(shipIdx, islands[k]!));

  return ships.map((s, i) => {
    const voyage = voyages.get(s.id) ?? null;
    const berth = berths[i]!;
    const island = voyage ? islandByShip.get(i) ?? null : null;
    const shipTasks = tasks.get(s.id) ?? [];
    const shipManeuvers = maneuvers.get(s.id) ?? [];
    const progress = voyage ? progressOf(shipTasks, shipManeuvers) : 0;
    const position = voyage && island ? shipPosition(berth, island, progress) : berth;
    return {
      shipId: s.id,
      berth: i,
      berthPos: berth,
      island,
      position,
      progress,
      waypoints: voyage && island ? routeWaypoints(berth, island, shipTasks, shipManeuvers) : [],
    };
  });
}

// ---------------------------------------------------------------- the JSON

export type ChartTask = { id: number; title: string; status: TaskStatus; kind: "crew" | "maneuver"; phase: number };
export type ChartCrew = { id: string; status: string };

export type ChartShip = {
  id: string;
  berth: number;
  berthPos: Point;
  state: ShipState;
  condition: Condition;
  weather: Weather;
  progress: number;
  voyage: { goal: string; label: string; file: string; fileName: string } | null;
  island: Island | null;
  position: Point;
  waypoints: Waypoint[];
  tasks: ChartTask[];
  crew: ChartCrew[];
  /** USD spent today across the crew, and the daily budget those roles sum to (null when none set). */
  spend: number;
  budget: number | null;
};

export type ChartModel = { size: ChartSize; ships: ChartShip[]; fleet: { spendToday: number; spendWeek: number } };

/**
 * The real reads behind GET /api/harbor/chart. Everything heavy (the ship view,
 * chat targets, orders) is imported lazily so the pure geometry above stays
 * loadable in tests without starting the node link or its timers.
 */
export async function harborChartJson(): Promise<ChartModel> {
  const { readShips } = await import("./fleet-layers.ts");
  const { crewBudget, openVoyage, readyToSail, shipChecklist, spentToday } = await import("./shipyard.ts");
  const { listTasks } = await import("./voyage-tasks.ts");
  const { recentManeuvers } = await import("./ship-maneuvers.ts");
  const { recentShipEvents } = await import("./ship-log.ts");
  const { voyageProgress } = await import("./voyage-progress.ts");
  const { crewCards, firstmateCrews, orderNeedsCaptain, shipRunning, shipState } = await import("./ship-view.ts");
  const { listOrders } = await import("./order-note.ts");
  const { modelSpend } = await import("./model-spend.ts");

  const ships = await readShips();
  const orders = await listOrders();

  const voyages = new Map<string, Voyage | null>();
  const tasks = new Map<string, VoyageTask[]>();
  const maneuvers = new Map<string, Maneuver[]>();
  const facts = new Map<string, { state: ShipState; condition: Condition; weather: Weather; crew: ChartCrew[]; spend: number; budget: number | null }>();

  for (const ship of ships) {
    const voyage = await openVoyage(ship.id);
    voyages.set(ship.id, voyage);
    const shipTasks = voyage ? listTasks(ship.id, voyage.file) : [];
    const shipManeuvers = voyage ? recentManeuvers(ship.path) : [];
    tasks.set(ship.id, shipTasks);
    maneuvers.set(ship.id, shipManeuvers);

    const events = recentShipEvents(ship.id, 200);
    const cards = crewCards(ship, events);
    const fm = firstmateCrews(ship);
    const st = shipState(readyToSail(await shipChecklist(ship)), voyage, cards, fm);
    const running = shipRunning(cards, fm);
    const needsYou = cards.some((c) => c.status === "waiting") || orderNeedsCaptain(orders, ship.id);
    const { condition } = voyageProgress(ship, voyage, { state: st.state, running, needsYou });

    let spend = 0;
    let budget = 0;
    let hasBudget = false;
    for (const role of ship.crew) {
      const b = await crewBudget(ship.id, role);
      if (b !== null) {
        hasBudget = true;
        budget += b;
      }
      spend += spentToday(ship.id, `${ship.id}-${role}`);
    }

    const weather = weatherOf({ events, maneuvers: shipManeuvers, spend, budget: hasBudget ? budget : null, state: st.state });

    facts.set(ship.id, {
      state: st.state,
      condition,
      weather,
      crew: cards.map((c) => ({ id: c.target.id, status: c.status })),
      spend,
      budget: hasBudget ? budget : null,
    });
  }

  const geometry = chartGeometry(ships, voyages, tasks, maneuvers);

  // The harbor-wall fleet gauge: today's billed model spend, with the week as
  // the reference denominator. Estimates and junie/ subscription credits are
  // excluded (they are not billed against API keys).
  const spendRows = await modelSpend();
  const billed = spendRows.filter((r) => !r.estimated && !r.lane.startsWith("junie/"));
  const fleet = {
    spendToday: billed.reduce((n, r) => n + r.todayUsd, 0),
    spendWeek: billed.reduce((n, r) => n + r.weekUsd, 0),
  };

  return {
    size: CHART_SIZE,
    fleet,
    ships: ships.map((ship, i) => {
      const g = geometry[i]!;
      const f = facts.get(ship.id)!;
      const voyage = voyages.get(ship.id) ?? null;
      return {
        id: ship.id,
        berth: g.berth,
        berthPos: g.berthPos,
        state: f.state,
        condition: f.condition,
        weather: f.weather,
        progress: g.progress,
        voyage: voyage ? { goal: voyage.goal, label: voyage.goal.slice(0, 32), file: voyage.file, fileName: basename(voyage.file) } : null,
        island: g.island,
        position: g.position,
        waypoints: g.waypoints,
        tasks: g.waypoints.map((w) => ({ id: w.id, title: w.title, status: w.status, kind: w.kind, phase: w.phase })),
        crew: f.crew,
        spend: f.spend,
        budget: f.budget,
      };
    }),
  };
}
