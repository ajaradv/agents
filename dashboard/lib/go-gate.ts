import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { listWorkflows, upsertWorkflow } from "./journal.ts";
import { nodeStateDir } from "./paths.ts";

/**
 * The captain's Go for fleet actions (Alice omni plan, phase 3): an officer's
 * tier 2 call outside an approved order is not run. The fleet node stores it
 * here, posts a Go / No line in the officer's thread, and runs it only when the
 * captain says Go (dashboard button, Needs you). The model cannot talk itself
 * into one; the gate is in the server, not the prompt.
 *
 * Requests are journal workflows (lib/journal.ts): a node restart keeps the
 * waiting ones, and a Go'd action runs at most once (its run is a checkpointed
 * step), so a crash can neither lose a decision nor repeat an action.
 */

/** Fleet actions that change state; each needs the captain's Go (or an approved order step). */
export const TIER2_TOOLS: Record<string, { params: string[]; required: string[] }> = {
  voyage_start: { params: ["ship", "goal", "to", "on"], required: ["ship", "goal", "to"] },
  voyage_dock: { params: ["ship", "summary"], required: ["ship"] },
  crew_change: { params: ["ship", "add", "remove", "role", "budget", "model"], required: ["ship"] },
  orchestrator_set: { params: ["ship", "orchestrator"], required: ["ship", "orchestrator"] },
  maneuver_start: { params: ["ship", "adw", "prompt"], required: ["ship", "adw", "prompt"] },
  agent_abort: { params: ["agent"], required: ["agent"] },
  agent_new_session: { params: ["agent"], required: ["agent"] },
};

export type GoRequest = {
  id: string;
  tool: string;
  args: Record<string, string>;
  /** The officer who asked. */
  from: string;
  ts: string;
  /** The Go line in the officer's thread. */
  lineTs: string;
  /** One sentence the captain reads. */
  summary: string;
  /** Follows this request through the journal and ship logs. */
  trace?: string;
};

/** The old file store (before the journal); imported once, then removed. */
function legacyStorePath(): string {
  return join(nodeStateDir(), "go-pending.json");
}

async function importLegacy(): Promise<void> {
  let list: GoRequest[] = [];
  try {
    list = JSON.parse(await readFile(legacyStorePath(), "utf8")) as GoRequest[];
  } catch {
    return;
  }
  for (const g of Array.isArray(list) ? list : []) upsertWorkflow("go", g.id, g as unknown as Record<string, unknown>, { status: "waiting" });
  await rm(legacyStorePath(), { force: true });
}

/** Fleet actions held for the captain's Go (journal workflows of kind "go", status waiting). */
export async function readGoRequests(): Promise<GoRequest[]> {
  await importLegacy();
  return listWorkflows<GoRequest>("go", "waiting").map((w) => w.data);
}

/** Hold a new request for the captain. */
export function holdGoRequest(req: GoRequest): void {
  upsertWorkflow("go", req.id, req as unknown as Record<string, unknown>, { status: "waiting", trace: req.trace ?? req.id });
}

/** What the captain is asked to approve, in words. */
export function describeAction(tool: string, a: Record<string, string>): string {
  switch (tool) {
    case "voyage_start":
      return `Set sail on ${a.ship}: "${a.goal}", sent to ${a.to}${a.on === "laptop" ? ", on the laptop" : a.on === "hub" ? ", on the hub" : ""}.`;
    case "voyage_dock":
      return `Dock ${a.ship}'s voyage${a.summary ? ` ("${a.summary}")` : ""}.`;
    case "crew_change":
      return a.add
        ? `Bring ${a.add} aboard ${a.ship}.`
        : a.remove
          ? `Send ${a.remove} ashore from ${a.ship}.`
          : a.budget !== undefined
            ? `Set ${a.ship}'s ${a.role} daily budget to ${a.budget === "" || a.budget === "none" ? "none" : `$${a.budget}`}.`
            : `Put ${a.ship}'s ${a.role} on ${a.model === "" || a.model === "default" ? "its default model" : a.model}.`;
    case "orchestrator_set":
      return `Have ${a.ship}'s voyages run by ${a.orchestrator === "lead" ? "its own lead" : "Firstmate"}.`;
    case "maneuver_start":
      return `Launch ${a.adw} on ${a.ship} through its lead: "${String(a.prompt ?? "").slice(0, 160)}".`;
    case "agent_abort":
      return `Stop ${a.agent} mid-turn.`;
    case "agent_new_session":
      return `Start ${a.agent} on a new, empty session.`;
    default:
      return `${tool} ${JSON.stringify(a)}`;
  }
}

/** Arguments problems for a tier 2 call, or null. */
export function tier2ArgError(tool: string, a: Record<string, string>): string | null {
  const spec = TIER2_TOOLS[tool];
  if (!spec) return `${tool} is not a fleet action.`;
  for (const k of Object.keys(a)) if (!spec.params.includes(k)) return `${tool} has no argument ${k}.`;
  for (const k of spec.required) if (!String(a[k] ?? "").trim()) return `${tool} needs ${k}.`;
  if (tool === "crew_change") {
    const ops = [a.add, a.remove, a.budget, a.model].filter((v) => v !== undefined).length;
    if (ops !== 1) return "crew_change takes exactly one of add, remove, budget (with role), or model (with role).";
    if ((a.budget !== undefined || a.model !== undefined) && !a.role) return "crew_change with budget or model needs role.";
  }
  if (tool === "voyage_start" && a.on !== undefined && !["hub", "laptop"].includes(a.on)) return "on is hub or laptop.";
  if (tool === "orchestrator_set" && !["firstmate", "lead"].includes(a.orchestrator ?? "")) return "orchestrator is firstmate or lead.";
  return null;
}
