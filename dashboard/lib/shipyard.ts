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
import { archiveCanvas } from "./canvas-archive.ts";
import { endVoyageMemory, freshSession as freshCrewSession, memoryFiles, startVoyageMemory, voyageMemoryCleared, writeMemoryFiles } from "./crew-memory.ts";
import { exeSailable, provisionVoyageVm, releaseVoyageVm } from "./exe-voyages.ts";
import { laptopSailable } from "./laptop-host.ts";
import { ledgerLine, ledgerMarkdown, recordVoyageDock, recordVoyageStart, voyageId, voyageLedger } from "./metrics.ts";
import { hostRunner, localHost, shipHost, type ShipHost } from "./ship-host.ts";
import { leaseVoyageWorktree, releaseVoyageWorktree, setVoyageGuest, updateVoyageRig, usesVoyageWorktrees, voyageHost, voyageWorktree, type VoyageWorktree } from "./voyage-worktree.ts";
import { planRig, rigVoyage, unrigVoyage, type Deliver } from "./rigging.ts";
import { briefHeading, extractBrief, SESSION_KINDS, sessionBranch, sessionBrief, type SessionKind } from "./sessions.ts";
import { checkSpec, parseSpec, setSpecStatus, type Spec } from "./specs.ts";
import { addQueueItem, finishQueueItem, readQueue, updateQueueItem } from "./decision-queue.ts";
import { busPost } from "./bus-api.ts";
import { OFFICER_SHIP } from "./ship-events.ts";

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
/** The flagship's deciders (D4): the one designer and one architect work with the captain, never aboard as crew. */
export const FLAGSHIP_OFFICERS = new Set(["designer", "architect"]);

export async function crewRoles(): Promise<AgentMeta[]> {
  return (await loadAgents()).filter((a) => a.crewEligible && !a.ship && !FLAGSHIP_OFFICERS.has(a.id));
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
  if (change.add && FLAGSHIP_OFFICERS.has(change.add)) return { ok: false, message: `The fleet's ${change.add} lives on the flagship and is not crew: put the decision on the Decision queue (a ${change.add === "designer" ? "design" : "spec"} session), and the voyage builds the spec.` };
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

/** Refusal text when an officer has spent its daily_budget_usd today (spend from the Flagship's log), else null. */
export function officerBudgetRefusal(agentId: string, budget: number | undefined): string | null {
  if (!budget) return null;
  const spent = spentToday(OFFICER_SHIP, agentId);
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
    ...(firstmate ? [] : [{ item: "Rigging declared", ok: Boolean(ship.rig), required: true, note: ship.rig ? `each voyage gets its own running copy${ship.rig.ready ? `, ready at ${ship.rig.ready}` : ""}` : "add rig: (up steps, a ready URL, down) so every voyage starts with a running, migrated copy of the app" }]),
    { item: "PRODUCT.md", ok: repo && existsSync(join(ship.path, "PRODUCT.md")), required: false, note: "what the product is and who it is for; the Designer writes it with impeccable init" },
    { item: "SSSF factory", ok: ship.adws.length > 0, required: false, note: ship.adws.length ? `${ship.adws.length} ADW chains` : "repeatable maneuvers (plan, build, test) need /sssf install" },
  ];
}

export function readyToSail(items: CheckItem[]): boolean {
  return items.every((i) => i.ok || !i.required);
}

// ---------------------------------------------------------------- voyages

export type Voyage = { file: string; ship: string; status: "sailing" | "docked"; goal: string; to: string; started: string; ended?: string; worktree?: VoyageWorktree; session?: SessionKind; spec?: string; chore?: boolean };

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
        ...(fm.kind === "session" && (fm.session === "design" || fm.session === "spec") ? { session: fm.session as SessionKind } : {}),
        ...(fm.spec ? { spec: String(fm.spec) } : {}),
        ...(fm.chore === true || fm.chore === "true" ? { chore: true } : {}),
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

/** Where a voyage can sail: "hub" (this machine), "laptop" (lib/laptop-host.ts), or "exe" (an exe.dev VM, lib/exe-voyages.ts), as the Set a course form and voyage_start name them. */
export const SAIL_ON = ["hub", "laptop", "exe"] as const;

/** Where sailHost sends a voyage: a host now, or a fresh exe.dev VM that startVoyage provisions (with the hub to fall back on when the ship only preferred away from it). */
export type SailPlace = { ok: true; host: ShipHost } | { ok: true; exe: true; fallback: ShipHost | null } | { ok: false; message: string };

/**
 * The ship host for a new voyage. Asked for the laptop: only while the captain
 * allows laptop voyages and the laptop is up. Asked for exe.dev: only when it
 * can take the voyage (lib/exe-voyages.ts). Not asked: the ship's `sail_on:
 * laptop` preference, which goes laptop, then exe.dev, then the hub. Gondolin
 * ships (`isolation: vm`) need macOS, so only the laptop or a macOS hub. Does
 * not provision: a VM is made by startVoyage after its cheap checks.
 */
export async function sailHost(
  ship: Pick<ShipRow, "id" | "isolation">,
  requested?: string,
  platform: string = process.platform,
  can: { laptop?: () => Promise<{ ok: boolean; why: string }>; exe?: (shipId: string) => Promise<{ ok: boolean; why: string }> } = {},
): Promise<SailPlace> {
  const want = requested || (readShipConfig(ship.id)?.sail_on === "laptop" ? "prefer-laptop" : "hub");
  if (want !== "hub" && want !== "local" && want !== "laptop" && want !== "exe" && want !== "prefer-laptop") return { ok: false, message: `Sail on the hub, the laptop, or exe.dev, not ${want}.` };
  // A crew in Gondolin VMs needs macOS: on a Linux hub, only the laptop can take the voyage.
  const hubCan = ship.isolation !== "vm" || platform === "darwin";
  if (want === "hub" || want === "local") return hubCan ? { ok: true, host: localHost } : { ok: false, message: `${ship.id}'s crew works in Gondolin VMs, which this hub cannot run: sail it on the laptop.` };
  if (want === "exe") {
    if (ship.isolation === "vm") return { ok: false, message: `${ship.id}'s crew works in Gondolin VMs, which exe.dev's Linux VMs cannot run: sail it on the laptop.` };
    const e = await (can.exe ?? exeSailable)(ship.id);
    return e.ok ? { ok: true, exe: true, fallback: null } : { ok: false, message: `${ship.id} cannot sail on exe.dev: ${e.why}.` };
  }
  const l = await (can.laptop ?? laptopSailable)();
  if (l.ok) return { ok: true, host: shipHost("laptop") };
  if (want === "laptop") return { ok: false, message: `${ship.id} cannot sail on the laptop: ${l.why}.` };
  if (ship.isolation !== "vm") {
    const e = await (can.exe ?? exeSailable)(ship.id);
    if (e.ok) return { ok: true, exe: true, fallback: hubCan ? localHost : null };
  }
  return hubCan ? { ok: true, host: localHost } : { ok: false, message: `${ship.id} sails only on the laptop (its crew works in Gondolin VMs), and ${l.why}.` };
}

/**
 * What Set sail needs from the process calling it: how to hand the crew the
 * brief (held until a rigged ship's stack is ready) and how to stop crew
 * processes left from before (they must start again with the voyage's rig).
 */
export type SailOpts = { deliver?: Deliver; stop?: (agentId: string) => Promise<void>; session?: SessionKind; spec?: string; chore?: boolean };

export async function startVoyage(shipId: string, goal: string, to: string, on?: string, opts: SailOpts = {}): Promise<{ ok: boolean; message: string; voyage?: Voyage; rigging?: boolean }> {
  const ship = await findShip(shipId);
  if (!ship) return { ok: false, message: `No ship named ${shipId}.` };
  // A session (lib/sessions.ts): the flagship officer as the ship's guest, on the laptop (the captain opens its preview there).
  const session = opts.session;
  if (session && to !== SESSION_KINDS[session]) return { ok: false, message: `A ${session} session goes to the ${SESSION_KINDS[session]}.` };
  if (session && ship.orchestrator !== "lead") return { ok: false, message: `${shipId} is run by Firstmate; sessions need a lead-run ship.` };
  // Decided work only (D3): a lead-run voyage builds an approved spec, or is a chore.
  let spec: Spec | null = null;
  if (!session && ship.orchestrator === "lead") {
    if (opts.spec) {
      const c = checkSpec(opts.spec, shipId);
      if (!c.ok) return { ok: false, message: c.message };
      if (c.spec.status !== "approved") return { ok: false, message: `That spec is ${c.spec.status}; voyages sail from approved specs (approve it on the Decision queue).` };
      spec = c.spec;
    } else if (!opts.chore) {
      return { ok: false, message: `${shipId}'s voyages sail from an approved spec, or as a chore (a fix, docs, a small change with no new UI or behaviour). Pick a spec or mark it a chore; anything still to decide goes on the Decision queue.` };
    }
    if (spec && goal.trim().length < 4) goal = spec.title;
  }
  const where = await sailHost(ship, session ? "laptop" : on);
  if (session && !where.ok) return { ok: false, message: `${where.message} Design and spec sessions run on the laptop; this one waits in the queue until it is awake.` };
  if (!where.ok) return { ok: false, message: where.message };
  let chosen: ShipHost | null = "host" in where ? where.host : null;
  let fb = "";
  const g = goal.trim().replace(/\s+/g, " ");
  if (g.length < 4) return { ok: false, message: "Give the voyage a goal." };
  if (await openVoyage(shipId)) return { ok: false, message: `${shipId} is already under sail. Dock it before setting a new course.` };
  if (!readyToSail(await shipChecklist(ship))) return { ok: false, message: `${shipId} is not ready: finish the required checklist items first.` };
  const now = new Date();
  const slug = g.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "voyage";
  const file = join(voyageDir(shipId), `${now.toISOString().slice(0, 10)}-${slug}.md`);
  if (existsSync(file)) return { ok: false, message: "A voyage with that goal already started today." };
  await mkdir(voyageDir(shipId), { recursive: true });
  // An exe.dev VM is made now that the cheap checks passed: a worktree-less ship has nothing to put there.
  if (!chosen) {
    const fallback = "exe" in where ? where.fallback : null;
    let why = ship.orchestrator === "lead" ? "" : `${shipId} is run by Firstmate, whose voyages need no VM.`;
    if (!why) {
      const made = await provisionVoyageVm(shipId, slug);
      if (made.ok) chosen = made.host;
      else why = made.message;
    }
    if (!chosen) {
      if (!fallback) return { ok: false, message: why };
      chosen = fallback;
      fb = ` ${why} Sailed on the hub instead.`;
    }
  }
  const host: ShipHost = chosen;
  // Fleet-crewed ships work in a leased worktree on a crew/ branch, never in the captain's checkout.
  let worktree: VoyageWorktree | undefined;
  if (usesVoyageWorktrees(ship, host)) {
    const lease = session ? await leaseVoyageWorktree(ship, sessionBranch(session, slug.slice(0, 40).replace(/-+$/, "")), "", host) : await leaseVoyageWorktree(ship, slug, g, host, undefined, spec?.prototype || undefined);
    if ("message" in lease) {
      if (host.vm) await releaseVoyageVm(host.vm);
      return { ok: false, message: lease.message };
    }
    worktree = lease.worktree;
  }
  const crew = session ? [to] : ship.crew.map((r) => `${shipId}-${r}`);
  await writeFile(
    file,
    [
      "---",
      `title: ${yamlStr(`${shipId}: ${g.slice(0, 80)}`)}`,
      `ship: ${shipId}`,
      "status: sailing",
      `goal: ${yamlStr(g)}`,
      `to: ${to}`,
      ...(session ? ["kind: session", `session: ${session}`] : []),
      ...(spec ? [`spec: ${yamlStr(spec.file)}`] : opts.chore ? ["chore: true"] : []),
      `orchestrator: ${ship.orchestrator}`,
      `crew: [${crew.join(", ")}]`,
      ...(worktree ? [`branch: ${worktree.branch}`, `worktree: ${yamlStr(worktree.path)}`] : []),
      `host: ${host.kind === "local" ? "hub" : host.kind}`,
      `started: ${now.toISOString()}`,
      "---",
      "",
      "## Goal",
      "",
      g,
      "",
      "## Log",
      "",
      `- ${now.toISOString()} set sail${host.kind === "local" ? "" : ` on ${host.label}`}; goal sent to ${to}${worktree ? `; work on branch ${worktree.branch} (from ${worktree.base}) in ${worktree.path}` : ""}`,
      "",
    ].join("\n"),
    "utf8",
  );
  logShipEvent(shipId, "captain", "voyage-start", g, { file, to, ...(worktree ? { branch: worktree.branch, worktree: worktree.path } : {}) });
  const voyage: Voyage = { file, ship: shipId, status: "sailing", goal: g, to, started: now.toISOString(), ...(worktree ? { worktree } : {}), ...(session ? { session } : {}), ...(spec ? { spec: spec.file } : {}), ...(opts.chore && !spec ? { chore: true } : {}) };
  if (spec) setSpecStatus(spec.file, "sailing");
  if (session && worktree) setVoyageGuest(shipId, to);
  recordVoyageStart({ id: voyageId(file), ship: shipId, goal: g, to, branch: worktree?.branch, worktree: worktree?.path, started: now.toISOString() });
  // Tiered crew memory (lib/crew-memory.ts): a fresh voyage scratchpad, fresh crew sessions, no leftovers.
  if (ship.orchestrator === "lead") {
    await startVoyageMemory(shipId, { goal: g, branch: worktree?.branch, worktree: worktree?.path, record: file }, crew);
    // Canvas items left from before (a voyage docked before archiving existed, or work between voyages).
    await archiveCanvas(crew, `${shipId}-before-voyage`).catch(() => {});
    // A remote host keeps the crew's memory where the crew runs.
    if (host.putMemory) await host.putMemory(await memoryFiles(shipId, crew)).catch((e) => logShipEvent(shipId, "helm", "notice", `Crew memory did not reach ${host.label}: ${e instanceof Error ? e.message : String(e)}`));
  }
  // Rigging (lib/rigging.ts): the voyage's own copy of the app first; the brief waits for it.
  if (ship.rig && worktree) {
    const plan = planRig(ship, slug, host.kind);
    if (plan && "error" in plan) {
      logShipEvent(shipId, "helm", "rig", `Not rigged: ${plan.error}`);
      return { ok: true, message: `${shipId} set sail, but its stack was not rigged: ${plan.error} The brief was not sent.`, voyage, rigging: true };
    }
    updateVoyageRig(shipId, { brief: { to, text: session && worktree ? sessionBrief({ ship: shipId, kind: session, topic: g, record: file, branch: worktree.branch }) : voyageBrief(ship, voyage) } });
    if (opts.stop) for (const id of crew) await opts.stop(id).catch(() => {});
    void rigVoyage(ship, opts.deliver ?? null).catch((e) => console.error("[rig]", e));
    return { ok: true, message: `${shipId} ${session ? `${session} session opened` : "set sail"}${host.kind === "local" ? "" : ` on ${host.label}`}; rigging its stack first (port ${plan?.port}). The brief goes to ${to} when the app is ready.${fb}`, voyage, rigging: true };
  }
  if (session && worktree) {
    if (opts.stop) await opts.stop(to).catch(() => {});
    await opts.deliver?.(to, sessionBrief({ ship: shipId, kind: session, topic: g, record: file, branch: worktree.branch }));
    return { ok: true, message: `${shipId} ${session} session opened on ${host.label}.${fb}`, voyage, rigging: true };
  }
  return { ok: true, message: `${shipId} set sail${host.kind === "local" ? "" : ` on ${host.label}`}.${fb}`, voyage };
}

export async function dockVoyage(shipId: string, summary: string): Promise<{ ok: boolean; message: string }> {
  const v = await openVoyage(shipId);
  if (!v) return { ok: false, message: `${shipId} is not under sail.` };
  // Dock gates first: the branch's latest commit must have passed them (run them with Run gates).
  const ship = await findShip(shipId);
  if (ship?.gates.dock.length && !v.session) {
    const gates = await gateStatus(ship, "dock");
    if (!gates.green) return { ok: false, message: `${shipId} cannot dock yet: ${describeGates(gates)} Run the gates (Run gates on the deck, or ask the lead), then dock again.` };
  }
  // The ship host holding the voyage's repo (lib/ship-host.ts), and the repo there: read before the release drops the record.
  const host = voyageHost(shipId);
  const repo = voyageWorktree(shipId)?.repo ?? ship?.path ?? "";
  const guest = voyageWorktree(shipId)?.guest;
  const vm = voyageWorktree(shipId)?.vm;
  // The voyage's stack goes first (lib/rigging.ts), then the worktree: uncommitted work keeps the voyage open.
  if (ship) await unrigVoyage(ship);
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
  const review = ship && branchInfo && commits > 0 && !v.session ? await reviewBranch(repo, branchInfo[2]!, branchInfo[1]!, undefined, host).catch(() => null) : null;
  // Land through the ship's delivery mode (lib/dock-delivery.ts): a pull request for direct-PR and no-mistakes ships.
  let delivered = "";
  // A session delivers nothing: its prototype branch is pushed (no pull request) for the voyage that builds the decision.
  if (v.session && branchInfo && commits > 0) {
    const push = await host.exec(["git", "push", "-u", "origin", branchInfo[1]!], { timeoutMs: 120_000, cwd: repo });
    delivered = push.exitCode === 0 ? `Prototype branch pushed: ${branchInfo[1]} (no pull request; a voyage starts from it).` : `The prototype branch ${branchInfo[1]} was not pushed: ${(push.stderr || push.stdout).split("\n").pop()?.slice(0, 160)}.`;
  } else if (ship && branchInfo && commits > 0 && deliveryFor(ship.mode) === "pr") {
    const body = [
      summary.trim() || "Docked voyage.",
      ledger ? ledgerMarkdown(ledger) : "",
      review ? `Dock review: ${reviewLine(review)}` : "",
      ship.gates.dock.length ? `Dock gates passed on the latest commit: ${ship.gates.dock.join(", ")}.` : "This ship has no dock gates configured.",
      `Voyage record (vault): ${v.file.split("/").slice(-3).join("/")}`,
      "Opened by the fleet when the voyage docked. The captain reviews and merges.",
    ].filter(Boolean).join("\n\n");
    const pr = await openDockPr(repo, branchInfo[1]!, branchInfo[2]!, prTitle(v.goal), body, hostRunner(host)).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as { ok: boolean; url?: string; message: string });
    delivered = pr.ok ? `Pull request: ${pr.url}.` : `Delivery (${ship.mode}): ${pr.message}.`;
  }
  // The voyage's memory is archived into its note, then discarded.
  const crewIds = v.session && guest ? [guest] : ship ? ship.crew.map((r) => `${shipId}-${r}`) : [];
  // A remote host kept the crew's memory: bring it back first, then clear the voyage's part there.
  if (ship?.orchestrator === "lead" && host.getMemory) {
    await host.getMemory(shipId, crewIds).then(writeMemoryFiles).catch((e) => logShipEvent(shipId, "helm", "notice", `Crew memory on ${host.label} was not brought back: ${e instanceof Error ? e.message : String(e)}`));
    await host.putMemory?.(voyageMemoryCleared(shipId, crewIds)).catch(() => {});
  }
  // The voyage's exe.dev VM goes once its memory is back (the branch and any pull request are already on the remote).
  if (vm) {
    const gone = await releaseVoyageVm(vm);
    logShipEvent(shipId, "helm", "notice", gone.message);
  }
  const scratch = ship && ship.orchestrator === "lead" ? await endVoyageMemory(shipId, crewIds) : "";
  // The crew's canvas items end with the voyage (lib/canvas-archive.ts); the note says where they went.
  const canvas = await archiveCanvas(crewIds, v.file.split("/").pop()!.replace(/\.md$/, "")).catch(() => ({ items: 0, dir: null }));
  let text = await readFile(v.file, "utf8");
  text = text.replace(/^status: sailing$/m, "status: docked").replace(/^started: (.*)$/m, `started: $1\nended: ${now}`);
  const note = summary.trim();
  // A session's outcome: the brief the officer wrote into the scratchpad becomes a section of its record.
  const brief = v.session ? extractBrief(scratch, v.session) : "";
  if (v.session) {
    text = text.replace(/^status: docked$/m, "status: wrapped");
    text = text.trimEnd() + `\n- ${now} wrapped up${delivered ? `; ${delivered}` : ""}\n` + (note ? `\n## Summary\n\n${note}\n` : "") + `\n## ${briefHeading(v.session)}\n\n${brief || "(The session ended without a brief in the scratchpad; see the memory below.)"}\n` + (scratch ? `\n## Session memory (archived at wrap-up)\n\n${scratch}\n` : "") + (canvas.dir ? `\nCanvas: ${canvas.items} item(s) archived to fleet/inbox/${canvas.dir} (kept 30 days).\n` : "");
    await writeFile(v.file, text, "utf8");
    finishQueueItem(v.file, brief ? "done" : "done-without-brief");
    // D2: the architect drafts the spec from the brief; the captain reviews it in the queue.
    if (brief) await requestSpec(shipId, v.goal, v.file).catch((e) => logShipEvent(shipId, "helm", "notice", `The spec request did not reach the architect: ${e instanceof Error ? e.message : String(e)}`));
    logShipEvent(shipId, "captain", "voyage-end", note || `${v.session} session wrapped up`, { file: v.file });
    return { ok: true, message: `${shipId}'s ${v.session} session wrapped up. ${delivered}${brief ? ` The ${briefHeading(v.session).toLowerCase()} is in the record.` : " No brief was written."}` };
  }
  if (v.spec) setSpecStatus(v.spec, "built");
  text = text.trimEnd() + `\n- ${now} docked${released.message ? `; ${released.message}` : ""}\n` + (delivered ? `\n${delivered}\n` : "") + (note ? `\n## Summary\n\n${note}\n` : "") + (ledger ? `\n${ledgerMarkdown(ledger)}` : "") + (review ? `\n## Dock review\n\n${reviewLine(review)}\n` : "") + (scratch ? `\n## Voyage memory (archived at dock)\n\n${scratch}\n` : "") + (canvas.dir ? `\nCanvas: ${canvas.items} item(s) archived to fleet/inbox/${canvas.dir} (kept 30 days).\n` : "");
  await writeFile(v.file, text, "utf8");
  logShipEvent(shipId, "captain", "voyage-end", note || "Docked", { file: v.file });
  return { ok: true, message: `${shipId} docked.${released.message ? ` ${released.message}` : ""}${delivered ? ` ${delivered}` : ""}${ledger ? ` ${ledgerLine(ledger)}` : ""}${review ? ` ${reviewLine(review)}` : ""}` };
}

/**
 * Move an open laptop (or exe.dev VM) voyage to the hub (the captain is closing the laptop for
 * the day): the crew stops, the voyage branch is pushed from the laptop, the
 * crew's memory comes back, the laptop's worktree is returned, and a hub
 * worktree carries on from the pushed branch. Crew sessions start fresh on the
 * hub; their plan and state notes carry the voyage. Uncommitted work on the
 * laptop keeps the voyage where it is.
 */
export async function moveVoyageToHub(shipId: string, stop: (agentId: string) => Promise<void>): Promise<{ ok: boolean; message: string }> {
  const ship = await findShip(shipId);
  const v = await openVoyage(shipId);
  const w = voyageWorktree(shipId);
  if (!ship || !v || !w) return { ok: false, message: `${shipId} has no open voyage with a worktree.` };
  if ((w.host ?? "local") === "local") return { ok: false, message: `${shipId}'s voyage is already on the hub.` };
  if (ship.isolation === "vm" && process.platform !== "darwin") return { ok: false, message: `${shipId}'s crew works in Gondolin VMs, which the hub cannot run; leave the voyage on the laptop (it waits while the laptop sleeps).` };
  const from = voyageHost(shipId);
  const crewIds = ship.crew.map((r) => `${shipId}-${r}`);
  for (const id of crewIds) await stop(id);
  const branch = (await from.exec(["git", "branch", "--show-current"], { timeoutMs: 15_000, cwd: w.path })).stdout.trim() || w.branch;
  const dirty = (await from.exec(["git", "status", "--porcelain"], { timeoutMs: 30_000, cwd: w.path }));
  if (dirty.exitCode !== 0) return { ok: false, message: `${from.label} did not answer (${dirty.stderr.slice(0, 160)}); the voyage stays there.` };
  if (dirty.stdout.trim()) return { ok: false, message: `${shipId}'s worktree on ${from.label} has uncommitted work; have the crew commit it, then move the voyage.` };
  const push = await from.exec(["git", "push", "-u", "origin", branch], { timeoutMs: 120_000, cwd: w.path });
  if (push.exitCode !== 0) return { ok: false, message: `Could not push ${branch} from ${from.label}: ${(push.stderr || push.stdout).split("\n").pop()?.slice(0, 160)}` };
  if (from.getMemory) await writeMemoryFiles(await from.getMemory(shipId, crewIds)).catch(() => {});
  const fromVm = w.vm;
  await unrigVoyage(ship);
  const released = await releaseVoyageWorktree(ship);
  if (!released.ok) return { ok: false, message: `The branch is pushed, but ${from.label}'s worktree was not returned: ${released.message}` };
  const slug = v.file.split("/").pop()!.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
  const lease = await leaseVoyageWorktree(ship, slug, v.goal, localHost, { branch, base: w.base });
  if (!lease.ok) return { ok: false, message: `${branch} is pushed and ${from.label}'s worktree returned, but the hub could not take the voyage: ${lease.message} Start it again, or lease a worktree by hand.` };
  // The hub has the voyage: the VM it came from is no longer needed.
  if (fromVm) {
    const gone = await releaseVoyageVm(fromVm);
    logShipEvent(shipId, "helm", "notice", gone.message);
  }
  for (const id of crewIds) await freshCrewSession(id);
  // The stack comes up again on the hub; the crew already has its brief.
  const replan = planRig(ship, slug, "local");
  if (replan && !("error" in replan)) void rigVoyage(ship, null).catch((e) => console.error("[rig]", e));
  const now = new Date().toISOString();
  let text = await readFile(v.file, "utf8");
  text = text.replace(/^host: .*$/m, "host: hub").replace(/^worktree: .*$/m, `worktree: ${yamlStr(lease.worktree.path)}`);
  await writeFile(v.file, text.trimEnd() + `\n- ${now} moved from ${from.label} to the hub; branch ${branch} pushed and checked out in ${lease.worktree.path}\n`, "utf8");
  logShipEvent(shipId, "captain", "voyage-move", `Voyage moved from ${from.label} to the hub (branch ${branch})`, { branch, worktree: lease.worktree.path });
  return { ok: true, message: `${shipId}'s voyage moved to the hub: ${branch} pushed from ${from.label} and checked out here. The crew starts fresh sessions; their plan and notes carry on.` };
}

/** The lead's view of the ship's maneuvers, for the voyage brief. */
function maneuverBrief(ship: ShipRow): string[] {
  const all = maneuverAvailability(ship, "lead");
  if (!all.length) return ["No maneuvers on this ship."];
  return ["Maneuvers (maneuver_start; locked ones cannot start):", ...all.map((m) => `- ${describeManeuver(m)}`)];
}

/** What a voyage was decided as (D3): the approved spec and its acceptance criteria, or a chore. */
function specBrief(v: Voyage): string[] {
  if (v.spec) {
    const spec = parseSpec(v.spec);
    if (!spec) return [`Build the approved spec at ${v.spec} (read it first).`];
    return [
      `Build the approved spec at ${spec.file}: read it first (goal, scope, non-goals, design, technical approach, task shape). Plan the tasks from it; it is decided, so do not re-open the direction (questions for the captain only where the spec leaves one open).`,
      ...(spec.prototype ? [`Your branch starts from the prototype ${spec.prototype} (pushed by the design or spec session): make it production-ready rather than starting over; remove the prototype switches the spec says to drop.`] : []),
      "Acceptance criteria (each must be met and checked; when you ask to dock, list every one with how it was checked):",
      ...spec.criteria.map((c, i) => `${i + 1}. ${c}`),
    ];
  }
  if (v.chore) return ["This voyage is a chore: a fix, docs, or a small change with no new UI or behaviour. If it turns out to need a decision (a new look, a new behaviour, options), stop and file it with queue_request instead of choosing."];
  return [];
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
      ...specBrief(v),
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

/** Open the session a queue item asks for (lib/decision-queue.ts): the item goes active and names its record. */
export async function startQueueSession(id: string, opts: Omit<SailOpts, "session"> = {}): Promise<{ ok: boolean; message: string }> {
  const item = readQueue().find((i) => i.id === id);
  if (!item) return { ok: false, message: "No such queue item." };
  if (item.status !== "queued") return { ok: false, message: `That item is ${item.status}.` };
  const kind: SessionKind | null = item.kind === "design-session" ? "design" : item.kind === "spec-session" ? "spec" : null;
  if (!kind) return { ok: false, message: "Only design and spec sessions start from the queue; reviews open their document." };
  const goal = `${item.title}${item.request ? `. ${item.request}` : ""}`;
  const r = await startVoyage(item.ship, goal, SESSION_KINDS[kind], "laptop", { ...opts, session: kind });
  if (r.ok && r.voyage) updateQueueItem(id, { status: "active", record: r.voyage.file });
  return { ok: r.ok, message: r.message };
}

/** After a session: a spec review on the captain's queue, and the request on the architect's bus. */
export async function requestSpec(shipId: string, topic: string, record: string): Promise<void> {
  const title = `Spec: ${topic.split(/[.\n]/)[0]!.slice(0, 120)}`;
  const r = addQueueItem({ kind: "spec-review", ship: shipId, title, request: `Drafted by the architect from the session record ${record}.`, by: "helm", source: record });
  if (!r.ok) throw new Error(r.message);
  const posted = await busPost("helm", { to: "architect", kind: "spec-request", summary: `Write the spec for ${shipId}: ${topic.slice(0, 160)}. Read the brief in the session record, write fleet/specs/${shipId}/<slug>.md, then spec_submit with queue ${r.item.id}.`, ref: record, ship: shipId }, async (id) => id === "architect");
  if (!posted.ok) throw new Error(posted.message);
}
