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
  checksDaily: { day: string; passed: number; failed: number }[];
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
    checksDaily: d
      .query("SELECT substr(ts, 1, 10) AS day, SUM(ok) AS passed, SUM(1 - ok) AS failed FROM runs WHERE kind = 'check' AND ts >= ? GROUP BY day ORDER BY day")
      .all(days ? from : new Date(Date.now() - 30 * 86_400_000).toISOString()) as MetricsData["checksDaily"],
  };
}

/** Role colours: a fixed order so a role keeps its colour in every chart (the pixel palette). */
const ROLE_ORDER = ["lead", "designer", "scout", "helmsman", "alice", "architect", "firstmate"];
const ROLE_COLORS = ["#2436a8", "#9c1230", "#0f6e68", "#8a6200", "#6b4fa0", "#3d4a3a", "#1a1a1a"];
const roleColor = (role: string) => ROLE_COLORS[ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : ROLE_COLORS.length - 1]!;
const rank = (role: string) => (ROLE_ORDER.includes(role) ? ROLE_ORDER.indexOf(role) : 99);

/** Every day from `span` days ago to today (UTC dates, as the turns are stamped). */
export function dayAxis(span: number, now = Date.now()): string[] {
  return Array.from({ length: span }, (_, i) => new Date(now - (span - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Shared ECharts look: the pixel fonts and ink, no animation, room for labels. */
const CHART_BASE = {
  animation: false,
  textStyle: { fontFamily: "Departure Mono, ui-monospace, monospace", color: "#1a1a1a" },
  grid: { left: 8, right: 12, top: 36, bottom: 8, containLabel: true },
  legend: { type: "scroll", top: 0, left: 0, right: 0, itemWidth: 12, itemHeight: 12, icon: "rect", textStyle: { fontSize: 11 }, pageIconSize: 10 },
  tooltip: { trigger: "axis", backgroundColor: "#fffaf2", borderColor: "#1a1a1a", borderWidth: 2, textStyle: { color: "#1a1a1a", fontSize: 12 } },
};
const axisX = (days: string[]) => ({ type: "category", data: days.map((d) => d.slice(5)), axisLine: { lineStyle: { color: "#1a1a1a", width: 2 } }, axisTick: { show: false }, axisLabel: { fontSize: 10 } });
const axisY = (formatter: string) => ({ type: "value", splitLine: { lineStyle: { color: "rgba(26,26,26,0.12)" } }, axisLabel: { formatter, fontSize: 10 } });
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

/** ECharts options as data (JSON): the page renders them (public/app.js, charts load on demand). */
export function spendChart(rows: MetricsData["daily"], span: number): object | null {
  if (!rows.length) return null;
  const days = dayAxis(span);
  const roles = [...new Set(rows.map((r) => r.role))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {
    ...CHART_BASE,
    xAxis: axisX(days),
    yAxis: axisY("${value}"),
    series: roles.map((role) => ({
      name: role,
      type: "bar",
      stack: "spend",
      barMaxWidth: 28,
      itemStyle: { color: roleColor(role) },
      data: days.map((day) => round(rows.find((r) => r.day === day && r.role === role)?.cost ?? 0)),
    })),
  };
}

export function perTurnChart(rows: MetricsData["daily"], span: number): object | null {
  if (!rows.length) return null;
  const days = dayAxis(span);
  const roles = [...new Set(rows.map((r) => r.role))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {
    ...CHART_BASE,
    xAxis: axisX(days),
    yAxis: axisY("${value}"),
    series: roles.map((role) => ({
      name: role,
      type: "line",
      step: "middle",
      connectNulls: true,
      symbol: "rect",
      symbolSize: 6,
      lineStyle: { width: 2, color: roleColor(role) },
      itemStyle: { color: roleColor(role) },
      data: days.map((day) => {
        const r = rows.find((x) => x.day === day && x.role === role);
        return r && r.turns ? round(r.cost / r.turns) : null;
      }),
    })),
  };
}

export function checksChart(rows: MetricsData["checksDaily"], span: number): object | null {
  if (!rows.length) return null;
  const days = dayAxis(span);
  const at = (day: string) => rows.find((r) => r.day === day);
  return {
    ...CHART_BASE,
    xAxis: axisX(days),
    yAxis: { ...axisY("{value}"), minInterval: 1 },
    series: [
      { name: "passed", type: "bar", stack: "runs", barMaxWidth: 28, itemStyle: { color: "#1f7a45" }, data: days.map((d) => at(d)?.passed ?? 0) },
      { name: "failed", type: "bar", stack: "runs", barMaxWidth: 28, itemStyle: { color: "#9c1230" }, data: days.map((d) => at(d)?.failed ?? 0) },
    ],
  };
}

function chartCard(title: string, option: object | null, note = ""): string {
  if (!option) return "";
  return `<figure class="d-card d-card-border bg-base-100 metric-chart">
      <div class="d-card-body p-3 gap-2">
        <figcaption class="d-card-title text-sm">${escapeHtml(title)}</figcaption>
        <div class="echart" role="img" aria-label="${escapeHtml(title)}" data-option="${escapeHtml(JSON.stringify(option))}"></div>
        ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ""}
      </div>
    </figure>`;
}

function kpis(m: MetricsData): string {
  const k = m.kpi;
  const stat = (title: string, value: string, desc = "") => `<div class="d-stat"><div class="d-stat-title">${title}</div><div class="d-stat-value text-2xl">${value}</div>${desc ? `<div class="d-stat-desc">${desc}</div>` : ""}</div>`;
  return `<div class="d-stats grid grid-flow-row grid-cols-2 lg:grid-cols-4 w-full bg-base-100 metric-kpis">
      ${stat("Spend", usd(k.cost), `${k.turns} turns${k.failed ? ` · <span class="text-error">${k.failed} failed</span>` : ""}`)}
      ${stat("Cost per turn", k.turns ? usd(k.cost / k.turns) : "–", `cache ${pct(k.cacheShare)}`)}
      ${stat("Voyages docked", String(k.voyages), k.voyages ? `avg ${usd(k.voyageCost)} · ${mins(k.voyageMs)}` : "")}
      ${stat("Checks passed", k.checkRuns ? pct(k.checkPassed / k.checkRuns) : "–", `${k.checkRuns} runs · ${k.maneuverRuns} maneuver${k.maneuverRuns === 1 ? "" : "s"}`)}
    </div>`;
}

const table = (head: string, body: string) => `<div class="overflow-x-auto metric-table"><table class="d-table d-table-zebra d-table-sm bg-base-100"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

function roleTable(rows: MetricsData["byRole"]): string {
  if (!rows.length) return "";
  const body = rows
    .map(
      (r) => `<tr>
        <td><span class="swatch" style="background:${roleColor(r.role)}"></span> ${escapeHtml(r.role)}</td>
        <td>${r.model ? `<code>${escapeHtml(r.model)}</code>` : `<span class="muted" title="Turns from before models were recorded">not recorded</span>`}</td>
        <td>${r.mode === "vm" ? `<span class="d-badge d-badge-sm d-badge-outline">VM</span>` : "host"}</td>
        <td class="num">${r.turns}${r.failed ? ` <span class="text-error">${r.failed}✗</span>` : ""}</td>
        <td class="num">${usd(r.cost)}</td>
        <td class="num">${usd(r.cost / r.turns)}</td>
        <td class="num">${mins(r.ms / r.turns)}</td>
        <td class="num ${r.cacheShare !== null && r.cacheShare < 0.5 ? "text-error" : ""}">${pct(r.cacheShare)}</td>
      </tr>`,
    )
    .join("");
  return table(
    `<th>Role</th><th>Model</th><th>Mode</th><th class="num">Turns</th><th class="num">Cost</th><th class="num" title="Average cost of one turn">Per turn</th><th class="num" title="Average time of one turn">Time</th><th class="num" title="Share of prompt tokens read from the provider's cache">Cache</th>`,
    body,
  );
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
        <td>${r.kind === "maneuver" ? `<span class="d-badge d-badge-sm d-badge-outline">maneuver</span>` : "check"} <strong>${escapeHtml(r.name)}</strong></td>
        <td class="num">${r.runs}</td>
        <td class="num ${r.passed < r.runs ? "text-error" : ""}">${pct(r.passed / r.runs)}</td>
        <td class="num">${mins(r.ms)}</td>
        <td>${r.lastOk ? `<span class="text-success">✓ passed</span>` : `<span class="text-error">✗ failed</span>`} <span class="muted">${escapeHtml(r.lastTs.slice(5, 16).replace("T", " "))}</span></td>
      </tr>`,
    )
    .join("");
  return table(`<th>Ship</th><th>Run</th><th class="num">Runs</th><th class="num">Passed</th><th class="num" title="Average time of one run">Time</th><th>Latest</th>`, body);
}

function voyagesTable(rows: MetricsData["voyages"]): string {
  if (!rows.length) return `<p class="muted">No voyages in this period.</p>`;
  const body = rows
    .map((v) => {
      const time = v.docked ? mins(Date.parse(v.docked) - Date.parse(v.started)) : "under sail";
      return `<tr>
        <td>${escapeHtml(v.ship)}</td>
        <td class="goal"><span title="${escapeHtml(v.goal)}">${escapeHtml(v.goal.length > 90 ? `${v.goal.slice(0, 89)}…` : v.goal)}</span> <span class="muted">${escapeHtml(v.started.slice(5, 10))}</span></td>
        <td class="num">${time}</td>
        <td class="num">${v.turns}</td>
        <td class="num">${usd(v.cost)}</td>
        <td class="num">${v.checks ? `${v.checksPassed}/${v.checks}` : "–"}</td>
      </tr>`;
    })
    .join("");
  return table(`<th>Ship</th><th>Voyage</th><th class="num">Time</th><th class="num">Turns</th><th class="num">Cost</th><th class="num">Checks</th>`, body);
}

export function metricsDashboardHtml(days: Period): string {
  let m: MetricsData;
  try {
    m = metricsData(days);
  } catch (e) {
    return `<p class="warn">The metrics database could not be read: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`;
  }
  const label = (p: Period) => (p ? `${p} days` : "All time");
  const span = days || 30;
  const tabs = PERIODS.map(
    (p) => `<button type="button" class="d-btn d-btn-sm d-join-item${p === days ? " d-btn-neutral" : ""}" aria-pressed="${p === days}" hx-get="/partials/fleet-metrics?days=${p}" hx-target="#fleet-metrics" hx-swap="innerMorph">${label(p)}</button>`,
  ).join("");
  const handoffs = m.handoffs.length ? `<p class="muted">Handoffs · ${m.handoffs.map((h) => `${h.n} ${escapeHtml(h.kind)}`).join(" · ")}</p>` : "";
  const charts = [
    chartCard(`Spend per day by role, last ${span} days`, spendChart(m.daily, span)),
    chartCard("Cost per turn by role", perTurnChart(m.daily, span), "Average cost of one turn each day; a rising line is a role getting more expensive."),
    chartCard("Checks passed and failed", checksChart(m.checksDaily, span)),
  ].join("");
  return `<section class="stack fleet-metrics">
      <div class="between"><h3>Fleet metrics</h3><div class="d-join" role="group" aria-label="Period">${tabs}</div></div>
      ${m.kpi.turns || m.voyages.length || m.runs.length ? "" : `<p class="muted">Nothing recorded in this period yet.</p>`}
      ${kpis(m)}
      ${charts ? `<div class="grid gap-3 lg:grid-cols-2 metric-charts">${charts}</div>` : ""}
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
