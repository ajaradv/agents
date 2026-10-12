import type { HostEvent } from "./agent-host.ts";
import type { ChatLine } from "./chat.ts";
import { chatTarget } from "./chat-targets.ts";
import { logShipEvent } from "./ship-log.ts";

/**
 * Feed crewmate activity into its ship's log (lib/ship-log.ts). Agents that are
 * not aboard a ship are ignored. Called from the chat bridge, which already
 * sees every captain line, agent line, host event, and turn result.
 */

function shipOf(agentId: string): string | null {
  return chatTarget(agentId)?.ship ?? null;
}

export function logCrewLine(agentId: string, line: ChatLine): void {
  const ship = shipOf(agentId);
  if (!ship) return;
  if (line.kind === "crew") {
    logShipEvent(ship, line.from, "crew", `→ ${agentId}: ${line.text}`, { to: agentId }, { ts: line.ts });
    return;
  }
  const kind =
    line.from === "captain"
      ? line.kind === "answer" ? "answer" : "chat-in"
      : line.kind === "question" ? "question" : line.kind === "error" ? "notice" : "chat-out";
  const payload: Record<string, unknown> = {};
  if (line.questions?.length) payload.questions = line.questions.map((q) => q.question);
  if (line.kind === "error") payload.level = "error";
  logShipEvent(ship, line.from === "captain" ? "captain" : agentId, kind, line.text, Object.keys(payload).length ? payload : null, { ts: line.ts });
}

export function logCrewEvent(agentId: string, ev: HostEvent): void {
  const ship = shipOf(agentId);
  if (!ship) return;
  if (ev.kind === "activity" && ev.text) logShipEvent(ship, agentId, "tool", ev.text);
  else if (ev.kind === "running" && ev.running) logShipEvent(ship, agentId, "turn-start", "");
  else if (ev.kind === "notice" && ev.level !== "info") logShipEvent(ship, agentId, "notice", ev.text, { level: ev.level });
}

export function logCrewTurn(agentId: string, outcome: { ok: boolean; ms: number; error?: string; cost: number; tokens: number }): void {
  const ship = shipOf(agentId);
  if (!ship) return;
  const secs = Math.round(outcome.ms / 1000);
  const summary = outcome.ok ? `Turn done in ${secs}s` : `Turn failed after ${secs}s: ${outcome.error ?? "error"}`;
  logShipEvent(ship, agentId, "turn-end", summary, {
    ms: outcome.ms,
    cost: outcome.cost,
    tokens: outcome.tokens,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}
