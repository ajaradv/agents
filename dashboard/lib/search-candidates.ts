import { notePathRef } from "./recall.ts";

/**
 * Miss candidates from the search log (M6a): searches that look like the
 * first try missed. Leads only; nothing enters the eval set without a hand check.
 */

export type SearchRow = { id: number; ts: string; agent: string; tool: string; query: string; args: string; refs: string };
export type Candidate = { id: number; ts: string; agent: string; tool: string; query: string; args: string; refs: string[]; reason: "reformulation" | "follow-through"; next: string };

const REFORMULATION_MS = 3 * 60_000;
const FOLLOW_THROUGH_MS = 5 * 60_000;
const TOP = 3;

const refsOf = (r: SearchRow): string[] => {
  try {
    const x = JSON.parse(r.refs);
    return Array.isArray(x) ? x.map(String) : [];
  } catch {
    return [];
  }
};
const at = (r: SearchRow) => Date.parse(r.ts);

/** Candidates, newest first; a search flagged for both reasons appears once, as a reformulation. */
export function missCandidates(rows: SearchRow[]): Candidate[] {
  const found = new Map<number, Candidate>();
  const agents = new Set(rows.map((r) => r.agent));
  for (const agent of agents) {
    const mine = rows.filter((r) => r.agent === agent).sort((a, b) => at(a) - at(b) || a.id - b.id);
    let prev: SearchRow | undefined; // the search immediately before, any tool
    let lastVaultSearch: SearchRow | undefined;
    for (const r of mine) {
      if (r.tool !== "vault_note") {
        if (prev && prev.tool === r.tool && at(r) - at(prev) <= REFORMULATION_MS) {
          const top = new Set(refsOf(prev).slice(0, TOP));
          if (!refsOf(r).slice(0, TOP).some((x) => top.has(x))) found.set(prev.id, { id: prev.id, ts: prev.ts, agent, tool: prev.tool, query: prev.query, args: prev.args, refs: refsOf(prev), reason: "reformulation", next: r.query });
        }
        prev = r;
        if (r.tool === "vault_search") lastVaultSearch = r;
      } else if (lastVaultSearch && at(r) - at(lastVaultSearch) <= FOLLOW_THROUGH_MS) {
        const s = lastVaultSearch;
        const path = notePathRef(refsOf(r)[0] ?? r.query);
        if (!refsOf(s).map(notePathRef).includes(path) && !found.has(s.id)) found.set(s.id, { id: s.id, ts: s.ts, agent, tool: s.tool, query: s.query, args: s.args, refs: refsOf(s), reason: "follow-through", next: path });
      }
    }
  }
  return [...found.values()].sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id);
}
