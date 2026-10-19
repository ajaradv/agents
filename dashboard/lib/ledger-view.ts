import type { GateReport } from "./gates.ts";
import { dockedVoyages, mins, voyageLedger, type VoyageLedger, type VoyageTotals } from "./metrics.ts";
import { escapeHtml } from "./quota.ts";

/**
 * The voyage ledger on the ship deck (vault research note helm-and-maneuvers):
 * what the voyage under sail has taken so far (time, turns, cost per
 * crewmate, checks and maneuvers, gates, handoffs), and the same totals for
 * past voyages. Everything comes from the fleet metrics database (lib/metrics).
 */

const usd = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

function runChip(c: VoyageLedger["checks"][number]): string {
  const cls = c.lastOk ? "d-badge-success" : "d-badge-error";
  const runs = c.runs > 1 ? ` ${c.passed}/${c.runs}` : "";
  return `<li class="d-badge d-badge-soft d-badge-sm ${cls}" title="${escapeHtml(`${c.kind} ${c.name}: ${c.passed} of ${c.runs} runs passed, ${mins(c.ms)} in all; latest ${c.lastOk ? "passed" : "failed"}`)}">${c.lastOk ? "✓" : "✗"} ${escapeHtml(c.name)}${runs}</li>`;
}

function gateChips(r: GateReport): string {
  const mark = { green: "✓", failed: "✗", missing: "·", "unknown-check": "?" } as const;
  const cls = { green: "d-badge-success d-badge-soft", failed: "d-badge-error d-badge-soft", missing: "d-badge-ghost", "unknown-check": "d-badge-error d-badge-outline" } as const;
  const why = { green: "passed on this commit", failed: "failed on this commit", missing: "not run on this commit", "unknown-check": "not one of the ship's checks" } as const;
  return `<span class="ledger-gates"><span class="muted">${r.stage === "task" ? "Task gates" : "Dock gates"}</span><ul class="phase-chain ledger-chips">${r.gates
    .map((g) => `<li class="d-badge d-badge-sm ${cls[g.state]}" title="${escapeHtml(`${g.name} ${why[g.state]}${r.commit ? ` (${r.commit.slice(0, 7)})` : ""}`)}">${mark[g.state]} ${escapeHtml(g.name)}</li>`)
    .join("")}</ul>${r.dirty ? `<span class="warn">uncommitted changes</span>` : ""}</span>`;
}

function crewTable(l: VoyageLedger, label: (id: string) => string): string {
  if (!l.crew.length) return `<p class="muted">No crew turns yet.</p>`;
  const rows = l.crew
    .map(
      (c) => `<tr>
        <td>${escapeHtml(label(c.agent))}</td>
        <td>${c.model ? `<code>${escapeHtml(c.model)}</code>` : `<span class="muted" title="Turns from before models were recorded, or stopped before they reported one">not recorded</span>`}${c.mode === "vm" ? ` <span class="muted">VM</span>` : ""}</td>
        <td class="num">${c.turns}${c.failed ? ` <span class="warn">${c.failed} failed</span>` : ""}</td>
        <td class="num">${mins(c.ms ?? 0)}</td>
        <td class="num">${usd(c.cost ?? 0)}</td>
      </tr>`,
    )
    .join("");
  return `<div class="overflow-x-auto metric-table"><table class="d-table d-table-zebra d-table-sm bg-base-100"><thead><tr><th>Crewmate</th><th>Model</th><th class="num">Turns</th><th class="num">Time</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function runsHtml(l: VoyageLedger): string {
  const checks = l.checks.filter((c) => c.kind === "check");
  const maneuvers = l.checks.filter((c) => c.kind === "maneuver");
  const part = (title: string, rows: typeof checks) => (rows.length ? `<span class="ledger-gates"><span class="muted">${title}</span><ul class="phase-chain ledger-chips">${rows.map(runChip).join("")}</ul></span>` : "");
  return part("Maneuvers", maneuvers) + part("Checks", checks);
}

function handoffLine(l: VoyageLedger): string {
  const n = l.handoffs.reduce((s, h) => s + h.n, 0);
  return n ? `${n} handoff${n === 1 ? "" : "s"}` : "";
}

/** The ledger of the voyage under sail. */
export function liveLedgerHtml(id: string, label: (id: string) => string, gates: GateReport[]): string {
  const l = voyageLedger(id);
  if (!l) return "";
  const handoffs = handoffLine(l);
  const gateHtml = gates.filter((g) => g.gates.length).map(gateChips).join("");
  return `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100 ledger" open>
    <summary class="d-collapse-title">Ledger · ${mins(l.elapsedMs)} · ${l.totalTurns} turn${l.totalTurns === 1 ? "" : "s"} · ${usd(l.totalCost)}</summary>
    <div class="d-collapse-content stack-tight">
      ${crewTable(l, label)}
      <div class="ledger-runs">${runsHtml(l)}${gateHtml}</div>
      ${handoffs ? `<p class="muted" title="${escapeHtml(l.handoffs.map((h) => `${h.n} ${h.kind}`).join(", "))}">${handoffs} between crewmates and the helm</p>` : ""}
    </div>
  </details>`;
}

function pastRow(v: VoyageTotals, label: (id: string) => string): string {
  const l = voyageLedger(v.id);
  const time = v.docked ? mins(Date.parse(v.docked) - Date.parse(v.started)) : "";
  const checks = v.checks ? `${v.checksPassed}/${v.checks}` : "–";
  const detail = l
    ? `${crewTable(l, label)}<div class="ledger-runs">${runsHtml(l)}</div>${v.branch ? `<p class="muted">Branch <code>${escapeHtml(v.branch)}</code>${v.commits !== null ? ` · ${v.commits} commit${v.commits === 1 ? "" : "s"}` : ""}</p>` : ""}${v.outcome ? `<p class="muted">${escapeHtml(v.outcome.slice(0, 300))}</p>` : ""}`
    : "";
  return `<li class="ledger-past">
    <details>
      <summary class="ledger-past-row">
        <span class="ledger-goal" title="${escapeHtml(v.goal)}">${escapeHtml(v.goal.length > 140 ? `${v.goal.slice(0, 139)}…` : v.goal)}</span>
        <span class="muted ledger-nums">${escapeHtml(v.started.slice(0, 10))} · ${time} · ${v.turns} turns · ${usd(v.cost)} · checks ${checks}</span>
      </summary>
      <div class="stack-tight ledger-detail">${detail}</div>
    </details>
  </li>`;
}

/** Docked voyages with their ledgers, newest first. */
export function pastLedgerHtml(ship: string, label: (id: string) => string, limit = 8): string {
  const past = dockedVoyages(ship, limit);
  if (!past.length) return "";
  const cost = past.reduce((s, v) => s + v.cost, 0);
  return `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"><summary class="d-collapse-title">${past.length} past voyage${past.length === 1 ? "" : "s"} · ${usd(cost)}</summary><ul class="d-collapse-content ledger-list">${past.map((v) => pastRow(v, label)).join("")}</ul></details>`;
}
