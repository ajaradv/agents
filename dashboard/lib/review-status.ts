import { existsSync, readFileSync } from "node:fs";

/**
 * Where a goldfish review stands (vault plan fleet-engineer, E1): the finding ids are the
 * `F<n>` tokens before `## Resolution`; the resolved ones are the lines after it that start
 * "F<n>: fix|contest|escalate|decline" and a dash (an em dash, or " - " typed by hand) or the end of the line: the 2026-11-01 reviews
 * resolve some findings with a bare "F18: fix".
 * Shared with the goldfish review's own status line (GR2).
 */

export type ReviewStatus = { ids: number[]; resolved: number[]; open: number[] };

const RESOLVED = /^F(\d+): (?:fix|contest|escalate|decline)(?:\s*$|\s+(?:—|-)\s)/;

const ascending = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

/** The review's finding ids, resolved ids and open ids; null when the file does not exist. */
export function reviewStatus(file: string): ReviewStatus | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const at = text.search(/^## Resolution\s*$/m);
  const findings = at < 0 ? text : text.slice(0, at);
  const ids = ascending([...findings.matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])));
  const resolved = at < 0 ? [] : ascending(text.slice(at).split("\n").map((l) => RESOLVED.exec(l)?.[1]).filter((n): n is string => n !== undefined).map(Number));
  return { ids, resolved, open: ids.filter((n) => !resolved.includes(n)) };
}
