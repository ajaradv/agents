import { FM_HOME } from "./firstmate-chat.ts";
import { deliveryFor, openDockPr, prTitle } from "./dock-delivery.ts";
import { reviewBranch, reviewLine } from "./dock-review.ts";
import { existsSync } from "node:fs";
import { describeManeuver, maneuverAvailability } from "./maneuvers.ts";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, type Document } from "yaml";
import { editShipConfig, readShipConfig, shipTemplates } from "./ship-config.ts";
export { shipYamlText } from "./ship-config.ts";
import { loadAgents, type AgentMeta } from "./agents.ts";
import { frontmatter, readShips, type ShipRow } from "./fleet-layers.ts";
import { aliceVault, ROOT } from "./paths.ts";
import { spawnTimed } from "./proc.ts";
import { logShipEvent, shipTurnTotals } from "./ship-log.ts";
import { describeGates, gateStatus } from "./gates.ts";
import { endVoyageMemory, startVoyageMemory } from "./crew-memory.ts";
import { ledgerLine, ledgerMarkdown, recordVoyageDock, recordVoyageStart, voyageId, voyageLedger } from "./metrics.ts";
import { leaseVoyageWorktree, releaseVoyageWorktree, usesVoyageWorktrees, voyageWorktree, type VoyageWorktree } from "./voyage-worktree.ts";

/**
 * The shipyard: build a ship (register it, check what it is missing), crew it
 * (roles from agents/ marked `crew: true`), budget it, and send it on voyages.
 *
 * Ship config is a committed base (fleet/ships/<id>.yaml) with a live overlay
 * (fleet/home/ships/<id>.yaml) that every edit here goes to (lib/ship-config.ts). Voyage records live in the vault, like plans:
 * {vault}/fleet/voyages/<ship>/<date>-<slug>.md with `status: sailing|docked`.
 */

const SHIP_RE = /^[a-z][a-z0-9_-]{0,40}$/;
const ROLE_RE = /^[a-z][a-z0-9_-]{0,40}$/;
export const MODES = ["no-mistakes", "no-mistakes-prod-only", "no-mistakes-required", "direct-PR", "local-only"] as const;

function shipFile(id: string): string {
  return join(ROOT, "fleet", "ships", `${id}.yaml`);
}

export async function findShip(id: string): Promise<ShipRow | undefined> {
  return (await readShips()).find((s) => s.id === id);
}

/** Roles a ship can take aboard: agent templates with `crew: true`. */
export async function crewRoles(): Promise<AgentMeta[]> {
  return (await loadAgents()).filter((a) => a.crewEligible && !a.ship);
}

/** Remove map.key when the map exists; a ship without that map has nothing to remove. */
export function deleteKey(doc: Document, map: string, key: string): void {
  if (isMap(doc.get(map))) doc.deleteIn([map, key]);
}

/**
 * Change a ship's config: the edit sees the merged view (base plus overlay) as
 * one document; what it changes goes to the overlay, never the committed base
 * (lib/ship-config).
 */
export async function editShip(id: string, edit: (doc: Document) => void, who: { by: string; why?: string } = { by: "captain" }): Promise<void> {
  await editShipConfig(id, edit, who);
}

export async function setCrew(
  shipId: string,
  change: { add?: string; remove?: string; budget?: { role: string; usd: number | null }; model?: { role: string; model: string | null } },
): Promise<{ ok: boolean; message: string }> {
  const ship = await findShip(shipId);
  if (!ship) return { ok: false, message: `No ship named ${shipId}.` };
  const roles = new Set((await crewRoles()).map((r) => r.id));
  if (change.add && (!ROLE_RE.test(change.add) || !roles.has(change.add))) return { ok: false, message: `${change.add} is not a crew role.` };
  await editShip(shipId, (doc) => {
    const crew = new Set(ship.crew);
    if (change.add) crew.add(change.add);
    if (change.remove) {
      crew.delete(change.remove);
      deleteKey(doc, "crew_budgets", change.remove);
      deleteKey(doc, "crew_models", change.remove);
    }
    doc.set("crew", [...crew]);
    if (change.budget && ROLE_RE.test(change.budget.role)) {
      if (change.budget.usd === null || !(change.budget.usd > 0)) deleteKey(doc, "crew_budgets", change.budget.role);
      else doc.setIn(["crew_budgets", change.budget.role], Math.max(0.001, Math.round(change.budget.usd * 1000) / 1000));
    }
    if (change.model && ROLE_RE.test(change.model.role)) {
      const m = change.model.model?.trim();
      if (!m) deleteKey(doc, "crew_models", change.model.role);
      else if (/^[a-z0-9._@:/-]{3,120}$/i.test(m)) doc.setIn(["crew_models", change.model.role], m);
    }
  });
  const what = change.add ? `${change.add} came aboard` : change.remove ? `${change.remove} went ashore` : change.budget ? `budget for ${change.budget.role} set` : "crew updated";
  logShipEvent(shipId, "captain", "shipyard", what);
  return { ok: true, message: `${shipId}: ${what}.` };
}

export async function setOrchestrator(shipId: string, orchestrator: string): Promise<{ ok: boolean; message: string }> {
  if (!["firstmate", "lead"].includes(orchestrator)) return { ok: false, message: "Orchestrator is firstmate or lead." };
  if (!(await findShip(shipId))) return { ok: false, message: `No ship named ${shipId}.` };
  await editShip(shipId, (doc) => doc.set("orchestrator", orchestrator));
  logShipEvent(shipId, "captain", "shipyard", `orchestrator set to ${orchestrator}`);
  return { ok: true, message: `${shipId} is now run by ${orchestrator === "lead" ? "its crew lead" : "Firstmate"}.` };
}

// ---------------------------------------------------------------- budgets

/** Daily budget per role in USD from `crew_budgets:`, or null when unset. */
export async function crewBudget(shipId: string, role: string): Promise<number | null> {
  try {
    const v = Number((readShipConfig(shipId)?.crew_budgets as Record<string, unknown> | undefined)?.[role]);
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function spentToday(shipId: string, crewmateId: string): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return shipTurnTotals(shipId, midnight.toISOString())[crewmateId]?.cost ?? 0;
}

/** Refusal text when an officer has spent its daily_budget_usd today (spend from the fleet log), else null. */
export function officerBudgetRefusal(agentId: string, budget: number | undefined): string | null {
  if (!budget) return null;
  const spent = spentToday("fleet", agentId);
  const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
  return spent >= budget
    ? `${agentId} has spent ${usd(spent)} of its ${usd(budget)} daily budget. Raise daily_budget_usd in agents/${agentId}/agent.yaml to continue today.`
    : null;
}

/** Refusal text when a crewmate has spent its budget today, else null. */
export async function budgetRefusal(shipId: string, crewmateId: string): Promise<string | null> {
  const role = crewmateId.slice(shipId.length + 1);
  const budget = await crewBudget(shipId, role);
  if (budget === null) return null;
  const spent = spentToday(shipId, crewmateId);
  const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
  return spent >= budget
    ? `${crewmateId} has spent ${usd(spent)} of its ${usd(budget)} daily budget. Raise the budget on the ${shipId} deck to continue today.`
    : null;
}

// ---------------------------------------------------------------- checklist

export type CheckItem = { item: string; ok: boolean; required: boolean; note: string };

async function firstmateRegistered(shipId: string): Promise<boolean> {
  try {
    const text = await readFile(join(FM_HOME, "data", "projects.md"), "utf8");
    return text.split("\n").some((l) => new RegExp(`^[-*]\\s+${shipId}(\\s|$)`, "i").test(l));
  } catch {
    return false;
  }
}

export async function shipChecklist(ship: ShipRow): Promise<CheckItem[]> {
  const repo = Boolean(ship.path) && existsSync(ship.path);
  const git = repo && existsSync(join(ship.path, ".git"));
  const firstmate = ship.orchestrator === "firstmate";
  return [
    { item: "Repo on disk", ok: repo, required: true, note: repo ? ship.path : `${ship.path || "no path"} not found` },
    { item: "Git repository", ok: git, required: true, note: git ? "branches and worktrees available" : "crew work happens on branches; run git init" },
    { item: "Delivery mode", ok: Boolean(ship.mode), required: true, note: ship.mode || "set mode: in the ship file" },
    firstmate
      ? { item: "Registered with Firstmate", ok: await firstmateRegistered(ship.id), required: true, note: "Firstmate runs this ship's voyages" }
      : { item: "Crew aboard", ok: ship.crew.length > 0, required: true, note: ship.crew.length ? ship.crew.join(", ") : "add at least one crewmate" },
    ...(firstmate ? [] : [{ item: "A lead aboard", ok: ship.crew.includes("lead"), required: false, note: ship.crew.includes("lead") ? "the lead plans voyages into tasks for the crew" : "without a lead, a voyage goes to one crewmate who works it alone" }]),
    { item: "PRODUCT.md", ok: repo && existsSync(join(ship.path, "PRODUCT.md")), required: false, note: "what the product is and who it is for; the Designer writes it with impeccable init" },
    { item: "SSSF factory", ok: ship.adws.length > 0, required: false, note: ship.adws.length ? `${ship.adws.length} ADW chains` : "repeatable maneuvers (plan, build, test) need /sssf install" },
  ];
}

export function readyToSail(items: CheckItem[]): boolean {
  return items.every((i) => i.ok || !i.required);
}

// ---------------------------------------------------------------- voyages

export type Voyage = { file: string; ship: string; status: "sailing" | "docked"; goal: string; to: string; started: string; ended?: string; worktree?: VoyageWorktree };

function voyageDir(shipId: string): string {
  return join(aliceVault(), "fleet", "voyages", shipId);
}

export async function openVoyage(shipId: string): Promise<Voyage | null> {
  return (await listVoyages(shipId)).find((v) => v.status === "sailing") ?? null;
}

export async function listVoyages(shipId: string): Promise<Voyage[]> {
  if (!SHIP_RE.test(shipId)) return [];
  let names: string[];
  try {
    names = (await readdir(voyageDir(shipId))).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: Voyage[] = [];
  for (const name of names) {
    try {
      const fm = frontmatter(await readFile(join(voyageDir(shipId), name), "utf8")) ?? {};
      out.push({
        file: join(voyageDir(shipId), name),
        ship: shipId,
        status: fm.status === "sailing" ? "sailing" : "docked",
        goal: String(fm.goal ?? ""),
        to: String(fm.to ?? ""),
        started: String(fm.started ?? ""),
        ...(fm.ended ? { ended: String(fm.ended) } : {}),
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.started.localeCompare(a.started));
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

export async function startVoyage(shipId: string, goal: string, to: string): Promise<{ ok: boolean; message: string; voyage?: Voyage }> {
  const ship = await findShip(shipId);
  if (!ship) return { ok: false, message: `No ship named ${shipId}.` };
  const g = goal.trim().replace(/\s+/g, " ");
  if (g.length < 4) return { ok: false, message: "Give the voyage a goal." };
  if (await openVoyage(shipId)) return { ok: false, message: `${shipId} is already under sail. Dock it before setting a new course.` };
  if (!readyToSail(await shipChecklist(ship))) return { ok: false, message: `${shipId} is not ready: finish the required checklist items first.` };
  const now = new Date();
  const slug = g.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "voyage";
  const file = join(voyageDir(shipId), `${now.toISOString().slice(0, 10)}-${slug}.md`);
  if (existsSync(file)) return { ok: false, message: "A voyage with that goal already started today." };
  await mkdir(voyageDir(shipId), { recursive: true });
  // Fleet-crewed ships work in a leased worktree on a crew/ branch, never in the captain's checkout.
  let worktree: VoyageWorktree | undefined;
  if (usesVoyageWorktrees(ship)) {
    const lease = await leaseVoyageWorktree(ship, slug, g);
    if ("message" in lease) return { ok: false, message: lease.message };
    worktree = lease.worktree;
  }
  const crew = ship.crew.map((r) => `${shipId}-${r}`);
  await writeFile(
    file,
    [
      "---",
      `title: ${yamlStr(`${shipId}: ${g.slice(0, 80)}`)}`,
      `ship: ${shipId}`,
      "status: sailing",
      `goal: ${yamlStr(g)}`,
      `to: ${to}`,
      `orchestrator: ${ship.orchestrator}`,
      `crew: [${crew.join(", ")}]`,
      ...(worktree ? [`branch: ${worktree.branch}`, `worktree: ${yamlStr(worktree.path)}`] : []),
      `started: ${now.toISOString()}`,
      "---",
      "",
      "## Goal",
      "",
      g,
      "",
      "## Log",
      "",
      `- ${now.toISOString()} set sail; goal sent to ${to}${worktree ? `; work on branch ${worktree.branch} (from ${worktree.base}) in ${worktree.path}` : ""}`,
      "",
    ].join("\n"),
    "utf8",
  );
  logShipEvent(shipId, "captain", "voyage-start", g, { file, to, ...(worktree ? { branch: worktree.branch, worktree: worktree.path } : {}) });
  const voyage: Voyage = { file, ship: shipId, status: "sailing", goal: g, to, started: now.toISOString(), ...(worktree ? { worktree } : {}) };
  recordVoyageStart({ id: voyageId(file), ship: shipId, goal: g, to, branch: worktree?.branch, worktree: worktree?.path, started: now.toISOString() });
  // Tiered crew memory (lib/crew-memory.ts): a fresh voyage scratchpad, fresh crew sessions, no leftovers.
  if (ship.orchestrator === "lead") await startVoyageMemory(shipId, { goal: g, branch: worktree?.branch, worktree: worktree?.path, record: file }, crew);
  return { ok: true, message: `${shipId} set sail.`, voyage };
}

export async function dockVoyage(shipId: string, summary: string): Promise<{ ok: boolean; message: string }> {
  const v = await openVoyage(shipId);
  if (!v) return { ok: false, message: `${shipId} is not under sail.` };
  // Dock gates first: the branch's latest commit must have passed them (run them with Run gates).
  const ship = await findShip(shipId);
  if (ship?.gates.dock.length) {
    const gates = await gateStatus(ship, "dock");
    if (!gates.green) return { ok: false, message: `${shipId} cannot dock yet: ${describeGates(gates)} Run the gates (Run gates on the deck, or ask the lead), then dock again.` };
  }
  // Return the voyage's worktree: uncommitted work keeps the voyage open.
  const released = ship ? await releaseVoyageWorktree(ship) : { ok: true, message: "" };
  if (!released.ok) return { ok: false, message: released.message };
  const now = new Date().toISOString();
  // The ledger (lib/metrics.ts): what the voyage took, written into its note and the dock message.
  const id = voyageId(v.file);
  const commits = Number(released.message.match(/has (\d+) commit/)?.[1] ?? 0);
  recordVoyageDock(id, { commits, outcome: summary.trim(), branch: released.message.match(/^Branch (\S+)/)?.[1] });
  const ledger = voyageLedger(id);
  // Dock review (lib/dock-review.ts): how closely the captain should review the branch before merging. Advisory.
  const branchInfo = released.message.match(/^Branch (\S+) has \d+ commit\(s\) on (\S+?),/);
  const review = ship && branchInfo && commits > 0 ? await reviewBranch(ship.path, branchInfo[2]!, branchInfo[1]!).catch(() => null) : null;
  // Land through the ship's delivery mode (lib/dock-delivery.ts): a pull request for direct-PR and no-mistakes ships.
  let delivered = "";
  if (ship && branchInfo && commits > 0 && deliveryFor(ship.mode) === "pr") {
    const body = [
      summary.trim() || "Docked voyage.",
      ledger ? ledgerMarkdown(ledger) : "",
      review ? `Dock review: ${reviewLine(review)}` : "",
      ship.gates.dock.length ? `Dock gates passed on the latest commit: ${ship.gates.dock.join(", ")}.` : "This ship has no dock gates configured.",
      `Voyage record (vault): ${v.file.split("/").slice(-3).join("/")}`,
      "Opened by the fleet when the voyage docked. The captain reviews and merges.",
    ].filter(Boolean).join("\n\n");
    const pr = await openDockPr(ship.path, branchInfo[1]!, branchInfo[2]!, prTitle(v.goal), body).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as { ok: boolean; url?: string; message: string });
    delivered = pr.ok ? `Pull request: ${pr.url}.` : `Delivery (${ship.mode}): ${pr.message}.`;
  }
  // The voyage's memory is archived into its note, then discarded.
  const scratch = ship && ship.orchestrator === "lead" ? await endVoyageMemory(shipId, ship.crew.map((r) => `${shipId}-${r}`)) : "";
  let text = await readFile(v.file, "utf8");
  text = text.replace(/^status: sailing$/m, "status: docked").replace(/^started: (.*)$/m, `started: $1\nended: ${now}`);
  const note = summary.trim();
  text = text.trimEnd() + `\n- ${now} docked${released.message ? `; ${released.message}` : ""}\n` + (delivered ? `\n${delivered}\n` : "") + (note ? `\n## Summary\n\n${note}\n` : "") + (ledger ? `\n${ledgerMarkdown(ledger)}` : "") + (review ? `\n## Dock review\n\n${reviewLine(review)}\n` : "") + (scratch ? `\n## Voyage memory (archived at dock)\n\n${scratch}\n` : "");
  await writeFile(v.file, text, "utf8");
  logShipEvent(shipId, "captain", "voyage-end", note || "Docked", { file: v.file });
  return { ok: true, message: `${shipId} docked.${released.message ? ` ${released.message}` : ""}${delivered ? ` ${delivered}` : ""}${ledger ? ` ${ledgerLine(ledger)}` : ""}${review ? ` ${reviewLine(review)}` : ""}` };
}

/** The lead's view of the ship's maneuvers, for the voyage brief. */
function maneuverBrief(ship: ShipRow): string[] {
  const all = maneuverAvailability(ship, "lead");
  if (!all.length) return ["No maneuvers on this ship."];
  return ["Maneuvers (maneuver_start; locked ones cannot start):", ...all.map((m) => `- ${describeManeuver(m)}`)];
}

/** The opening message a crewmate (or Firstmate) gets when a voyage starts. */
export function voyageBrief(ship: ShipRow, v: Voyage): string {
  if (v.to === `${ship.id}-lead`) {
    return [
      `New voyage for ${ship.id}: ${v.goal}`,
      "",
      `Voyage record (vault): ${v.file}`,
      `Crew aboard: ${ship.crew.filter((r) => r !== "lead").map((r) => `${ship.id}-${r}`).join(", ") || "only you"}.`,
      ...maneuverBrief(ship),
      ...(ship.gates.task.length || ship.gates.dock.length
        ? [`Gates (checks that must pass on the latest commit): ${ship.gates.task.length ? `a task is done only after ${ship.gates.task.join(", ")} pass (they run when it is reported done)` : ""}${ship.gates.task.length && ship.gates.dock.length ? "; " : ""}${ship.gates.dock.length ? `the voyage docks only after ${ship.gates.dock.join(", ")} pass` : ""}. Commit before reporting a task done.`]
        : []),
      ...(v.worktree ?? voyageWorktree(ship.id)
        ? [`Work happens on branch ${(v.worktree ?? voyageWorktree(ship.id))!.branch} in the voyage's own worktree (your crew's working folder); commit there and never push. ${deliveryFor(ship.mode) === "pr" ? `At dock the fleet pushes the branch and opens a pull request (delivery mode ${ship.mode}); the captain merges.` : "The captain reviews and merges after docking."} The branch name is a guess from the goal: before the first commit, rename it if the type or words are wrong, and write conventional commit messages (skill git-conventions).`]
        : []),
      "You are the lead: read voyage_status, plan the goal into tasks, assign them with task_add, tell me the plan in a few lines, and end your turn. Reports come back to you as crew messages.",
    ].join("\n");
  }
  return [
    `New voyage for ${ship.id}: ${v.goal}`,
    "",
    `Voyage record (vault): ${v.file}`,
    ship.crew.length > 1 ? `Crew aboard: ${ship.crew.map((r) => `${ship.id}-${r}`).join(", ")}.` : "",
    "Work it aboard this ship under its delivery mode. Ask me with ask_captain when a decision is mine, show work on the canvas, and tell me plainly when the goal is met or blocked.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------- register

export async function registerShip(input: { id: string; path: string; mode: string; factory: boolean; firstmate: string; template?: string }): Promise<{ ok: boolean; message: string; output?: string }> {
  if (!SHIP_RE.test(input.id)) return { ok: false, message: "Ship id: lowercase letters, digits, - or _, starting with a letter." };
  if (!input.path.startsWith("/") || !existsSync(input.path)) return { ok: false, message: `${input.path} is not a folder on this machine.` };
  if (!(MODES as readonly string[]).includes(input.mode)) return { ok: false, message: "Pick a delivery mode." };
  if (existsSync(shipFile(input.id))) return { ok: false, message: `${input.id} is already registered.` };
  const args = ["python3", join(ROOT, "bin", "stamp-ship"), input.id, input.path, "--mode", input.mode];
  if (!input.factory) args.push("--no-factory");
  if (input.template) {
    if (!shipTemplates().includes(input.template)) return { ok: false, message: `No ship template ${input.template}.` };
    args.push("--template", input.template);
  }
  if (input.firstmate.trim()) args.push("--register", input.firstmate.trim().slice(0, 200));
  const res = await spawnTimed(args, { cwd: ROOT, timeoutMs: 180_000 });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-4000);
  if (res.exitCode !== 0) return { ok: false, message: `stamp-ship failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}).`, output };
  logShipEvent(input.id, "captain", "shipyard", `ship registered at ${input.path}`);
  return { ok: true, message: `${input.id} is in the yard.`, output };
}
