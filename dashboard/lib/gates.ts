import type { ShipRow } from "./fleet-layers.ts";
import { latestRunOn } from "./metrics.ts";
import { runCheck, tail, treeState } from "./ship-checks.ts";
import { voyageWorktree } from "./voyage-worktree.ts";

/**
 * Declared gates (vault research note helm-and-maneuvers): checks a ship says
 * must pass on the latest commit before a task is done (`task`) and before a
 * voyage docks (`dock`), in fleet/ships/<ship>.yaml:
 *
 *   gates:
 *     task: [pytest]
 *     dock: [frontend, pytest]
 *
 * A gate is green only when that check's latest run on the current commit,
 * with no uncommitted changes, passed (runs record their commit: lib/metrics).
 * Success is earned, as in SSSF: the helm runs gates itself rather than
 * trusting a report, and code decides, not a model.
 */

export type GateStage = "task" | "dock";
export type GateState = { name: string; state: "green" | "failed" | "missing" | "unknown-check" };
export type GateReport = { stage: GateStage; commit: string; dirty: boolean; gates: GateState[]; green: boolean };

/** Where gates are judged: the voyage's worktree when one is open, else the ship's repo. */
export function gateFolder(ship: Pick<ShipRow, "id" | "path">): string {
  return voyageWorktree(ship.id)?.path ?? ship.path;
}

export async function gateStatus(ship: Pick<ShipRow, "id" | "path" | "gates" | "checks">, stage: GateStage): Promise<GateReport> {
  const names = ship.gates[stage];
  const { commit, dirty } = await treeState(gateFolder(ship));
  const gates: GateState[] = names.map((name) => {
    if (!ship.checks[name]) return { name, state: "unknown-check" };
    if (dirty) return { name, state: "missing" };
    const run = latestRunOn(ship.id, name, commit);
    return { name, state: !run ? "missing" : run.ok ? "green" : "failed" };
  });
  return { stage, commit, dirty, gates, green: gates.every((g) => g.state === "green") };
}

/** One sentence for a gate report. */
export function describeGates(r: GateReport): string {
  if (!r.gates.length) return `No ${r.stage} gates.`;
  if (r.green) return `${r.stage} gates green on ${r.commit.slice(0, 7)}: ${r.gates.map((g) => g.name).join(", ")}.`;
  const why = r.gates.filter((g) => g.state !== "green").map((g) => `${g.name} ${g.state === "missing" ? "not run on this commit" : g.state === "failed" ? "failed" : "is not a check of this ship"}`);
  return `${r.stage} gates not green${r.commit ? ` on ${r.commit.slice(0, 7)}` : ""}${r.dirty ? " (uncommitted changes: commit them first)" : ""}: ${why.join("; ")}.`;
}

/**
 * Run every gate of a stage that is not green yet, in order, and report. A
 * dirty tree is refused (gates judge commits). Unknown checks fail the stage.
 */
export async function runGates(ship: ShipRow, stage: GateStage, from: string): Promise<{ report: GateReport; failures: string }> {
  const before = await gateStatus(ship, stage);
  if (before.dirty || before.gates.some((g) => g.state === "unknown-check")) return { report: before, failures: describeGates(before) };
  const outputs: string[] = [];
  for (const g of before.gates) {
    if (g.state === "green") continue;
    const res = await runCheck(ship.id, from, g.name);
    if (!res.ok) outputs.push(tail(res.message, 4000));
  }
  return { report: await gateStatus(ship, stage), failures: outputs.join("\n\n") };
}
