import { compactionAdviceSummary } from "./compaction-advisor.ts";
import { jevSpend } from "./jev.ts";
import { metricsDb } from "./metrics.ts";
import { aliceVault } from "./paths.ts";
import { surveyFiles, surveyStats } from "./survey-stats.ts";
import { toolFailureCounts, toolFailureDays, toolFailuresSince } from "./tool-failures.ts";

/**
 * fleet_query (vault plan alice-memory-and-tools, M1): the exact questions an
 * officer used to answer with ad hoc sqlite3 over metrics.db and journal.db,
 * as named, parameterized, read-only queries. No SQL goes in. One library for
 * the pi tool (through the node) and `bin/fleet-axi query`.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

export const FLEET_QUERIES = ["spend", "tool_failures", "jev", "gate", "voyages", "surveys"] as const;
export type FleetQuery = (typeof FLEET_QUERIES)[number];
export const SPEND_BY = ["agent", "model", "day"] as const;
export type SpendBy = (typeof SPEND_BY)[number];

const MAX_DAYS = 365;
const MAX_LIMIT = 200;
const usd = (n: number) => Number(n.toFixed(4));
const DAY_MS = 86_400_000;
const LATEST_FAILURES = 8;
const NOTABLE_GATE = 15;
const BY_AGENT_TOOL = 20;

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

/** `{ <name>_shown: "N of M" }` when a list was cut to its first `max`; nothing when it all fits. */
const shownOf = (name: string, kept: number, total: number): Record<string, string> => (total > kept ? { [`${name}_shown`]: `${kept} of ${total}` } : {});

/** Failed tool calls and dead turns (journal.db tool_failures; expected non-zero exits left out). Totals cover the whole window; the lists are cut and say so. */
export function toolFailuresQuery(w: Window, limit?: number): Res {
  const pairs = toolFailureCounts(0, w);
  const total = pairs.reduce((a, r) => a + r.n, 0);
  const byTool = new Map<string, number>();
  for (const r of pairs) byTool.set(r.tool, (byTool.get(r.tool) ?? 0) + r.n);
  const latest = toolFailuresSince(w.from, limit ?? LATEST_FAILURES, w.to);
  const days = toolFailureDays(w);
  return {
    ok: true,
    message: `${total} tool failure(s)${when(w)}`,
    by_tool: [...byTool].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tool, n]) => ({ tool, n })),
    failures_by_day: days,
    by_agent_tool: pairs.slice(0, limit ?? BY_AGENT_TOOL).map((r) => ({ agent: r.agent, tool: r.tool, n: r.n, last: r.last })),
    ...shownOf("by_agent_tool", Math.min(limit ?? BY_AGENT_TOOL, pairs.length), pairs.length),
    latest: latest.map((f) => ({ ts: f.ts, agent: f.agent, tool: f.tool, error: f.error })),
    ...shownOf("latest", latest.length, total),
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

/** What a gate_log decision means, in plain words. `sources` are where its rows came from (a stop is a local rule or Jev). */
function gateLabel(decision: string, sources: string[]): string {
  if (decision === "stop") return sources.every((s) => s === "local") ? "stopped (local rule, enforced in every mode)" : "stopped (a local rule, or Jev's verdict in enforce mode)";
  return (
    {
      "observe-allow": "allowed (observe mode)",
      "observe-hold": "would hold (observe mode: let through)",
      "observe-stop": "would stop (observe mode: let through)",
      allow: "allowed",
      hold: "held for the captain",
      allowed: "captain allowed",
      denied: "captain denied",
      "screen-ok": "result screened: clean",
      "screen-flag": "result screened: flagged as possible injected instructions",
      "screen-error": "result screen failed (Jev error)",
    } as Record<string, string>
  )[decision] ?? decision;
}

/** The short phrase for the one-line message. */
const GATE_SHORT: Record<string, string> = {
  "observe-allow": "allowed",
  allow: "allowed",
  "observe-hold": "would hold (let through)",
  "observe-stop": "would stop (let through)",
  hold: "held",
  stop: "stopped",
  allowed: "captain allowed",
  denied: "captain denied",
};

/** Decisions that let the call go on without a second look; the others are the notable ones. */
const GATE_PLAIN = ["allow", "observe-allow", "screen-ok", "allowed"];

/**
 * Tool gate decisions (metrics.db gate_log) over the whole window: counts by decision with what each
 * means, the mode, who and when the non-allows fell, and the latest few of them.
 */
export function gateQuery(w: Window, limit?: number): Res {
  let rows: { decision: string; source: string; n: number }[] = [];
  let recent: { ts: string; agent: string; decision: string; summary: string }[] = [];
  let byAgent: { k: string; decision: string; n: number }[] = [];
  let byDay: { k: string; decision: string; n: number }[] = [];
  const plain = GATE_PLAIN.map((d) => `'${d}'`).join(", ");
  try {
    const db = metricsDb();
    rows = db.query("SELECT decision, source, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ts < ? GROUP BY decision, source").all(w.from, w.to) as typeof rows;
    recent = db.query(`SELECT ts, agent, decision, summary FROM gate_log WHERE ts >= ? AND ts < ? AND decision NOT IN (${plain}) ORDER BY id DESC LIMIT ${limit ?? NOTABLE_GATE}`).all(w.from, w.to) as typeof recent;
    byAgent = db.query(`SELECT agent AS k, decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ts < ? AND decision NOT IN (${plain}) GROUP BY k, decision`).all(w.from, w.to) as typeof byAgent;
    byDay = db.query(`SELECT substr(ts, 1, 10) AS k, decision, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ts < ? AND decision NOT IN (${plain}) GROUP BY k, decision`).all(w.from, w.to) as typeof byDay;
  } catch {
    /* no log yet */
  }
  const counts = new Map<string, { n: number; sources: string[] }>();
  for (const r of rows) {
    const c = counts.get(r.decision) ?? { n: 0, sources: [] };
    counts.set(r.decision, { n: c.n + r.n, sources: [...c.sources, r.source] });
  }
  const decisions = [...counts].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).map(([decision, c]) => ({ decision, label: gateLabel(decision, c.sources), n: c.n }));
  const has = (f: (d: string) => boolean) => decisions.some((d) => f(d.decision));
  const observe = has((d) => d.startsWith("observe-"));
  const enforce = has((d) => d === "hold" || d === "allow");
  const mode = observe && enforce ? "mixed" : observe ? "observe" : enforce ? "enforce" : "none";
  const acts = decisions.filter((d) => !d.decision.startsWith("screen-")).map((d) => `${d.n} ${GATE_SHORT[d.decision] ?? d.decision}`);
  const screened = decisions.filter((d) => d.decision.startsWith("screen-")).map((d) => `${d.n} ${d.decision === "screen-ok" ? "clean" : d.decision === "screen-flag" ? "flagged" : "failed"}`);
  const message = decisions.length
    ? [`${mode} mode: ${acts.join(", ") || "no calls judged"}`, screened.length ? `results screened ${screened.join(", ")}` : ""].filter(Boolean).join("; ")
    : `0 gate decisions${when(w)}`;
  // Per agent or day: the non-allow decisions as "observe-hold 40, stop 2", biggest first.
  const fold = (list: typeof byAgent, key: string, newestFirst = false) => {
    const m = new Map<string, { n: number; by: [string, number][] }>();
    for (const r of list) {
      const e = m.get(r.k) ?? { n: 0, by: [] };
      m.set(r.k, { n: e.n + r.n, by: [...e.by, [r.decision, r.n]] });
    }
    return [...m]
      .sort((a, b) => (newestFirst ? b[0].localeCompare(a[0]) : b[1].n - a[1].n || a[0].localeCompare(b[0])))
      .map(([k, e]) => ({ [key]: k, n: e.n, decisions: e.by.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d, n]) => `${d} ${n}`).join(", ") }));
  };
  const notableTotal = decisions.filter((d) => !GATE_PLAIN.includes(d.decision)).reduce((a, d) => a + d.n, 0);
  return {
    ok: true,
    message,
    mode,
    decisions,
    not_allowed_by_agent: fold(byAgent, "agent"),
    not_allowed_by_day: fold(byDay, "day", true),
    notable: recent.map((r) => ({ ts: r.ts, agent: r.agent, decision: r.decision, call: r.summary })),
    ...shownOf("notable", recent.length, notableTotal),
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

/** Reviews and brainstorms dated in the window: findings and how they were resolved, cost, and which lenses to trim (survey-stats.ts). */
export function surveysQuery(w: Window): Res {
  const { files: all, skipped_files } = surveyFiles(aliceVault());
  const files = all.filter((f) => Date.parse(f.date) >= Date.parse(w.from) && Date.parse(f.date) < Date.parse(w.to));
  const stats = surveyStats(files);
  const sum = (k: "findings" | "fix" | "contest" | "escalate" | "decline" | "open") => stats.by_lens.reduce((a, r) => a + (r[k] ?? 0), 0);
  const trim = [...new Set(stats.by_lens.filter((r) => r.trim).map((r) => r.lens))];
  return {
    ok: true,
    message: `${files.length} review(s)${when(w)}: ${sum("findings")} findings, ${sum("fix")}/${sum("contest")}/${sum("escalate")}/${sum("decline")} fix/contest/escalate/decline, ${sum("open")} open; $${files.reduce((a, f) => a + f.cost, 0).toFixed(2)}; trim candidates: ${trim.join(", ") || "none"}`,
    // Own names: tool-out's fleet_query view already gives by_model the spend columns.
    survey_lenses: stats.by_lens,
    survey_models: stats.by_model,
    survey_lens_models: stats.by_lens_model,
    skipped_files,
  };
}

/**
 * Run a named query. `days` (default 7) is clamped to 1..365; `since`/`until` set the window instead (see resolveWindow); `by` applies to spend only.
 * `limit` (1..200) sets the rows of the lists the query itself cuts (gate notable, tool_failures latest and by_agent_tool); `full` lifts them to 200.
 */
export function fleetQuery(name: string, opts: { days?: number; by?: string; since?: string; until?: string; limit?: number; full?: boolean } = {}): Res {
  if (!(FLEET_QUERIES as readonly string[]).includes(name)) return { ok: false, message: `Unknown query "${name}". Queries: ${FLEET_QUERIES.join(", ")}.` };
  const w = resolveWindow(name === "surveys" ? { ...opts, days: opts.days ?? 30 } : opts); // reviews are few: look back 30 days
  if (typeof w === "string") return { ok: false, message: w };
  if (name === "spend") {
    const by = opts.by || "agent";
    if (!(SPEND_BY as readonly string[]).includes(by)) return { ok: false, message: `Cannot group spend by "${by}". Use by: ${SPEND_BY.join(", ")}.` };
    return spendQuery(w, by as SpendBy);
  }
  if (opts.by) return { ok: false, message: `by applies to spend only (not ${name}).` };
  const limit = opts.limit ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(opts.limit))) : opts.full ? MAX_LIMIT : undefined;
  if (name === "tool_failures") return toolFailuresQuery(w, limit);
  if (name === "jev") return jevQuery(w);
  if (name === "gate") return gateQuery(w, limit);
  if (name === "surveys") return surveysQuery(w);
  return voyagesQuery(w);
}
