import { existsSync, readFileSync } from "node:fs";

/**
 * Where a goldfish review stands (vault plan fleet-engineer, E1): the finding ids are the
 * `F<n>` tokens before `## Resolution`; the resolved ones are the lines after it that start
 * "F<n>: fix|contest|escalate|decline" and a dash (an em dash, or " - " typed by hand) or the end of the line: the 2026-11-01 reviews
 * resolve some findings with a bare "F18: fix".
 * Shared with the goldfish review's own status line (GR2).
 */

export type ReviewStatus = { ids: number[]; resolved: number[]; open: number[] };

/** A resolution line: group 1 the finding id, group 2 the verb. */
export const RESOLVED = /^F(\d+): (fix|contest|escalate|decline)(?:\s*$|\s+(?:—|-)\s)/;
const HEADING = /^### F(\d+) — ([^:]+):/;
const LENS = /^Lens: (\S+) \((.*)\)\s*$/;

export type ReviewVerb = "fix" | "contest" | "escalate" | "decline";
export type ReviewFinding = { id: number; severity: string; lens: string; model: string };

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

/**
 * The findings and resolutions of one review's text (GR4): a finding is a `### F<n> — <Severity>: <scope>` heading
 * with a `Lens: <lens> (<model>)` line under it ("unknown" and "" when that line is missing); a resolution is a
 * line after `## Resolution` that RESOLVED matches. A resolution for an id that is not a finding is still listed.
 */
export function parseReviewText(text: string): { findings: ReviewFinding[]; resolutions: Map<number, ReviewVerb> } {
  const at = text.search(/^## Resolution\s*$/m);
  const lines = (at < 0 ? text : text.slice(0, at)).split("\n");
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]!);
    if (!h) continue;
    let lens = "unknown";
    let model = "";
    for (let j = i + 1; j < lines.length && !lines[j]!.startsWith("### "); j++) {
      const l = LENS.exec(lines[j]!);
      if (l) {
        lens = l[1]!;
        model = l[2]!;
        break;
      }
    }
    findings.push({ id: Number(h[1]), severity: h[2]!.trim(), lens, model });
  }
  const resolutions = new Map<number, ReviewVerb>();
  if (at >= 0) {
    for (const line of text.slice(at).split("\n")) {
      const r = RESOLVED.exec(line);
      if (r) resolutions.set(Number(r[1]), r[2] as ReviewVerb);
    }
  }
  return { findings, resolutions };
}

/**
 * How much a note changed since a review read it (GR5): lines of `after` not matched in `before` plus lines of
 * `before` not matched in `after` (a multiset difference of trimmed, non-empty lines, the `review:` and `updated:`
 * frontmatter lines left out); `total` is the non-empty lines of `before`.
 */
export function draftChange(before: string, after: string): { changed: number; total: number } {
  const lines = (t: string) => t.split("\n").filter((l) => !/^(review|updated):/.test(l)).map((l) => l.trim()).filter(Boolean);
  const a = lines(before);
  const left = new Map<string, number>();
  for (const l of a) left.set(l, (left.get(l) ?? 0) + 1);
  let extra = 0;
  for (const l of lines(after)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else extra++;
  }
  return { changed: extra + [...left.values()].reduce((x, y) => x + y, 0), total: a.length };
}
