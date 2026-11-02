import { notePathRef, recall, recallRef, ftsQuery, ftsQueryStrict } from "./recall.ts";
import { searchVault } from "./vault-index.ts";

/**
 * The M6 retrieval eval (vault plan alice-memory-and-tools, M6a): a table of
 * questions with the answers a search should find, scored as recall@5 against
 * the tools' own functions. bin/m6-eval prints it; read-only.
 */

export type EvalRow = { n: number; tool: "recall" | "vault_search"; query: string; args: Record<string, unknown>; answers: string[]; source: string };
export type Variant = "fts" | "strict";

const TOP = 5;

/** Cells of one table line; `\|` stays inside a cell (a recall id holds pipes). */
function cells(line: string): string[] {
  const parts = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return parts.map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Rows of the `| # | tool | query | args | answers | source |` table; other lines are ignored. Throws on a row it cannot read. */
export function parseEvalTable(md: string): EvalRow[] {
  const rows: EvalRow[] = [];
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const c = cells(line);
    if (c.length < 6 || !/^\d+$/.test(c[0]!)) continue; // header, separator, prose
    const [n, tool, query, args, answers, source] = c as [string, string, string, string, string, string];
    if (tool !== "recall" && tool !== "vault_search") throw new Error(`row ${n}: tool must be recall or vault_search, not "${tool}"`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.replace(/^`|`$/g, "") || "{}");
    } catch {
      throw new Error(`row ${n}: args is not JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`row ${n}: args must be a JSON object`);
    const list = answers.replace(/^`|`$/g, "").split(";").map((a) => a.trim()).filter(Boolean);
    if (!list.length) throw new Error(`row ${n}: no answers`);
    rows.push({ n: Number(n), tool, query: query.replace(/^`|`$/g, ""), args: parsed as Record<string, unknown>, answers: list.map((a) => (tool === "vault_search" ? notePathRef(a) : a)), source });
  }
  return rows;
}

/** AND results first, then the OR ones not already there, up to `k`. */
export function strictFirst(strict: string[], loose: string[], k = TOP): string[] {
  return [...new Set([...strict, ...loose])].slice(0, k);
}

/** The canonical ids of the top 5 a tool gives for a row; "strict" is the AND-first variant. */
export function topRefs(row: EvalRow, variant: Variant, vault?: string): string[] {
  if (row.tool === "recall") {
    const ids = (limit: number, match = ftsQuery) => recall(row.query, limit, match).map(recallRef);
    return variant === "fts" ? ids(TOP) : strictFirst(ids(20, ftsQueryStrict), ids(20));
  }
  const paths = (limit: number, match = ftsQuery) => {
    const r = searchVault({ query: row.query, ...row.args, limit, match }, vault) as { hits?: { path: string }[] };
    return (r.hits ?? []).map((h) => notePathRef(h.path));
  };
  return variant === "fts" ? paths(TOP) : strictFirst(paths(25, ftsQueryStrict), paths(25));
}

export type Score = { rows: number; found: number; recall_at_5: number };
const score = (rows: number, found: number): Score => ({ rows, found, recall_at_5: rows ? Math.round((found / rows) * 100) / 100 : 0 });

/** recall@5 overall, per tool and per source; `missed` lists the row numbers with no answer in the top 5. */
export function scoreEval(rows: EvalRow[], variant: Variant, vault?: string): { overall: Score; by_tool: Record<string, Score>; by_source: Record<string, Score>; missed: number[] } {
  const tally = new Map<string, [number, number]>();
  const bump = (k: string, hit: boolean) => {
    const t = tally.get(k) ?? [0, 0];
    tally.set(k, [t[0] + 1, t[1] + (hit ? 1 : 0)]);
  };
  const missed: number[] = [];
  for (const r of rows) {
    const top = topRefs(r, variant, vault);
    const hit = r.answers.some((a) => top.includes(a));
    if (!hit) missed.push(r.n);
    bump("all", hit);
    bump(`tool:${r.tool}`, hit);
    bump(`source:${r.source}`, hit);
  }
  const pick = (prefix: string) => Object.fromEntries([...tally].filter(([k]) => k.startsWith(prefix)).map(([k, [n, f]]) => [k.slice(prefix.length), score(n, f)]));
  const all = tally.get("all") ?? [0, 0];
  return { overall: score(all[0], all[1]), by_tool: pick("tool:"), by_source: pick("source:"), missed };
}
