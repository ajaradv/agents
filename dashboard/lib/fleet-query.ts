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
const DAY_MS = 86_400_000;

/** The time window every query reads: `from` inclusive, `to` exclusive. */
export type Window = { from: string; to: string; label: string; ranged: boolean };
// `to` is a minute ahead so a row written this instant is still inside.
const daysWindow = (days: number): Window => ({ from: new Date(Date.now() - days * DAY_MS).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), label: `in ${days} day(s)`, ranged: false });
/** Message tail: "in 7 day(s)" after a space, or the date range after a comma. */
const when = (w: Window) => (w.ranged ? `, ${w.label}` : ` ${w.label}`);

/** A date (YYYY-MM-DD, whole UTC day) or a full ISO timestamp, as ms; the end of a date is the start of the next day. */
function parseBound(s: string, end: boolean): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s ? NaN : t + (end ? DAY_MS : 0);
  }
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
}

/** Resolve days / since / until once. `until` alone looks `days` back from it; with `since`, `days` is ignored. */
export function resolveWindow(opts: { days?: number; since?: string; until?: string }): Window | string {
  const days = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(opts.days ?? 7)) || 7));
  if (!opts.since && !opts.until) return daysWindow(days);
  const bad = (k: string, v: string) => `Cannot read ${k} "${v}". Use YYYY-MM-DD (UTC, whole days, inclusive) or a full ISO timestamp.`;
  const from = opts.since ? parseBound(opts.since, false) : NaN;
  const to = opts.until ? parseBound(opts.until, true) : NaN;
  if (opts.since && Number.isNaN(from)) return bad("since", opts.since);
  if (opts.until && Number.isNaN(to)) return bad("until", opts.until);
  const hi = opts.until ? to : Date.now() + 60_000;
  const lo = opts.since ? from : hi - days * DAY_MS;
  if (lo >= hi) return `since ${opts.since} is after until ${opts.until}.`;
  if (hi - lo > MAX_DAYS * DAY_MS) return `The range is over ${MAX_DAYS} days; narrow since/until.`;
  const shown = (v: string | undefined, ms: number) => v ?? new Date(ms).toISOString().slice(0, 10);
  return { from: new Date(lo).toISOString(), to: new Date(hi).toISOString(), label: `${shown(opts.since, lo)} to ${shown(opts.until, hi)}`, ranged: true };
}

/** Turn cost in metrics.db `turns`, grouped by agent, model, or (UTC) day. */
export function spendQuery(w: Window, by: SpendBy): Res {
  const key = { agent: "agent", model: "model", day: "substr(ts, 1, 10)" }[by];
  let rows: { name: string; turns: number; cost: number; failed: number; tokens: number }[] = [];
  try {
    rows = metricsDb()
      .query(`SELECT ${key} AS name, COUNT(*) AS turns, ROUND(SUM(cost), 4) AS cost, SUM(1 - ok) AS failed, SUM(tokens) AS tokens FROM turns WHERE ts >= ? AND ts < ? GROUP BY name ORDER BY ${by === "day" ? "name DESC" : "cost DESC"}`)
      .all(w.from, w.to) as typeof rows;
  } catch {
    /* no metrics yet */
  }
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const turns = rows.reduce((a, r) => a + r.turns, 0);
  return {
    ok: true,
    message: `$${total.toFixed(2)} over ${turns} turns${when(w)}, by ${by}`,
    [`by_${by}`]: rows.map((r) => ({ [by]: r.name || "(none)", turns: r.turns, cost: r.cost, failed: r.failed, tokens: r.tokens })),
  };
}

/** Failed tool calls and dead turns (journal.db tool_failures; expected non-zero exits left out). */
export function toolFailuresQuery(w: Window): Res {
  const by = toolFailureCounts(0, w);
  const total = by.reduce((a, r) => a + r.n, 0);
  return {
    ok: true,
    message: `${total} tool failure(s)${when(w)}`,
    failures_by_tool: by.slice(0, 20).map((r) => ({ agent: r.agent, tool: r.tool, n: r.n, last: r.last })),
    latest: toolFailuresSince(w.from, 8, w.to).map((f) => ({ ts: f.ts, agent: f.agent, tool: f.tool, error: f.error })),
  };
}

/** Jev calls and spend per use, and the compaction advisor. */
export function jevQuery(w: Window): Res {
  const spend = jevSpend(0, w);
  const advice = compactionAdviceSummary(0, w);
  return {
    ok: true,
    message: `${spend.reduce((a, s) => a + s.calls, 0)} Jev calls, $${spend.reduce((a, s) => a + s.cost, 0).toFixed(4)}${when(w)}`,
    uses: spend.map((s) => ({ use: s.use, calls: s.calls, failed: s.failed, cost: Number(s.cost.toFixed(5)), avg_ms: s.avgMs })),
    compaction_advisor: advice,
  };
}

/** Tool gate decisions (metrics.db gate_log): counts by decision, and the ones that were not plain allows. */
export function gateQuery(w: Window): Res {
  let rows: { decision: string; n: number }[] = [];
  let recent: { ts: string; agent: string; decision: string; summary: string }[] = [];
  try {
    rows = metricsDb().query("SELECT decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ts < ? GROUP BY decision ORDER BY n DESC").all(w.from, w.to) as typeof rows;
    recent = metricsDb().query("SELECT ts, agent, decision, summary FROM gate_log WHERE ts >= ? AND ts < ? AND decision NOT IN ('allow', 'observe-allow', 'screen-ok') ORDER BY id DESC LIMIT 15").all(w.from, w.to) as typeof recent;
  } catch {
    /* no log yet */
  }
  return {
    ok: true,
    message: rows.length ? rows.map((r) => `${r.decision} ${r.n}`).join(", ") : `0 gate decisions${when(w)}`,
    notable: recent.map((r) => ({ ts: r.ts, agent: r.agent, decision: r.decision, call: r.summary })),
  };
}

/** Voyages started in the window, and any still open, with ship and cost (metrics.db voyage_totals). */
export function voyagesQuery(w: Window): Res {
  let rows: { id: string; ship: string; goal: string; started: string; docked: string | null; commits: number | null; turns: number; cost: number }[] = [];
  try {
    rows = metricsDb()
      .query("SELECT v.id, v.ship, v.goal, v.started, v.docked, v.commits, v.turns, v.cost FROM voyage_totals v WHERE (v.started >= ? AND v.started < ?) OR (v.docked IS NULL AND v.started < ?) ORDER BY v.started DESC")
      .all(w.from, w.to, w.to) as typeof rows;
  } catch {
    /* no metrics yet */
  }
  const open = rows.filter((r) => !r.docked).length;
  return {
    ok: true,
    message: `${rows.length} voyage(s): ${open} open, ${rows.length - open} docked (started ${w.label}, plus any still open); $${rows.reduce((a, r) => a + r.cost, 0).toFixed(2)}`,
    voyages: rows.map((r) => ({ id: r.id, ship: r.ship, goal: r.goal, state: r.docked ? "docked" : "open", started: r.started, commits: r.commits, turns: r.turns, cost: usd(r.cost) })),
  };
}

/** Run a named query. `days` (default 7) is clamped to 1..365; `since`/`until` set the window instead (see resolveWindow); `by` applies to spend only. */
export function fleetQuery(name: string, opts: { days?: number; by?: string; since?: string; until?: string } = {}): Res {
  if (!(FLEET_QUERIES as readonly string[]).includes(name)) return { ok: false, message: `Unknown query "${name}". Queries: ${FLEET_QUERIES.join(", ")}.` };
  const w = resolveWindow(opts);
  if (typeof w === "string") return { ok: false, message: w };
  if (name === "spend") {
    const by = opts.by || "agent";
    if (!(SPEND_BY as readonly string[]).includes(by)) return { ok: false, message: `Cannot group spend by "${by}". Use by: ${SPEND_BY.join(", ")}.` };
    return spendQuery(w, by as SpendBy);
  }
  if (opts.by) return { ok: false, message: `by applies to spend only (not ${name}).` };
  if (name === "tool_failures") return toolFailuresQuery(w);
  if (name === "jev") return jevQuery(w);
  if (name === "gate") return gateQuery(w);
  return voyagesQuery(w);
}
