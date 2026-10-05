import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

export type AgentMeta = {
  id: string;
  type: string;
  role: string;
  model: string;
  harness: string;
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
      agents.push({
        id: y.id ?? ent.name,
        type: y.type ?? "assistant",
        role: y.role ?? ent.name,
        model: y.model ?? "",
        harness: y.harness ?? "pi",
      });
    } catch {
      /* skip */
    }
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

export function isOrchestratorOrAssistant(a: AgentMeta): boolean {
  return a.type === "orchestrator" || a.type === "assistant";
}
