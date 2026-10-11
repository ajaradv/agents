/** Self-hosted pixel portraits under /art */
const AGENT_ART: Record<string, string> = {
  alice: "/art/alice.png",
  firstmate: "/art/firstmate.png",
  architect: "/art/architect.png",
};

export const CAPTAIN_ART = "/art/captain.png";

/** Portrait for a registered agent, or null so the UI draws initials. */
export function agentArtOrNull(agentId: string): string | null {
  return AGENT_ART[agentId] ?? null;
}

export function agentArtPath(agentId: string): string {
  return AGENT_ART[agentId] ?? CAPTAIN_ART;
}
