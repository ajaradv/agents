import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readShips } from "./fleet-layers.ts";
import { ROOT } from "./paths.ts";

export type AgentMeta = {
  id: string;
  type: string;
  role: string;
  model: string;
  harness: string;
  /** `description:` from the roles/<role>.md frontmatter; empty when absent. */
  description: string;
  /** `turn_timeout:` seconds for one dashboard turn; 0 means the bridge default. */
  turnTimeoutSec: number;
  /** `runtime:` in agent.yaml: "rpc" runs the agent as one live Pi RPC session in the dashboard; default "headless". */
  runtime: "headless" | "rpc";
  /** `dashboard_session: persistent`: dashboard turns and the TUI share one Pi session. */
  persistentSession: boolean;
  /** `crew: true`: the template can be deployed aboard ships as a crewmate. */
  crewEligible: boolean;
  /** `crew: only`: a template that exists only aboard ships, never on the rail by itself. */
  crewOnly: boolean;
  /** `voice:` Kokoro voice id (e.g. af_heart); empty means the role's default. */
  voice: string;
  /** Set for ship crewmates (`<ship>-<role>`): the ship they serve aboard. */
  ship?: string;
};

function parseAgentYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const [key, ...rest] = line.split(":");
    const val = rest.join(":").trim().replace(/^["']|["']$/g, "");
    if (val) out[key.trim()] = val;
  }
  return out;
}

/** `description:` from a role file's frontmatter block. */
export function roleDescription(markdown: string): string {
  const m = markdown.match(/^---\n([\s\S]*?)\n---/);
  const line = m?.[1]?.split("\n").find((l) => l.startsWith("description:"));
  return line ? line.slice("description:".length).trim().replace(/^["']|["']$/g, "") : "";
}

async function readRoleDescription(role: string): Promise<string> {
  if (!/^[a-z][a-z0-9_-]*$/.test(role)) return "";
  try {
    return roleDescription(await readFile(join(ROOT, "roles", `${role}.md`), "utf8"));
  } catch {
    return "";
  }
}

export async function loadAgents(): Promise<AgentMeta[]> {
  const dir = join(ROOT, "agents");
  const ids = await readdir(dir, { withFileTypes: true });
  const agents: AgentMeta[] = [];
  for (const ent of ids) {
    if (!ent.isDirectory()) continue;
    const yamlPath = join(dir, ent.name, "agent.yaml");
    try {
      const text = await readFile(yamlPath, "utf8");
      const y = parseAgentYaml(text);
      const role = y.role ?? ent.name;
      agents.push({
        id: y.id ?? ent.name,
        type: y.type ?? "assistant",
        role,
        model: y.model ?? "",
        harness: y.harness ?? "pi",
        description: await readRoleDescription(role),
        turnTimeoutSec: Math.max(0, Math.min(3600, Number(y.turn_timeout) || 0)),
        runtime: y.runtime === "rpc" ? "rpc" : "headless",
        persistentSession: y.dashboard_session === "persistent",
        crewEligible: y.crew === "true" || y.crew === "only",
        crewOnly: y.crew === "only",
        voice: y.voice ?? "",
      });
    } catch {
      /* skip */
    }
  }
  // Ship crewmates: a role template deployed aboard a ship (always live and persistent).
  const templates = new Map(agents.map((a) => [a.id, a]));
  for (const ship of await readShips()) {
    for (const role of ship.crew) {
      const t = templates.get(role);
      if (!t || !ship.path) continue;
      agents.push({
        ...t,
        id: `${ship.id}-${role}`,
        model: ship.crewModels[role] || t.model,
        runtime: "rpc",
        persistentSession: true,
        crewOnly: false,
        ship: ship.id,
      });
    }
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

export function isOrchestratorOrAssistant(a: AgentMeta): boolean {
  return a.type === "orchestrator" || a.type === "assistant";
}
