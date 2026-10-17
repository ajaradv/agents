import { loadAgents, isOrchestratorOrAssistant } from "./agents.ts";
import { lastBusLine } from "./bus.ts";
import { resolveAgentStatus } from "./agent-status.ts";
import { isTuiAgent } from "./herdr.ts";
import { chatAllowed } from "./chat.ts";

export type AgentStatusJson = {
  id: string;
  type: string;
  model: string;
  chatState: string;
  chatLabel: string;
  tuiState: string;
  tuiLabel: string;
  message?: string;
  tuiMessage?: string;
  orchestrator: boolean;
  canStartStop: boolean;
  lastEvent?: string;
  lastChatTurn?: {
    at: string;
    status: string;
    ms: number;
    error?: string;
  } | null;
  waitingOnYou?: boolean;
  firstmateWaitSummary?: string;
};

export async function agentsStatusJson(): Promise<{ agents: AgentStatusJson[] }> {
  // Crew-only templates (scout) exist only aboard ships, as <ship>-<role>.
  const agents = (await loadAgents()).filter((a) => !a.crewOnly);
  // Each agent's status (herdr pane checks) at the same time, not one after another.
  const resolved = await Promise.all(agents.map(async (a) => [chatAllowed(a.id) ? await resolveAgentStatus(a.id) : null, await lastBusLine(a.id)] as const));
  const out: AgentStatusJson[] = [];
  for (const [i, a] of agents.entries()) {
    const [status, last] = resolved[i]!;
    let lastShort: string | undefined;
    if (last) {
      try {
        const o = JSON.parse(last) as { summary?: string; kind?: string };
        lastShort = (o.summary ?? o.kind ?? last).slice(0, 120);
      } catch {
        lastShort = last.slice(0, 120);
      }
    }
    out.push({
      id: a.id,
      type: a.type,
      model: a.model,
      chatState: status?.chatState ?? "unavailable",
      chatLabel: status?.chatLabel ?? "—",
      tuiState: status?.tuiState ?? "stopped",
      tuiLabel: status?.tuiLabel ?? "—",
      message: status?.tuiMessage,
      tuiMessage: status?.tuiMessage,
      orchestrator: isOrchestratorOrAssistant(a),
      canStartStop: isTuiAgent(a.id),
      lastEvent: lastShort,
      lastChatTurn: status?.lastChatTurn ?? null,
      waitingOnYou: status?.firstmateWait?.waitingOnYou,
      firstmateWaitSummary: status?.firstmateWait?.displaySummary,
    });
  }
  return { agents: out };
}
