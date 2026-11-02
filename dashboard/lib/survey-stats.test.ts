import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReviewText } from "./review-status.ts";
import { parseSurveyFile, surveyFiles, surveyStats, type SurveyFile } from "./survey-stats.ts";

const ZOOM = "openrouter/openai/gpt-6.1-sol";
const CRITIC = "openrouter/anthropic/claude-sonnet-5.5";
const FLASH = "openrouter/google/gemini-3.7-flash";
const DEEP = "openrouter/deepseek/deepseek-v4-pro";

const head = (lenses: string, extra = "mode: review\ndepth: full") => `---
type: survey
target: fleet/plans/feature/goldfish-review.md
${extra}
sha: 4d5a23eb479447aa15d0c94698d88f0f6209898d
writer: anthropic/claude-opus-5.5
cost_usd: 0.5114
lenses:
${lenses}
---

# Review 2 of goldfish-review
`;
const lens = (l: string, model: string, status = "done", cost = 0.1) => `  - lens: ${l}\n    model: ${model}\n    status: ${status}\n    cost: ${cost}`;
const finding = (id: number, sev: string, l: string, model: string) => `### F${id} — ${sev}: scope ${id}\nLens: ${l} (${model})\n\nBody ${id}.\n`;

/** Modelled on review-2: four lenses, six findings, three resolution forms, one finding left open. */
const REVIEW_2 = `${head([lens("zoom-out", ZOOM, "done", 0.1723), lens("design-critic", CRITIC, "done", 0.1071), lens("readiness", FLASH, "done", 0.1022), lens("codebase", DEEP, "done", 0.1297)].join("\n"))}
## Findings

${[finding(1, "Blocker", "codebase", DEEP), finding(2, "Major", "zoom-out", ZOOM), finding(3, "Major", "design-critic", CRITIC), finding(4, "Nit", "readiness", FLASH), finding(5, "Major", "codebase", DEEP), finding(6, "Nit", "zoom-out", ZOOM)].join("\n")}
## Resolution

F1: contest — the verdict type does have the field
F2: fix
F3: decline - typed dash
F4: escalate — the captain decides
F5: fix — done
F9: fix — no such finding
`;

const iso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

describe("parseSurveyFile", () => {
  test("reads the lenses, findings and three resolution forms; an unresolved finding stays null and a stray id is ignored", () => {
    const f = parseSurveyFile(REVIEW_2, "fleet/reviews/goldfish-review/review-2.md", iso(1))!;
    expect(f).toMatchObject({ slug: "goldfish-review", n: 2, mode: "review", depth: "full", writer: "anthropic/claude-opus-5.5", cost: 0.5114 });
    expect(f.lenses.map((l) => [l.lens, l.status, l.cost])).toEqual([["zoom-out", "done", 0.1723], ["design-critic", "done", 0.1071], ["readiness", "done", 0.1022], ["codebase", "done", 0.1297]]);
    expect(f.findings.map((x) => [x.id, x.lens, x.resolution])).toEqual([[1, "codebase", "contest"], [2, "zoom-out", "fix"], [3, "design-critic", "decline"], [4, "readiness", "escalate"], [5, "codebase", "fix"], [6, "zoom-out", null]]);
    expect(f.findings[0]).toMatchObject({ severity: "Blocker", model: DEEP });
  });

  test("a file without type: survey is null", () => {
    expect(parseSurveyFile("---\ntarget: x\n---\n### F1 — Major: a\n", "fleet/reviews/x/review-1.md", iso(1))).toBeNull();
    expect(parseSurveyFile("no frontmatter", "fleet/reviews/x/review-1.md", iso(1))).toBeNull();
  });

  test("a finding with no Lens line counts under unknown", () => {
    const text = `${head(lens("codebase", DEEP))}\n## Findings\n\n### F1 — Major: lone\n\nNo lens line.\n\n${finding(2, "Nit", "codebase", DEEP)}`;
    const f = parseSurveyFile(text, "fleet/reviews/x/review-1.md", iso(1))!;
    expect(f.findings.map((x) => [x.lens, x.model])).toEqual([["unknown", ""], ["codebase", DEEP]]);
    const rows = surveyStats([f]).by_lens;
    expect(rows.map((r) => [r.lens, r.findings])).toEqual([["codebase", 1], ["unknown", 1]]);
  });

  test("the date frontmatter wins over the mtime", () => {
    const withDate = parseSurveyFile(head(lens("codebase", DEEP), `mode: review\ndate: 2026-11-01T10:00:00.000Z`), "fleet/reviews/x/review-1.md", "2020-01-01T00:00:00.000Z")!;
    expect(withDate.date).toBe("2026-11-01T10:00:00.000Z");
    expect(parseSurveyFile(head(lens("codebase", DEEP)), "fleet/reviews/x/review-1.md", "2020-01-01T00:00:00.000Z")!.date).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("parseReviewText", () => {
  test("captures the verb of each resolution", () => {
    const r = parseReviewText(REVIEW_2);
    expect([...r.resolutions]).toEqual([[1, "contest"], [2, "fix"], [3, "decline"], [4, "escalate"], [5, "fix"], [9, "fix"]]);
    expect(r.findings).toHaveLength(6);
  });
});

describe("surveyStats", () => {
  test("counts findings, resolutions and cost per lens and model, sorted by mode, lens, model", () => {
    const f = parseSurveyFile(REVIEW_2, "fleet/reviews/goldfish-review/review-2.md", iso(1))!;
    const s = surveyStats([f]);
    expect(s.by_lens_model.map((r) => r.lens)).toEqual(["codebase", "design-critic", "readiness", "zoom-out"]);
    const code = s.by_lens.find((r) => r.lens === "codebase")!;
    expect(code).toMatchObject({ mode: "review", reviews: 1, not_run: 0, findings: 2, blocker: 1, major: 1, nit: 0, fix: 1, contest: 1, escalate: 0, decline: 0, open: 0, cost: 0.1297, cost_per_finding: 0.0649, rejected_share: 0.5, trim: false });
    const zoom = s.by_lens.find((r) => r.lens === "zoom-out")!;
    expect(zoom).toMatchObject({ findings: 2, open: 1, fix: 1, rejected_share: 0 });
    expect(s.by_model.find((r) => r.model === ZOOM)).toMatchObject({ mode: "review", reviews: 1, not_run: 0, not_run_share: 0, findings: 2, cost: 0.1723, cost_per_finding: 0.0862 });
  });

  test("a lens listed not run counts in not_run and not in reviews", () => {
    const text = `${head([lens("codebase", DEEP), lens("zoom-out", ZOOM, "not run", 0)].join("\n"))}\n## Findings\n\n${finding(1, "Nit", "codebase", DEEP)}`;
    const s = surveyStats([parseSurveyFile(text, "fleet/reviews/x/review-1.md", iso(1))!]);
    expect(s.by_lens.find((r) => r.lens === "zoom-out")).toMatchObject({ reviews: 0, not_run: 1, findings: 0, cost_per_finding: null, rejected_share: null });
    expect(s.by_model.find((r) => r.model === ZOOM)).toMatchObject({ reviews: 0, not_run: 1, not_run_share: 1 });
  });

  test("a brainstorm is counted with null resolution fields and never trims", () => {
    const text = `${head(lens("angles", DEEP, "done", 0.2), "mode: brainstorm\ndepth: light")}\n## Findings\n\n${finding(1, "Major", "angles", DEEP)}`;
    const make = (n: number) => parseSurveyFile(text, `fleet/reviews/x/brainstorm-${n}.md`, iso(1))!;
    expect(make(1).mode).toBe("brainstorm");
    const row = surveyStats(Array.from({ length: 12 }, (_, i) => make(i + 1))).by_lens[0]!;
    expect(row).toMatchObject({ mode: "brainstorm", lens: "angles", reviews: 12, findings: 12, fix: null, contest: null, escalate: null, decline: null, open: null, rejected_share: null, trim: false });
  });

  test("mode sorts before lens", () => {
    const rev = parseSurveyFile(head(lens("zoom-out", ZOOM)), "fleet/reviews/x/review-1.md", iso(1))!;
    const bs = parseSurveyFile(head(lens("angles", ZOOM), "mode: brainstorm"), "fleet/reviews/x/brainstorm-1.md", iso(1))!;
    expect(surveyStats([rev, bs]).by_lens.map((r) => [r.mode, r.lens])).toEqual([["brainstorm", "angles"], ["review", "zoom-out"]]);
  });

  /** `files` reviews of one lens whose findings, over all files, are `contest` contested and `fix` fixed. */
  const lensFiles = (files: number, contest: number, fix: number): SurveyFile[] => {
    const verbs = [...Array(contest).fill("contest"), ...Array(fix).fill("fix")] as string[];
    return Array.from({ length: files }, (_, i) => {
      const mine = verbs.filter((_, k) => k % files === i);
      const body = mine.map((_, k) => finding(k + 1, "Major", "codebase", DEEP)).join("\n");
      const res = mine.map((v, k) => `F${k + 1}: ${v} — why`).join("\n");
      return parseSurveyFile(`${head(lens("codebase", DEEP))}\n## Findings\n\n${body}\n## Resolution\n\n${res}\n`, `fleet/reviews/x/review-${i + 1}.md`, iso(1))!;
    });
  };

  test("trim needs ten reviews and a rejected share over 0.6", () => {
    const ten = surveyStats(lensFiles(10, 7, 3)).by_lens[0]!;
    expect(ten).toMatchObject({ reviews: 10, findings: 10, rejected_share: 0.7, trim: true });
    expect(surveyStats(lensFiles(9, 7, 3)).by_lens[0]).toMatchObject({ reviews: 9, rejected_share: 0.7, trim: false });
    expect(surveyStats(lensFiles(10, 6, 4)).by_lens[0]).toMatchObject({ reviews: 10, rejected_share: 0.6, trim: false });
  });
});

describe("surveyFiles", () => {
  const vault = mkdtempSync(join(tmpdir(), "survey-stats-"));
  afterAll(() => rmSync(vault, { recursive: true, force: true }));

  test("reads review and brainstorm files, newest first, and counts the hand-written ones it skips", () => {
    const dir = join(vault, "fleet", "reviews", "plan-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "review-1.md"), REVIEW_2);
    writeFileSync(join(dir, "brainstorm-1.md"), head(lens("angles", DEEP), "mode: brainstorm\ndate: 2026-11-02T00:00:00.000Z"));
    writeFileSync(join(dir, "review-2.md"), "# a hand-written review\n\n### F1 — Major: x\n");
    writeFileSync(join(dir, "triage.md"), head(lens("x", DEEP)));
    const old = new Date("2026-10-01T00:00:00Z");
    utimesSync(join(dir, "review-1.md"), old, old);
    const { files, skipped_files } = surveyFiles(vault);
    expect(skipped_files).toBe(1);
    expect(files.map((f) => f.rel)).toEqual(["fleet/reviews/plan-a/brainstorm-1.md", "fleet/reviews/plan-a/review-1.md"]);
    expect(files[1]!.date).toBe(old.toISOString());
  });

  test("no reviews directory is an empty result", () => {
    expect(surveyFiles(join(vault, "nowhere"))).toEqual({ files: [], skipped_files: 0 });
  });
});
