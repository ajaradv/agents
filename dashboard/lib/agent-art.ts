/** Self-hosted pixel portraits under /art */
const AGENT_ART: Record<string, string> = {
  alice: "/art/alice.png",
  firstmate: "/art/firstmate.png",
  architect: "/art/architect.png",
};

export const CAPTAIN_ART = "/art/captain.png";

export function agentArtPath(agentId: string): string {
  return AGENT_ART[agentId] ?? CAPTAIN_ART;
}
