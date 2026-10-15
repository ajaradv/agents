import type { HostEvent } from "./agent-host.ts";
import type { ChatLine } from "./chat.ts";
import { chatTarget } from "./chat-targets.ts";
import { formatDuration } from "./partials.ts";
import { logShipEvent } from "./ship-log.ts";

/**
 * Feed agent activity into a ship's log (lib/ship-log.ts): crewmates into
 * their ship's, officers (Alice, the Architect, the Designer, ...) into the
 * `fleet` ship's, so their turns and spend are on record too. Firstmate and
 * its workers keep their own records. Called from the chat bridge, which
 * already sees every captain line, agent line, host event, and turn result.
 */

/** Officers' activity is logged on this ship (fleet/ships/fleet.yaml, the agents repo). */
export const OFFICER_SHIP = "fleet";

export function shipOf(agentId: string): string | null {
  const t = chatTarget(agentId);
  if (!t) return null;
  if (t.ship) return t.ship;
  return t.kind === "headless" ? OFFICER_SHIP : null;
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
  // Which crewmate the captain was talking to, so an answer to one does not
  // clear another's "Needs you" (lib/ship-view.ts).
  if (line.from === "captain") payload.to = agentId;
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
  const took = formatDuration(outcome.ms);
  const summary = outcome.ok ? `Turn done in ${took}` : `Turn failed after ${took}: ${outcome.error ?? "error"}`;
  logShipEvent(ship, agentId, "turn-end", summary, {
    ms: outcome.ms,
    cost: outcome.cost,
    tokens: outcome.tokens,
    ...(outcome.error ? { error: outcome.error } : {}),
  });
}
