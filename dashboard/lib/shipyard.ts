import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { loadAgents, type AgentMeta } from "./agents.ts";
import { frontmatter, readShips, type ShipRow } from "./fleet-layers.ts";
import { aliceVault, ROOT } from "./paths.ts";
import { spawnTimed } from "./proc.ts";
import { logShipEvent, shipTurnTotals } from "./ship-log.ts";

/**
 * The shipyard: build a ship (register it, check what it is missing), crew it
 * (roles from agents/ marked `crew: true`), budget it, and send it on voyages.
 *
 * Ship config lives in fleet/ships/<id>.yaml (edited with the yaml Document API
 * so comments survive). Voyage records live in the vault, like plans:
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
function deleteKey(doc: ReturnType<typeof parseDocument>, map: string, key: string): void {
  if (isMap(doc.get(map))) doc.deleteIn([map, key]);
}

async function editShip(id: string, edit: (doc: ReturnType<typeof parseDocument>) => void): Promise<void> {
  const path = shipFile(id);
  const doc = parseDocument(await readFile(path, "utf8"));
  edit(doc);
  await writeFile(path, doc.toString(), "utf8");
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
    const doc = parseDocument(await readFile(shipFile(shipId), "utf8"));
    const v = Number(doc.getIn(["crew_budgets", role]));
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
    const text = await readFile(join(ROOT, "fleet", "home", "data", "projects.md"), "utf8");
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

export type Voyage = { file: string; ship: string; status: "sailing" | "docked"; goal: string; to: string; started: string; ended?: string };

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
      `started: ${now.toISOString()}`,
      "---",
      "",
      "## Goal",
      "",
      g,
      "",
      "## Log",
      "",
      `- ${now.toISOString()} set sail; goal sent to ${to}`,
      "",
    ].join("\n"),
    "utf8",
  );
  logShipEvent(shipId, "captain", "voyage-start", g, { file, to });
  const voyage: Voyage = { file, ship: shipId, status: "sailing", goal: g, to, started: now.toISOString() };
  return { ok: true, message: `${shipId} set sail.`, voyage };
}

export async function dockVoyage(shipId: string, summary: string): Promise<{ ok: boolean; message: string }> {
  const v = await openVoyage(shipId);
  if (!v) return { ok: false, message: `${shipId} is not under sail.` };
  const now = new Date().toISOString();
  let text = await readFile(v.file, "utf8");
  text = text.replace(/^status: sailing$/m, "status: docked").replace(/^started: (.*)$/m, `started: $1\nended: ${now}`);
  const note = summary.trim();
  text = text.trimEnd() + `\n- ${now} docked\n` + (note ? `\n## Summary\n\n${note}\n` : "");
  await writeFile(v.file, text, "utf8");
  logShipEvent(shipId, "captain", "voyage-end", note || "Docked", { file: v.file });
  return { ok: true, message: `${shipId} docked.` };
}

/** The opening message a crewmate (or Firstmate) gets when a voyage starts. */
export function voyageBrief(ship: ShipRow, v: Voyage): string {
  if (v.to === `${ship.id}-lead`) {
    return [
      `New voyage for ${ship.id}: ${v.goal}`,
      "",
      `Voyage record (vault): ${v.file}`,
      `Crew aboard: ${ship.crew.filter((r) => r !== "lead").map((r) => `${ship.id}-${r}`).join(", ") || "only you"}.`,
      ship.adws.length ? `Maneuvers available: ${ship.adws.join(", ")}.` : "No SSSF factory on this ship.",
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

export async function registerShip(input: { id: string; path: string; mode: string; factory: boolean; firstmate: string }): Promise<{ ok: boolean; message: string; output?: string }> {
  if (!SHIP_RE.test(input.id)) return { ok: false, message: "Ship id: lowercase letters, digits, - or _, starting with a letter." };
  if (!input.path.startsWith("/") || !existsSync(input.path)) return { ok: false, message: `${input.path} is not a folder on this machine.` };
  if (!(MODES as readonly string[]).includes(input.mode)) return { ok: false, message: "Pick a delivery mode." };
  if (existsSync(shipFile(input.id))) return { ok: false, message: `${input.id} is already registered.` };
  const args = ["python3", join(ROOT, "bin", "stamp-ship"), input.id, input.path, "--mode", input.mode];
  if (!input.factory) args.push("--no-factory");
  if (input.firstmate.trim()) args.push("--register", input.firstmate.trim().slice(0, 200));
  const res = await spawnTimed(args, { cwd: ROOT, timeoutMs: 180_000 });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim().slice(-4000);
  if (res.exitCode !== 0) return { ok: false, message: `stamp-ship failed (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""}).`, output };
  logShipEvent(input.id, "captain", "shipyard", `ship registered at ${input.path}`);
  return { ok: true, message: `${input.id} is in the yard.`, output };
}
