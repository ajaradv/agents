import { metricsDb, mins } from "./metrics.ts";
import { escapeHtml } from "./quota.ts";

/**
 * The fleet metrics dashboard on Health (vault research note
 * helm-and-maneuvers): time, cost, and results by role, model, mode, ship,
 * check, and maneuver, from the fleet metrics database (lib/metrics). The
 * model spend table above it reads Pi's session logs per agent; this one
 * answers the questions only the metrics database can: what a role or a mode
 * costs per turn, how often checks pass, what voyages take.
 */

export const PERIODS = [7, 30, 0] as const;
export type Period = (typeof PERIODS)[number];

export function parsePeriod(raw: string | null): Period {
  if (!raw) return 7;
  const n = Number(raw);
  return (PERIODS as readonly number[]).includes(n) ? (n as Period) : 7;
}

const since = (days: Period) => (days ? new Date(Date.now() - days * 86_400_000).toISOString() : "");
const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? (n < 0.01 ? "<$0.01" : `$${n.toFixed(3)}`) : "$0");
const pct = (x: number | null) => (x === null || Number.isNaN(x) ? "–" : `${Math.round(x * 100)}%`);

export type MetricsData = {
  days: Period;
  kpi: { cost: number; turns: number; failed: number; cacheShare: number | null; voyages: number; voyageCost: number; voyageMs: number; checkRuns: number; checkPassed: number; maneuverRuns: number };
  daily: { day: string; role: string; cost: number; turns: number }[];
  byRole: { role: string; model: string; mode: string; turns: number; cost: number; ms: number; cacheShare: number | null; failed: number }[];
  byMode: { mode: string; turns: number; cost: number; ms: number }[];
  runs: { ship: string; kind: string; name: string; runs: number; passed: number; ms: number; lastOk: number; lastTs: string }[];
  voyages: { ship: string; goal: string; started: string; docked: string | null; turns: number; cost: number; checks: number; checksPassed: number; commits: number | null }[];
  handoffs: { kind: string; n: number }[];
};

export function metricsData(days: Period): MetricsData {
  const d = metricsDb();
  const from = since(days);
  const k = d
    .query("SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS turns, COALESCE(SUM(1 - ok), 0) AS failed, 1.0 * SUM(cache_read) / NULLIF(SUM(prompt), 0) AS cacheShare FROM turns WHERE ts >= ?")
    .get(from) as { cost: number; turns: number; failed: number; cacheShare: number | null };
  const v = d
    .query(`SELECT COUNT(*) AS voyages, COALESCE(AVG(cost), 0) AS voyageCost, COALESCE(AVG((julianday(docked) - julianday(started)) * 86400000), 0) AS voyageMs
      FROM voyage_totals WHERE docked IS NOT NULL AND docked >= ?`)
    .get(from) as { voyages: number; voyageCost: number; voyageMs: number };
  const r = d
    .query("SELECT COALESCE(SUM(kind = 'check'), 0) AS checkRuns, COALESCE(SUM(kind = 'check' AND ok = 1), 0) AS checkPassed, COALESCE(SUM(kind = 'maneuver'), 0) AS maneuverRuns FROM runs WHERE ts >= ?")
    .get(from) as { checkRuns: number; checkPassed: number; maneuverRuns: number };
  return {
    days,
    kpi: { ...k, ...v, ...r },
    daily: d.query("SELECT substr(ts, 1, 10) AS day, role, SUM(cost) AS cost, COUNT(*) AS turns FROM turns WHERE ts >= ? GROUP BY day, role ORDER BY day").all(days ? from : new Date(Date.now() - 30 * 86_400_000).toISOString()) as MetricsData["daily"],
    byRole: d
      .query("SELECT role, model, mode, COUNT(*) AS turns, SUM(cost) AS cost, SUM(ms) AS ms, 1.0 * SUM(cache_read) / NULLIF(SUM(prompt), 0) AS cacheShare, SUM(1 - ok) AS failed FROM turns WHERE ts >= ? GROUP BY role, model, mode ORDER BY cost DESC, turns DESC")
      .all(from) as MetricsData["byRole"],
    byMode: d.query("SELECT mode, COUNT(*) AS turns, SUM(cost) AS cost, SUM(ms) AS ms FROM turns WHERE ts >= ? AND ship != '' GROUP BY mode ORDER BY mode").all(from) as MetricsData["byMode"],
    runs: d
      .query(`SELECT ship, kind, name, COUNT(*) AS runs, SUM(ok) AS passed, AVG(ms) AS ms,
          (SELECT ok FROM runs r2 WHERE r2.ship = runs.ship AND r2.kind = runs.kind AND r2.name = runs.name ORDER BY id DESC LIMIT 1) AS lastOk, MAX(ts) AS lastTs
        FROM runs WHERE ts >= ? GROUP BY ship, kind, name ORDER BY ship, kind DESC, name`)
      .all(from) as MetricsData["runs"],
    voyages: d
      .query(`SELECT t.ship, t.goal, t.started, t.docked, t.turns, t.cost, t.commits,
          (SELECT COUNT(*) FROM runs r WHERE r.voyage = t.id AND r.kind = 'check') AS checks,
          (SELECT COALESCE(SUM(ok), 0) FROM runs r WHERE r.voyage = t.id AND r.kind = 'check') AS checksPassed
        FROM voyage_totals t WHERE t.started >= ? ORDER BY t.started DESC LIMIT 12`)
      .all(from) as MetricsData["voyages"],
    handoffs: d.query("SELECT kind, COUNT(*) AS n FROM handoffs WHERE ts >= ? GROUP BY kind ORDER BY n DESC").all(from) as MetricsData["handoffs"],
  };
}

/** Role colours for the daily chart: a fixed order so a role keeps its colour. */
const ROLE_ORDER = ["lead", "designer", "scout", "alice", "architect", "firstmate"];
const roleClass = (role: string) => {
  const i = ROLE_ORDER.indexOf(role);
  return `role-${i >= 0 ? i : ROLE_ORDER.length}`;
};

/** Every day from `span` days ago to today (UTC dates, as the turns are stamped). */
export function dayAxis(span: number, now = Date.now()): string[] {
  return Array.from({ length: span }, (_, i) => new Date(now - (span - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

function dailyChart(rows: MetricsData["daily"], span: number): string {
  if (!rows.length) return "";
  // Days without turns stay on the axis as gaps, so the chart shows the whole period.
  const days = dayAxis(span);
  const rank = (role: string) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : 99);
  const roles = [...new Set(rows.map((r) => r.role))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const total = (day: string) => rows.filter((r) => r.day === day).reduce((s, r) => s + r.cost, 0);
  const max = Math.max(...days.map(total), 0.0001);
  const bars = days
    .map((day, i) => {
      const t = total(day);
      const segs = roles
        .map((role) => {
          const r = rows.find((x) => x.day === day && x.role === role);
          if (!r || r.cost <= 0) return "";
          return `<span class="bar-seg ${roleClass(role)}" style="height:${((r.cost / max) * 100).toFixed(1)}%" title="${escapeHtml(`${day} · ${role}: ${usd(r.cost)} over ${r.turns} turns`)}"></span>`;
        })
        .join("");
      return `<li class="bar" title="${escapeHtml(`${day}: ${usd(t)}`)}"><span class="bar-stack">${segs}</span><span class="bar-label">${days.length <= 10 || i % 5 === 0 || i === days.length - 1 ? escapeHtml(day.slice(5)) : ""}</span></li>`;
    })
    .join("");
  const legend = roles.map((r) => `<li><span class="swatch ${roleClass(r)}"></span>${escapeHtml(r)}</li>`).join("");
  return `<figure class="metric-chart">
      <figcaption class="muted">Spend per day by role, last ${span} days · highest ${usd(max)}</figcaption>
      <ol class="bars" aria-label="Spend per day">${bars}</ol>
      <ul class="legend">${legend}</ul>
    </figure>`;
}

function kpis(m: MetricsData): string {
  const k = m.kpi;
  const cell = (label: string, value: string, note = "") => `<div class="kpi"><span class="muted">${label}</span><b>${value}</b>${note ? `<span class="muted">${note}</span>` : ""}</div>`;
  return `<div class="kpis metric-kpis">
      ${cell("Spend", usd(k.cost), `${k.turns} turns${k.failed ? ` · <span class="warn">${k.failed} failed</span>` : ""}`)}
      ${cell("Cost per turn", k.turns ? usd(k.cost / k.turns) : "–", `cache ${pct(k.cacheShare)}`)}
      ${cell("Voyages docked", String(k.voyages), k.voyages ? `avg ${usd(k.voyageCost)} · ${mins(k.voyageMs)}` : "")}
      ${cell("Checks passed", k.checkRuns ? pct(k.checkPassed / k.checkRuns) : "–", `${k.checkRuns} runs · ${k.maneuverRuns} maneuver${k.maneuverRuns === 1 ? "" : "s"}`)}
    </div>`;
}

function roleTable(rows: MetricsData["byRole"]): string {
  if (!rows.length) return "";
  const body = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.role)}</td>
        <td>${r.model ? `<code>${escapeHtml(r.model)}</code>` : `<span class="muted" title="Turns from before models were recorded">not recorded</span>`}</td>
        <td>${r.mode === "vm" ? "VM" : "host"}</td>
        <td class="num">${r.turns}${r.failed ? ` <span class="warn">${r.failed}✗</span>` : ""}</td>
        <td class="num">${usd(r.cost)}</td>
        <td class="num">${usd(r.cost / r.turns)}</td>
        <td class="num">${mins(r.ms / r.turns)}</td>
        <td class="num ${r.cacheShare !== null && r.cacheShare < 0.5 ? "warn" : ""}">${pct(r.cacheShare)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="spend-table ledger-table">
      <thead><tr><th>Role</th><th>Model</th><th>Mode</th><th class="num">Turns</th><th class="num">Cost</th><th class="num" title="Average cost of one turn">Per turn</th><th class="num" title="Average time of one turn">Time</th><th class="num" title="Share of prompt tokens read from the provider's cache">Cache</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

function modeLine(rows: MetricsData["byMode"]): string {
  const vm = rows.find((r) => r.mode === "vm");
  const host = rows.find((r) => r.mode === "host");
  if (!vm || !host) return "";
  const part = (label: string, r: (typeof rows)[number]) => `${label}: ${usd(r.cost / r.turns)} and ${mins(r.ms / r.turns)} per turn over ${r.turns}`;
  return `<p class="muted">Crew turns by mode · ${part("in a VM", vm)} · ${part("on the host", host)}</p>`;
}

function runsTable(rows: MetricsData["runs"]): string {
  if (!rows.length) return `<p class="muted">No check or maneuver runs in this period.</p>`;
  const body = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.ship)}</td>
        <td>${r.kind === "maneuver" ? "maneuver" : "check"} <strong>${escapeHtml(r.name)}</strong></td>
        <td class="num">${r.runs}</td>
        <td class="num ${r.passed < r.runs ? "warn" : ""}">${pct(r.passed / r.runs)}</td>
        <td class="num">${mins(r.ms)}</td>
        <td>${r.lastOk ? "✓ passed" : `<span class="warn">✗ failed</span>`} <span class="muted">${escapeHtml(r.lastTs.slice(5, 16).replace("T", " "))}</span></td>
      </tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table class="spend-table ledger-table">
      <thead><tr><th>Ship</th><th>Run</th><th class="num">Runs</th><th class="num">Passed</th><th class="num" title="Average time of one run">Time</th><th>Latest</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

function voyagesTable(rows: MetricsData["voyages"]): string {
  if (!rows.length) return `<p class="muted">No voyages in this period.</p>`;
  const body = rows
    .map((v) => {
      const time = v.docked ? mins(Date.parse(v.docked) - Date.parse(v.started)) : "under sail";
      return `<tr>
        <td>${escapeHtml(v.ship)}</td>
        <td><span title="${escapeHtml(v.goal)}">${escapeHtml(v.goal.length > 90 ? `${v.goal.slice(0, 89)}…` : v.goal)}</span> <span class="muted">${escapeHtml(v.started.slice(5, 10))}</span></td>
        <td class="num">${time}</td>
        <td class="num">${v.turns}</td>
        <td class="num">${usd(v.cost)}</td>
        <td class="num">${v.checks ? `${v.checksPassed}/${v.checks}` : "–"}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="spend-table ledger-table">
      <thead><tr><th>Ship</th><th>Voyage</th><th class="num">Time</th><th class="num">Turns</th><th class="num">Cost</th><th class="num">Checks</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

export function metricsDashboardHtml(days: Period): string {
  let m: MetricsData;
  try {
    m = metricsData(days);
  } catch (e) {
    return `<p class="warn">The metrics database could not be read: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
  }
  const label = (p: Period) => (p ? `${p} days` : "All time");
  const tabs = PERIODS.map(
    (p) => `<button type="button" class="btn${p === days ? " btn-ink" : ""}" aria-pressed="${p === days}" hx-get="/partials/fleet-metrics?days=${p}" hx-target="#fleet-metrics" hx-swap="innerMorph">${label(p)}</button>`,
  ).join("");
  const handoffs = m.handoffs.length ? `<p class="muted">Handoffs · ${m.handoffs.map((h) => `${h.n} ${escapeHtml(h.kind)}`).join(" · ")}</p>` : "";
  return `<section class="stack fleet-metrics">
      <div class="between"><h3>Fleet metrics</h3><div class="row-wrap" role="group" aria-label="Period">${tabs}</div></div>
      ${m.kpi.turns || m.voyages.length || m.runs.length ? "" : `<p class="muted">Nothing recorded in this period yet.</p>`}
      ${kpis(m)}
      ${dailyChart(m.daily, days || 30)}
      <h4>By role and model</h4>
      ${roleTable(m.byRole) || `<p class="muted">No turns in this period.</p>`}
      ${modeLine(m.byMode)}
      <h4>Checks and maneuvers</h4>
      ${runsTable(m.runs)}
      <h4>Voyages</h4>
      ${voyagesTable(m.voyages)}
      ${handoffs}
      <p class="muted spend-note">From the fleet metrics database (fleet/inbox/.node/metrics.db): every turn, check, maneuver, and handoff the node records, with its voyage. Query it directly for anything else; docs/metrics.md lists the tables and views.</p>
    </section>`;
}
