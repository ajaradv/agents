import { compactionAdviceSummary } from "./compaction-advisor.ts";
import { jevSpend } from "./jev.ts";
import { metricsDb } from "./metrics.ts";
import { toolFailureCounts, toolFailuresSince } from "./tool-failures.ts";

/**
 * fleet_query (vault plan alice-memory-and-tools, M1): the exact questions an
 * officer used to answer with ad hoc sqlite3 over metrics.db and journal.db,
 * as named, parameterized, read-only queries. No SQL goes in. One library for
 * the pi tool (through the node) and `bin/fleet-axi query`.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

export const FLEET_QUERIES = ["spend", "tool_failures", "jev", "gate", "voyages"] as const;
export type FleetQuery = (typeof FLEET_QUERIES)[number];
export const SPEND_BY = ["agent", "model", "day"] as const;
export type SpendBy = (typeof SPEND_BY)[number];

const MAX_DAYS = 365;
const usd = (n: number) => Number(n.toFixed(4));
const sinceIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Turn cost in metrics.db `turns`, grouped by agent, model, or (UTC) day. */
export function spendQuery(days: number, by: SpendBy): Res {
  const key = { agent: "agent", model: "model", day: "substr(ts, 1, 10)" }[by];
  let rows: { name: string; turns: number; cost: number; failed: number; tokens: number }[] = [];
  try {
    rows = metricsDb()
      .query(`SELECT ${key} AS name, COUNT(*) AS turns, ROUND(SUM(cost), 4) AS cost, SUM(1 - ok) AS failed, SUM(tokens) AS tokens FROM turns WHERE ts >= ? GROUP BY name ORDER BY ${by === "day" ? "name DESC" : "cost DESC"}`)
      .all(sinceIso(days)) as typeof rows;
  } catch {
    /* no metrics yet */
  }
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const turns = rows.reduce((a, r) => a + r.turns, 0);
  return {
    ok: true,
    message: `$${total.toFixed(2)} over ${turns} turns in ${days} day(s), by ${by}`,
    [`by_${by}`]: rows.map((r) => ({ [by]: r.name || "(none)", turns: r.turns, cost: r.cost, failed: r.failed, tokens: r.tokens })),
  };
}

/** Failed tool calls and dead turns (journal.db tool_failures; expected non-zero exits left out). */
export function toolFailuresQuery(days: number): Res {
  const by = toolFailureCounts(days * 24);
  const total = by.reduce((a, r) => a + r.n, 0);
  return {
    ok: true,
    message: `${total} tool failure(s) in ${days} day(s)`,
    failures_by_tool: by.slice(0, 20).map((r) => ({ agent: r.agent, tool: r.tool, n: r.n, last: r.last })),
    latest: toolFailuresSince(sinceIso(days), 8).map((f) => ({ ts: f.ts, agent: f.agent, tool: f.tool, error: f.error })),
  };
}

/** Jev calls and spend per use, and the compaction advisor. */
export function jevQuery(days: number): Res {
  const spend = jevSpend(days);
  const advice = compactionAdviceSummary(days);
  return {
    ok: true,
    message: `${spend.reduce((a, s) => a + s.calls, 0)} Jev calls, $${spend.reduce((a, s) => a + s.cost, 0).toFixed(4)} in ${days} day(s)`,
    uses: spend.map((s) => ({ use: s.use, calls: s.calls, failed: s.failed, cost: Number(s.cost.toFixed(5)), avg_ms: s.avgMs })),
    compaction_advisor: advice,
  };
}

/** Tool gate decisions (metrics.db gate_log): counts by decision, and the ones that were not plain allows. */
export function gateQuery(days: number): Res {
  const since = sinceIso(days);
  let rows: { decision: string; n: number }[] = [];
  let recent: { ts: string; agent: string; decision: string; summary: string }[] = [];
  try {
    rows = metricsDb().query("SELECT decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? GROUP BY decision ORDER BY n DESC").all(since) as typeof rows;
    recent = metricsDb().query("SELECT ts, agent, decision, summary FROM gate_log WHERE ts >= ? AND decision NOT IN ('allow', 'observe-allow', 'screen-ok') ORDER BY id DESC LIMIT 15").all(since) as typeof recent;
  } catch {
    /* no log yet */
  }
  return {
    ok: true,
    message: rows.length ? rows.map((r) => `${r.decision} ${r.n}`).join(", ") : `0 gate decisions in ${days} day(s)`,
    notable: recent.map((r) => ({ ts: r.ts, agent: r.agent, decision: r.decision, call: r.summary })),
  };
}

/** Voyages started in the window, and any still open, with ship and cost (metrics.db voyage_totals). */
export function voyagesQuery(days: number): Res {
  let rows: { id: string; ship: string; goal: string; started: string; docked: string | null; commits: number | null; turns: number; cost: number }[] = [];
  try {
    rows = metricsDb()
      .query("SELECT v.id, v.ship, v.goal, v.started, v.docked, v.commits, v.turns, v.cost FROM voyage_totals v WHERE v.started >= ? OR v.docked IS NULL ORDER BY v.started DESC")
      .all(sinceIso(days)) as typeof rows;
  } catch {
    /* no metrics yet */
  }
  const open = rows.filter((r) => !r.docked).length;
  return {
    ok: true,
    message: `${rows.length} voyage(s): ${open} open, ${rows.length - open} docked (started in ${days} day(s), plus any still open); $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}`,
    voyages: rows.map((r) => ({ id: r.id, ship: r.ship, goal: r.goal, state: r.docked ? "docked" : "open", started: r.started, commits: r.commits, turns: r.turns, cost: usd(r.cost) })),
  };
}

/** Run a named query. `days` (default 7) is clamped to 1..365; `by` applies to spend only. */
export function fleetQuery(name: string, opts: { days?: number; by?: string } = {}): Res {
  if (!(FLEET_QUERIES as readonly string[]).includes(name)) return { ok: false, message: `Unknown query "${name}". Queries: ${FLEET_QUERIES.join(", ")}.` };
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(opts.days ?? 7)) || 7));
  if (name === "spend") {
    const by = opts.by || "agent";
    if (!(SPEND_BY as readonly string[]).includes(by)) return { ok: false, message: `Cannot group spend by "${by}". Use by: ${SPEND_BY.join(", ")}.` };
    return spendQuery(days, by as SpendBy);
  }
  if (opts.by) return { ok: false, message: `by applies to spend only (not ${name}).` };
  if (name === "tool_failures") return toolFailuresQuery(days);
  if (name === "jev") return jevQuery(days);
  if (name === "gate") return gateQuery(days);
  return voyagesQuery(days);
}
