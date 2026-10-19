import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Self-hosted pixel portraits under /art */
const AGENT_ART: Record<string, string> = {
  alice: "/art/alice.png",
  firstmate: "/art/firstmate.png",
  architect: "/art/architect.png",
  shipwright: "/art/shipwright.png",
  designer: "/art/designer.png",
  // Crew roles reuse the crew pool's named portraits.
  scout: "/art/crew/lookout.png",
  lead: "/art/crew/bosun.png",
  helmsman: "/art/helmsman.png",
  builder: "/art/builder.png",
};

export const CAPTAIN_ART = "/art/captain.png";

/** Portrait for a registered agent, or null so the UI draws initials. */
export function agentArtOrNull(agentId: string): string | null {
  return AGENT_ART[agentId] ?? null;
}

export function agentArtPath(agentId: string): string {
  return AGENT_ART[agentId] ?? CAPTAIN_ART;
}

/** Portrait pools for Firstmate tasks: public/art/<pool>/*.png (bin/agent-portrait --pool). */
export type ArtPool = "crew" | "secondmate";

export function poolFor(kind: string | undefined): ArtPool {
  return kind === "secondmate" ? "secondmate" : "crew";
}

export function poolArt(pool: ArtPool, dir = join(import.meta.dir, "..", "public", "art")): string[] {
  try {
    return readdirSync(join(dir, pool))
      .filter((f) => /^[a-z0-9_-]+\.png$/.test(f))
      .sort()
      .map((f) => `/art/${pool}/${f}`);
  } catch {
    return [];
  }
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Pick a pool portrait for a task id: start at the id's hash and take the first
 * one no other live task wears; when the pool is exhausted, share by hash.
 */
export function pickPoolArt(id: string, pool: string[], taken: Set<string>): string | null {
  if (pool.length === 0) return null;
  const start = hashId(id) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const art = pool[(start + i) % pool.length]!;
    if (!taken.has(art)) return art;
  }
  return pool[start]!;
}
