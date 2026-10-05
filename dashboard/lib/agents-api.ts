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
  const agents = await loadAgents();
  const out: AgentStatusJson[] = [];
  for (const a of agents) {
    const status = chatAllowed(a.id)
      ? await resolveAgentStatus(a.id)
      : null;
    const last = await lastBusLine(a.id);
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
      firstmateWaitSummary: status?.firstmateWait?.captainWait?.summary,
    });
  }
  return { agents: out };
}
