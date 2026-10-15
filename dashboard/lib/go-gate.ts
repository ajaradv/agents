import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeStateDir } from "./paths.ts";

/**
 * The captain's Go for fleet actions (Alice omni plan, phase 3): an officer's
 * tier 2 call outside an approved order is not run. The fleet node stores it
 * here, posts a Go / No line in the officer's thread, and runs it only when the
 * captain says Go (dashboard button, Needs you). The model cannot talk itself
 * into one; the gate is in the server, not the prompt.
 *
 * Pending requests live in fleet/inbox/.node/go-pending.json so the dashboard
 * (Needs you) can list them and a node restart does not lose them.
 */

/** Fleet actions that change state; each needs the captain's Go (or an approved order step). */
export const TIER2_TOOLS: Record<string, { params: string[]; required: string[] }> = {
  voyage_start: { params: ["ship", "goal", "to"], required: ["ship", "goal", "to"] },
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
};

function storePath(): string {
  return join(nodeStateDir(), "go-pending.json");
}

export async function readGoRequests(): Promise<GoRequest[]> {
  try {
    const j = JSON.parse(await readFile(storePath(), "utf8")) as unknown;
    return Array.isArray(j) ? (j as GoRequest[]) : [];
  } catch {
    return [];
  }
}

export async function writeGoRequests(list: GoRequest[]): Promise<void> {
  await mkdir(nodeStateDir(), { recursive: true });
  await writeFile(storePath() + ".tmp", JSON.stringify(list, null, 1) + "\n", "utf8");
  await rename(storePath() + ".tmp", storePath());
}

/** What the captain is asked to approve, in words. */
export function describeAction(tool: string, a: Record<string, string>): string {
  switch (tool) {
    case "voyage_start":
      return `Set sail on ${a.ship}: "${a.goal}", sent to ${a.to}.`;
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
  if (tool === "orchestrator_set" && !["firstmate", "lead"].includes(a.orchestrator ?? "")) return "orchestrator is firstmate or lead.";
  return null;
}
