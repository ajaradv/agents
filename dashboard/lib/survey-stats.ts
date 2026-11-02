import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseReviewText, type ReviewVerb } from "./review-status.ts";

/**
 * Survey statistics (vault plan goldfish-review, GR4): which lenses and models earn their cost, read from the
 * review files themselves (frontmatter lens list, `Lens:` lines, `## Resolution` lines). No journal rows.
 */

export type SurveyMode = "review" | "brainstorm";
export type SurveyLens = { lens: string; model: string; status: string; cost: number };
export type SurveyFinding = { id: number; severity: string; lens: string; model: string; resolution: ReviewVerb | null };
export type SurveyFile = { rel: string; slug: string; n: number; mode: SurveyMode; date: string; writer: string; depth: string; cost: number; lenses: SurveyLens[]; findings: SurveyFinding[] };

const FILE = /^fleet\/reviews\/([^/]+)\/(?:review|brainstorm)-(\d+)\.md$/;
const TRIM_REVIEWS = 10;
const TRIM_REJECTED = 0.6;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The frontmatter block as top-level `key: value` pairs and the `lenses:` list. */
function frontmatter(text: string): { top: Record<string, string>; lenses: Record<string, string>[] } | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return null;
  const top: Record<string, string> = {};
  const lenses: Record<string, string>[] = [];
  for (const line of m[1]!.split("\n")) {
    const item = /^ {2}- (\w+): ?(.*)$/.exec(line);
    if (item) {
      lenses.push({ [item[1]!]: item[2]!.trim() });
      continue;
    }
    const field = /^ {4}(\w+): ?(.*)$/.exec(line);
    if (field && lenses.length) {
      lenses[lenses.length - 1]![field[1]!] = field[2]!.trim();
      continue;
    }
    const kv = /^(\w+): ?(.*)$/.exec(line);
    if (kv) top[kv[1]!] = kv[2]!.trim();
  }
  return { top, lenses };
}

/** One review or brainstorm file; null unless its frontmatter says `type: survey`. */
export function parseSurveyFile(text: string, rel: string, mtime: string): SurveyFile | null {
  const fm = frontmatter(text);
  if (!fm || fm.top.type !== "survey") return null;
  const name = FILE.exec(rel);
  const { findings, resolutions } = parseReviewText(text);
  const ids = new Set(findings.map((f) => f.id));
  return {
    rel,
    slug: name?.[1] ?? "",
    n: Number(name?.[2] ?? 0),
    mode: fm.top.mode === "brainstorm" ? "brainstorm" : "review",
    date: fm.top.date || mtime,
    writer: fm.top.writer ?? "",
    depth: fm.top.depth ?? "",
    cost: Number(fm.top.cost_usd) || 0,
    lenses: fm.lenses.map((l) => ({ lens: l.lens ?? "", model: l.model ?? "", status: l.status ?? "", cost: Number(l.cost) || 0 })),
    findings: findings.map((f) => ({ ...f, resolution: ids.has(f.id) ? (resolutions.get(f.id) ?? null) : null })),
  };
}

/** Every survey file under `fleet/reviews/*`, newest first; `skipped_files` counts the review files without `type: survey`. */
export function surveyFiles(vault: string): { files: SurveyFile[]; skipped_files: number } {
  const files: SurveyFile[] = [];
  let skipped = 0;
  const root = join(vault, "fleet", "reviews");
  if (!existsSync(root)) return { files, skipped_files: 0 };
  for (const slug of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(root, slug.name))) {
      if (!/^(?:review|brainstorm)-\d+\.md$/.test(f)) continue;
      const path = join(root, slug.name, f);
      const parsed = parseSurveyFile(readFileSync(path, "utf8"), `fleet/reviews/${slug.name}/${f}`, statSync(path).mtime.toISOString());
      if (parsed) files.push(parsed);
      else skipped++;
    }
  }
  files.sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || a.rel.localeCompare(b.rel));
  return { files, skipped_files: skipped };
}

type Counts = {
  reviews: number;
  not_run: number;
  findings: number;
  blocker: number;
  major: number;
  nit: number;
  unparsed: number;
  fix: number | null;
  contest: number | null;
  escalate: number | null;
  decline: number | null;
  open: number | null;
  cost: number;
  cost_per_finding: number | null;
};
export type LensModelRow = Counts & { mode: SurveyMode; lens: string; model: string };
export type LensRow = Counts & { mode: SurveyMode; lens: string; rejected_share: number | null; trim: boolean };
export type ModelRow = { mode: SurveyMode; model: string; reviews: number; not_run: number; not_run_share: number | null; findings: number; cost: number; cost_per_finding: number | null };
export type SurveyStats = { by_lens_model: LensModelRow[]; by_lens: LensRow[]; by_model: ModelRow[] };

/** Files where the group ran / was listed "not run", and what it found and cost. */
type Acc = { mode: SurveyMode; lens: string; model: string; ran: Set<string>; notRun: Set<string>; findings: SurveyFinding[]; cost: number };

const bySeverity = (fs: SurveyFinding[], s: string) => fs.filter((f) => f.severity.toLowerCase() === s).length;

function counts(a: Acc): Counts {
  const resolved = a.mode === "review";
  const n = (verb: ReviewVerb) => (resolved ? a.findings.filter((f) => f.resolution === verb).length : null);
  return {
    reviews: a.ran.size,
    not_run: a.notRun.size,
    findings: a.findings.length,
    blocker: bySeverity(a.findings, "blocker"),
    major: bySeverity(a.findings, "major"),
    nit: bySeverity(a.findings, "nit"),
    unparsed: bySeverity(a.findings, "unparsed"),
    fix: n("fix"),
    contest: n("contest"),
    escalate: n("escalate"),
    decline: n("decline"),
    open: resolved ? a.findings.filter((f) => f.resolution === null).length : null,
    cost: round4(a.cost),
    cost_per_finding: a.findings.length ? round4(a.cost / a.findings.length) : null,
  };
}

const order = <T extends { mode: string; lens?: string; model?: string }>(a: T, b: T) => a.mode.localeCompare(b.mode) || (a.lens ?? "").localeCompare(b.lens ?? "") || (a.model ?? "").localeCompare(b.model ?? "");

/** Per (lens, model), per lens and per model, with `mode` a column on every row. A lens "ran" in a file when its status is done or unparsed. */
export function surveyStats(files: SurveyFile[]): SurveyStats {
  const groups = { lensModel: new Map<string, Acc>(), lens: new Map<string, Acc>(), model: new Map<string, Acc>() };
  const get = (m: Map<string, Acc>, mode: SurveyMode, lens: string, model: string) => {
    const key = JSON.stringify([mode, lens, model]);
    let a = m.get(key);
    if (!a) m.set(key, (a = { mode, lens, model, ran: new Set(), notRun: new Set(), findings: [], cost: 0 }));
    return a;
  };
  for (const f of files) {
    const accs = (lens: string, model: string) => [get(groups.lensModel, f.mode, lens, model), get(groups.lens, f.mode, lens, ""), get(groups.model, f.mode, "", model)];
    for (const l of f.lenses) {
      for (const a of accs(l.lens, l.model)) {
        if (l.status === "done" || l.status === "unparsed") a.ran.add(f.rel);
        else if (l.status === "not run") a.notRun.add(f.rel);
        a.cost += l.cost;
      }
    }
    for (const x of f.findings) for (const a of accs(x.lens, x.model)) a.findings.push(x);
  }
  const rows = (m: Map<string, Acc>) => [...m.values()];
  return {
    by_lens_model: rows(groups.lensModel).map((a) => ({ mode: a.mode, lens: a.lens, model: a.model, ...counts(a) })).sort(order),
    by_lens: rows(groups.lens)
      .map((a) => {
        const c = counts(a);
        const judged = c.open === null ? 0 : c.findings - c.open;
        const rejected_share = judged > 0 ? round4(((c.contest ?? 0) + (c.decline ?? 0)) / judged) : null;
        return { mode: a.mode, lens: a.lens, ...c, rejected_share, trim: c.reviews >= TRIM_REVIEWS && rejected_share !== null && rejected_share > TRIM_REJECTED };
      })
      .sort(order),
    by_model: rows(groups.model)
      .map((a) => {
        const c = counts(a);
        const lists = c.reviews + c.not_run;
        return { mode: a.mode, model: a.model, reviews: c.reviews, not_run: c.not_run, not_run_share: lists ? round4(c.not_run / lists) : null, findings: c.findings, cost: c.cost, cost_per_finding: c.cost_per_finding };
      })
      .sort(order),
  };
}
