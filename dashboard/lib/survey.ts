import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { postBus } from "./bus-post.ts";
import { parseHelperOutput, startHelper, watchHelper, type HelperSpawn } from "./delegate.ts";
import { readShips } from "./fleet-layers.ts";
import { getWorkflow, listWorkflows, once, updateWorkflow, upsertWorkflow } from "./journal.ts";
import { jevAsk } from "./jev.ts";
import { dashLog } from "./log.ts";
import { readModels, resolveAlias, sameModel, type ModelsConfig } from "./models-config.ts";
import { aliceVault, fleetInboxRoot, ROOT } from "./paths.ts";
import { redact } from "./redact.ts";
import { reviewStatus } from "./review-status.ts";
import { pidAlive } from "./session.ts";

/**
 * Surveyors (vault plan goldfish-review, GR2): fresh-context reviewers on other models.
 * A review is a journal workflow of kind `survey`; each reviewer is a child workflow of
 * kind `survey-lens`, run by delegate.ts's startHelper. Jev decides the depth (skip,
 * light, full); each lens takes the first roster model that is not the writer's, not
 * taken by another lens, allowed by the Cursor switch, and not failing today. The node
 * merges the reports by their fixed format into fleet/reviews/<slug>/review-<n>.md
 * (brainstorm-<n>.md for a raw idea) in the vault, and wakes the Architect.
 *
 * Limits: one review at a time (a second waits), FLEET_SURVEY_MAX reviewers at once
 * (default 4), FLEET_SURVEY_MINUTES per reviewer (default 15), FLEET_SURVEY_BUDGET_USD
 * per day (default 6).
 */

export type Mode = "brainstorm" | "review";
export type Depth = "skip" | "light" | "full";
export type Severity = "Blocker" | "Major" | "Nit" | "Unparsed";
export type Finding = { severity: Severity; scope: string; body: string };
type Res = { ok: boolean; message: string; [k: string]: unknown };

const REVIEW_LENSES = ["zoom-out", "design-critic", "readiness", "codebase"] as const;
const BRAINSTORM_LENSES = ["contrarian", "cost", "ux", "migration", "operations", "maintenance"] as const;
const LIGHT_LENSES: Record<Mode, string[]> = { review: ["readiness", "codebase"], brainstorm: ["contrarian", "cost", "operations"] };
const DEPTHS: Depth[] = ["skip", "light", "full"];
const SEVERITIES: Severity[] = ["Blocker", "Major", "Nit", "Unparsed"];
/** The standard each lens reviews against (comprehension and the brainstorm lenses have none). */
const STANDARD: Record<string, string> = { "zoom-out": "zoom-out-standard", "design-critic": "feature-spec-standard", readiness: "implementation-readiness-standard", codebase: "implementation-readiness-standard" };

const maxReviewers = () => Math.max(1, Number(process.env.FLEET_SURVEY_MAX) || 4);
const minutes = () => Math.max(1, Number(process.env.FLEET_SURVEY_MINUTES) || 15);
const budget = () => Math.max(0, Number(process.env.FLEET_SURVEY_BUDGET_USD ?? 6));

/** Test seams: a fake spawn (no real pi), a fake code preparer, a fake Jev. */
export const surveyHooks: { spawn?: HelperSpawn; prepareCode?: typeof prepareCode; ask?: typeof jevAsk; repos?: () => Promise<string[]> } = {};

export const surveysRoot = () => join(fleetInboxRoot(), ".surveys");
const today = () => new Date().toLocaleDateString("sv");

// ---------------------------------------------------------------- depth

/** Jev's depth for a note, by the dock review's pattern: the first 4,000 characters, redacted. Skip needs 0.7; a failure means light. */
export async function surveyDepth(text: string, ask: typeof jevAsk = jevAsk): Promise<{ depth: Depth; jev: string }> {
  const r = await ask("survey-depth", { note: redact(text).slice(0, 4000) }, {
    depth: {
      type: "choice",
      instructions: "Fresh reviewers will read `note` (an idea, request, plan or spec for a software fleet) before it is drafted or shown to its owner. How much review does it need?",
      criteria: {
        skip: "One ship, a few files, no new interface, data, storage or dependency, and easy to undo",
        light: "One component, following patterns that already exist",
        full: "A new component or tool, more than one ship, data or storage, security or secrets, an external service, or more than one phase",
        other: "Unclear",
      },
    },
  }).catch(() => null);
  const a = r && r.ok ? r.answers.depth : undefined;
  if (!a || a.type !== "choice") return { depth: "light", jev: "failed" };
  const p = a.probabilities[a.choice] ?? a.confidence;
  const jev = `${a.choice} ${p.toFixed(2)}`;
  if (a.choice === "full") return { depth: "full", jev };
  if (a.choice === "skip" && p >= 0.7) return { depth: "skip", jev };
  return { depth: "light", jev };
}

const rank = (d: Depth) => DEPTHS.indexOf(d);

// ---------------------------------------------------------------- lenses and models

/** The lenses for a mode and depth, in assignment order; `extra` adds comprehension (review mode). */
export function lensesFor(mode: Mode, depth: Depth, extra: string[] = []): string[] {
  if (depth === "skip") return [];
  const full: readonly string[] = mode === "review" ? REVIEW_LENSES : BRAINSTORM_LENSES;
  return [...(depth === "full" ? full : LIGHT_LENSES[mode]), ...(mode === "review" && extra.includes("comprehension") ? ["comprehension"] : [])];
}

const rosterKey = (lens: string) => ((BRAINSTORM_LENSES as readonly string[]).includes(lens) ? "brainstorm" : lens);

/**
 * Each lens takes the first roster model that is not the writer's, not taken by another lens
 * (or in `taken`), allowed by the Cursor switch, and not in today's failure list. Models match
 * across provider prefixes. A lens with no candidate left gets null ("not run").
 */
export function assignModels(lenses: string[], writer: string, roster: ModelsConfig, failedToday: string[], taken: string[] = []): { lens: string; model: string | null }[] {
  const used = [...taken];
  return lenses.map((lens) => {
    const model = (roster.surveyors[rosterKey(lens)] ?? [])
      .map((c) => resolveAlias(c, roster))
      .find((m) => !sameModel(m, writer) && !used.some((u) => sameModel(u, m)) && !(roster.cursor === "off" && m.startsWith("cursor/")) && !failedToday.some((f) => sameModel(f, m)));
    if (model) used.push(model);
    return { lens, model: model ?? null };
  });
}

const failedFile = () => join(surveysRoot(), `failed-${today()}.json`);

function failedModels(): string[] {
  try {
    const j = JSON.parse(readFileSync(failedFile(), "utf8"));
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

function markFailed(model: string): void {
  mkdirSync(surveysRoot(), { recursive: true });
  writeFileSync(failedFile(), JSON.stringify([...new Set([...failedModels(), model])]), "utf8");
}

/** The model the Architect is running (bin/launch's model-running.json): the writer its reviewers must differ from. */
export function architectWriter(): string {
  try {
    return String((JSON.parse(readFileSync(join(fleetInboxRoot(), "architect", "model-running.json"), "utf8")) as { model?: string }).model ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- fresh code

type Git = (cwd: string, args: string[]) => Promise<{ code: number; out: string; err: string }>;

const git: Git = async (cwd, args) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), 90_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
};

async function repoOf(ship: string): Promise<string | null> {
  if (ship === "fleet") return ROOT;
  return (await readShips()).find((s) => s.id === ship)?.path ?? null;
}

export type Code = { path: string | null; repo: string | null; sha: string; branch: string; note: string };

/**
 * A detached worktree at origin's default branch under fleet/inbox/.surveys/<id>/code, so reviewers
 * read the ship's current code. The fleet ship is this checkout (ROOT). A failed fetch is not fatal: the
 * review runs on the local origin/<branch> and says so.
 */
export async function prepareCode(ship: string, id: string, o: { repoOf?: (ship: string) => Promise<string | null>; git?: Git } = {}): Promise<Code> {
  const run = o.git ?? git;
  const repo = await (o.repoOf ?? repoOf)(ship);
  if (!repo || !existsSync(repo)) return { path: null, repo: null, sha: "", branch: "", note: `no code: ship ${ship} has no checkout on this host` };
  let note = "";
  const remote = await run(repo, ["ls-remote", "--symref", "origin", "HEAD"]);
  let branch = remote.code === 0 ? (remote.out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? "") : "";
  if (!branch) {
    const local = await run(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    branch = local.code === 0 ? local.out.replace(/^origin\//, "") : "main";
  }
  const fetched = await run(repo, ["fetch", "origin"]);
  if (fetched.code !== 0) note = `code may be stale: fetch failed (${(fetched.err || fetched.out || `exit ${fetched.code}`).split("\n")[0]!.slice(0, 160)})`;
  const path = join(surveysRoot(), id, "code");
  mkdirSync(join(surveysRoot(), id), { recursive: true });
  const added = await run(repo, ["worktree", "add", "--detach", path, `origin/${branch}`]);
  if (added.code !== 0) return { path: null, repo, sha: "", branch, note: `no code: the worktree at origin/${branch} failed (${added.err.split("\n")[0]!.slice(0, 160)})` };
  const sha = (await run(path, ["rev-parse", "HEAD"])).out;
  return { path, repo, sha, branch, note };
}

async function removeCode(repo: string | null, dir: string): Promise<void> {
  const path = join(dir, "code");
  if (!existsSync(path)) return;
  const removed = repo ? await git(repo, ["worktree", "remove", "--force", path]) : { code: 1 };
  if (removed.code !== 0) {
    rmSync(path, { recursive: true, force: true });
    if (repo) await git(repo, ["worktree", "prune"]);
  }
}

// ---------------------------------------------------------------- prompt and findings

const prompts = (...p: string[]) => join(ROOT, "prompts", "surveyors", ...p);
const withoutFrontmatter = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n/, "");

export type PromptParams = { mode: Mode; target: string; code: string | null; codeNote?: string; vault: string; root?: string };

/** The reviewer's system prompt: persona (or the brainstorm template with its lens), the standard, the parameter block, the output format. */
export function renderPrompt(lens: string, params: PromptParams): string {
  let persona: string;
  if ((BRAINSTORM_LENSES as readonly string[]).includes(lens)) {
    const [head, defs] = readFileSync(prompts("brainstorm.md"), "utf8").split("<!-- lenses -->");
    const def = (defs ?? "").split(/^## Lens: /m).find((s) => s.startsWith(`${lens}\n`))?.slice(lens.length).trim() ?? "";
    persona = head!.replace("{{lens}}", def);
  } else {
    persona = readFileSync(prompts(`${lens}.md`), "utf8");
  }
  const std = STANDARD[lens];
  const focus = lens === "readiness" ? "focus on the section headed `## Detailed implementation plan`; the rest of the file is context" : "the whole file";
  const code = params.code
    ? `${params.code} (the ship's code at origin's default branch; read-only)${params.codeNote ? `. Note: ${params.codeNote}` : ""}`
    : params.mode === "brainstorm"
      ? `the fleet repo at ${params.root ?? ROOT} (read-only); the vault is ${params.vault}`
      : `none${params.codeNote ? ` (${params.codeNote})` : ""}`;
  const block = [
    "# Parameters",
    "",
    `- Mode: ${params.mode}`,
    `- Target: ${params.target}`,
    `- Focus: ${focus}`,
    `- Code: ${code}`,
    `- Vault: ${params.vault} (read-only). Never open \`career/\` or \`profile/\` in it; the tool gate stops you.`,
  ].join("\n");
  return [
    withoutFrontmatter(persona).trim(),
    ...(std ? ["# Target Standard", withoutFrontmatter(readFileSync(prompts("standards", `${std}.md`), "utf8")).trim()] : []),
    block,
    readFileSync(prompts("output-format.md"), "utf8").trim(),
  ].join("\n\n---\n\n") + "\n";
}

const HEADING = /^###\s+(?:[^\w\s]+\s*)?(Blocker|Major|Nit)\s*:\s*(.*?)\s*$/i;

/**
 * The reviewer's findings: one per `### <Blocker|Major|Nit>: <scope>` heading. No heading but text
 * means one `Unparsed` finding with the whole text, never zero (unless the reviewer said `Findings: 0`).
 */
export function parseFindings(text: string): { findings: Finding[]; unparsed: boolean } {
  const findings: Finding[] = [];
  let cur: { severity: Severity; scope: string; lines: string[] } | null = null;
  const flush = () => {
    if (cur) findings.push({ severity: cur.severity, scope: cur.scope, body: cur.lines.join("\n").replace(/\n*Findings:\s*\d+\s*$/i, "").trim() });
  };
  for (const line of text.split("\n")) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      const sev = m[1]!.toLowerCase();
      cur = { severity: (sev.charAt(0).toUpperCase() + sev.slice(1)) as Severity, scope: m[2]!, lines: [] };
    } else cur?.lines.push(line);
  }
  flush();
  if (findings.length) return { findings, unparsed: false };
  const t = text.trim();
  if (!t || (/^Findings:\s*0\s*$/im.test(t) && t.length < 40)) return { findings: [], unparsed: false };
  return { findings: [{ severity: "Unparsed", scope: "the reviewer's whole report", body: `The report had no \`### <Blocker|Major|Nit>: <scope>\` headings, so it is kept whole.\n\n${t}` }], unparsed: true };
}

// ---------------------------------------------------------------- workflows

type Row = { lens: string; model: string | null; status: "queued" | "running" | "done" | "unparsed" | "not run"; cost: number; child?: string; tried: string[]; note?: string };
type Req = { by: "architect" | "captain"; mode: Mode; target: string; slug: string; ship: string; writer: string; depth: Depth; lenses: string[]; jev: string; depthBy: string };
type ParentData = Req & { rows: Row[]; dir: string; code: string | null; repo: string | null; sha: string; codeNote: string; started: string; review?: string; ids?: number[]; cost?: number; counts?: Record<string, number>; error?: string };
type ChildData = { parent: string; lens: string; model: string; dir: string; pid: number; attempt: number; started: string; cost?: number; findings?: Finding[]; unparsed?: boolean; error?: string };

const newId = () => `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** What the surveyors spent today (finished reviewers, failed attempts included). */
export function surveySpentToday(): number {
  return listWorkflows<ChildData>("survey-lens")
    .filter((w) => new Date(w.created).toLocaleDateString("sv") === today() && typeof w.data.cost === "number")
    .reduce((n, w) => n + (w.data.cost ?? 0), 0);
}

function patchRow(parent: string, lens: string, patch: Partial<Row>): void {
  const p = getWorkflow<ParentData>(parent);
  if (!p) return;
  updateWorkflow(parent, { data: { rows: p.data.rows.map((r) => (r.lens === lens ? { ...r, ...patch } : r)) } });
}

/** The vault-relative path of a note, or an error: inside the vault, a .md file, not career/ or profile/. */
function vaultTarget(path: string): { ok: true; rel: string; abs: string } | { ok: false; message: string } {
  const vault = aliceVault();
  const rel = path.startsWith("/") ? relative(vault, path) : path.replace(/^\.\//, "");
  if (!rel || rel.startsWith("..") || rel.split("/").includes("..")) return { ok: false, message: `${path} is not inside the vault (${vault}). Give a vault path, e.g. fleet/plans/feature/x.md.` };
  if (/^(career|profile)(\/|$)/.test(rel)) return { ok: false, message: "Surveyors never read career/ or profile/." };
  if (!rel.endsWith(".md")) return { ok: false, message: `${rel} is not a markdown note.` };
  const abs = join(vault, rel);
  if (!existsSync(abs)) return { ok: false, message: `${rel} does not exist in the vault. On the laptop, run bin/vault-sync first so the hub has the draft.` };
  return { ok: true, rel, abs };
}

/**
 * Ask for a review of a vault note. Jev picks the depth (the Architect may ask for more, never less; the
 * captain's depth is taken as given), triage.md records it, and the review starts or waits its turn.
 * Returns at once; the Architect is woken with `survey-done`, and a shell caller polls the workflow.
 */
export async function startReview(by: "architect" | "captain", req: { mode: string; path: string; ship?: string; writer?: string; depth?: string; lenses?: string }): Promise<Res> {
  if (req.mode !== "brainstorm" && req.mode !== "review") return { ok: false, message: 'mode is "brainstorm" (flesh out a raw idea or request) or "review" (check a draft).' };
  const mode: Mode = req.mode;
  if (req.depth && !(DEPTHS as string[]).includes(req.depth)) return { ok: false, message: `depth is one of ${DEPTHS.join(", ")}.` };
  const extra = (req.lenses ?? "").split(/[\s,]+/).filter(Boolean).map((l) => l.replace(/^\+/, ""));
  if (extra.some((l) => l !== "comprehension")) return { ok: false, message: 'lenses takes only "+comprehension".' };
  if (extra.length && mode !== "review") return { ok: false, message: "comprehension runs in review mode only." };
  const target = vaultTarget(req.path);
  if (!target.ok) return target;
  const writer = req.writer?.trim() || (by === "architect" ? architectWriter() : "");
  if (!writer) return { ok: false, message: by === "captain" ? "Give --writer: the model that wrote the note, so no reviewer shares it." : "The Architect's model is unknown (no model-running.json), so no reviewer can be kept off it." };
  const spent = surveySpentToday();
  if (budget() && spent >= budget()) {
    const message = `Surveyors have spent $${spent.toFixed(2)} today, at the $${budget()} limit. Ask the captain to raise FLEET_SURVEY_BUDGET_USD, or wait until tomorrow.`;
    recordOutcome(by, mode, target.rel, "failed", { error: message });
    return { ok: false, message };
  }

  const text = readFileSync(target.abs, "utf8");
  const slug = basename(target.rel, ".md");
  const ship = req.ship?.trim() || text.match(/^ship:\s*["']?([\w-]+)/m)?.[1] || "fleet";
  let depth: Depth;
  let jev: string;
  let depthBy: string;
  if (by === "captain" && req.depth) {
    depth = req.depth as Depth;
    jev = "not asked";
    depthBy = "captain";
  } else {
    const j = await surveyDepth(text, surveyHooks.ask ?? jevAsk);
    const asked = req.depth as Depth | undefined;
    const raised = asked !== undefined && rank(asked) > rank(j.depth);
    jev = j.jev;
    depth = raised ? asked : j.depth;
    depthBy = raised ? by : "jev";
  }
  writeTriage(slug, { depth, jev, by: depthBy, mode });
  if (depth === "skip") {
    recordOutcome(by, mode, target.rel, "done", { depth, jev, depthBy });
    return { ok: true, depth, message: `Depth is skip (${jev === "not asked" ? depthBy : `Jev: ${jev}`}): no surveyors run. The decision is recorded in fleet/reviews/${slug}/triage.md.` };
  }

  const id = newId();
  const lenses = lensesFor(mode, depth, extra);
  const running = listWorkflows("survey", "running");
  upsertWorkflow("survey", id, { by, mode, target: target.rel, slug, ship, writer, depth, lenses, jev, depthBy, rows: [], dir: join(surveysRoot(), id), code: null, repo: null, sha: "", codeNote: "", started: new Date().toISOString() } satisfies ParentData, { status: running.length ? "waiting" : "running", trace: `survey-${id}` });
  await dashLog("survey", `${by} → ${id} ${mode} ${depth} ${target.rel} (${lenses.join(", ")})`);
  if (running.length) return { ok: true, id, depth, message: `Depth is ${depth} (${jev}). Another review is running (${running[0]!.id}); ${id} waits for it, then runs ${lenses.length} surveyors.` };
  void begin(id);
  return { ok: true, id, depth, message: `Depth is ${depth} (${jev === "not asked" ? depthBy : `Jev: ${jev}`}). ${id} is running ${lenses.length} surveyors (${lenses.join(", ")}). You will be woken with the review file when they finish.` };
}

/** A review that never started (a skip, a budget refusal) is still on the node's record: reviewReady reads it. */
function recordOutcome(by: string, mode: Mode, target: string, status: "done" | "failed", data: Record<string, unknown>): void {
  upsertWorkflow("survey", newId(), { by, mode, target, ...data }, { status });
}

function writeTriage(slug: string, t: { depth: Depth; jev: string; by: string; mode: Mode }): void {
  const dir = join(aliceVault(), "fleet", "reviews", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.md"), `---\ntype: survey-triage\ndepth: ${t.depth}\njev: ${t.jev}\nby: ${t.by}\nat: ${new Date().toISOString()}\nmode: ${t.mode}\n---\n\nDepth ${t.depth} for the ${t.mode} of ${slug}, set by ${t.by}${t.jev === "not asked" ? "" : ` (Jev: ${t.jev})`}.\n`, "utf8");
}

/** Prepare code and models for a review that has the slot, create its reviewers, and start what the cap allows. */
async function begin(id: string): Promise<void> {
  try {
    const w = getWorkflow<ParentData>(id);
    if (!w || w.status !== "running") return;
    const d = w.data;
    const code = d.mode === "review" ? await (surveyHooks.prepareCode ?? prepareCode)(d.ship, id) : null;
    const roster = readModels();
    const assigned = assignModels(d.lenses, d.writer, roster, failedModels());
    const rows: Row[] = assigned.map((a) => ({ lens: a.lens, model: a.model, status: a.model ? "queued" : "not run", cost: 0, tried: a.model ? [a.model] : [], ...(a.model ? {} : { note: "no model left that is not the writer's, not in use, allowed and not failing today" }) }));
    for (const r of rows) if (r.model) r.child = createChild(id, r.lens, r.model, 1);
    updateWorkflow(id, { data: { rows, code: code?.path ?? null, repo: code?.repo ?? null, sha: code?.sha ?? "", codeNote: code?.note ?? "" } });
    await pump(id);
  } catch (e) {
    await failReview(id, e instanceof Error ? e.message : String(e));
  }
}

function createChild(parent: string, lens: string, model: string, attempt: number): string {
  const id = `${parent}-${lens}-${attempt}`;
  upsertWorkflow("survey-lens", id, { parent, lens, model, dir: join(surveysRoot(), parent, `${lens}-${attempt}`), pid: 0, attempt, started: new Date().toISOString() } satisfies ChildData, { status: "waiting", trace: `survey-${parent}` });
  return id;
}

/** Start waiting reviewers up to the fleet-wide cap; when none is left running or waiting, the review is finished. */
async function pump(parent: string): Promise<void> {
  const p = getWorkflow<ParentData>(parent);
  if (!p || p.status !== "running") return;
  const kids = listWorkflows<ChildData>("survey-lens").filter((c) => c.data.parent === parent);
  for (const c of kids.filter((k) => k.status === "waiting")) {
    // Re-read each time: another reviewer may have ended, or been started by a parallel pump, meanwhile.
    if (listWorkflows("survey-lens", "running").length >= maxReviewers()) break;
    if (getWorkflow(c.id)?.status === "waiting") await launch(p.data, c.id);
  }
  if (!listWorkflows<ChildData>("survey-lens").some((c) => c.data.parent === parent && (c.status === "waiting" || c.status === "running"))) await finishReview(parent);
}

async function launch(p: ParentData, childId: string): Promise<void> {
  const c = getWorkflow<ChildData>(childId)!;
  updateWorkflow(childId, { status: "running" }); // holds its place under the cap before any await
  patchRow(c.data.parent, c.data.lens, { status: "running", child: childId });
  try {
    mkdirSync(c.data.dir, { recursive: true });
    const system = join(c.data.dir, "prompt.md");
    writeFileSync(system, renderPrompt(c.data.lens, { mode: p.mode, target: join(aliceVault(), p.target), code: p.code, codeNote: p.codeNote, vault: aliceVault() }), "utf8");
    const { pid } = await startHelper({
      id: childId,
      dir: c.data.dir,
      agentId: "surveyor",
      kind: "survey-lens",
      task: `Review the target named in your parameters through your lens and report in the output format. Target: ${join(aliceVault(), p.target)}`,
      cwd: aliceVault(),
      model: c.data.model,
      prompts: [system],
      extensions: [join(ROOT, "extensions", "cache-watch.ts"), join(ROOT, "extensions", "tool-gate.ts")],
      minutes: minutes(),
      onFinish: (_kind, id) => finishLens(id),
      env: { ALICE_VAULT: aliceVault() },
      spawn: surveyHooks.spawn,
    });
    updateWorkflow(childId, { data: { pid } });
  } catch (e) {
    updateWorkflow(childId, { data: { error: e instanceof Error ? e.message : String(e) } });
    void finishLens(childId);
  }
}

/** A reviewer ended: record its findings or its failure (retried once on the next free candidate), then move the review on. */
export async function finishLens(id: string): Promise<void> {
  const c = getWorkflow<ChildData>(id);
  if (!c || c.kind !== "survey-lens" || c.status !== "running") return;
  await once(id, "finish", async () => {
    let raw = "";
    try {
      raw = readFileSync(join(c.data.dir, "out.jsonl"), "utf8");
    } catch {
      /* nothing written */
    }
    const { text, cost, error } = parseHelperOutput(raw);
    const failure = c.data.error || error || (text ? "" : "it ended without a report (timed out or stopped)");
    const p = getWorkflow<ParentData>(c.data.parent);
    const row = p?.data.rows.find((r) => r.lens === c.data.lens);
    if (!p || !row) {
      updateWorkflow(id, { status: "failed", data: { cost } });
      return;
    }
    const spent = row.cost + cost;
    if (!failure) {
      const parsed = parseFindings(text);
      writeFileSync(join(c.data.dir, "report.md"), `${text}\n`, "utf8");
      updateWorkflow(id, { status: "done", data: { cost, findings: parsed.findings, unparsed: parsed.unparsed } });
      patchRow(c.data.parent, c.data.lens, { status: parsed.unparsed ? "unparsed" : "done", cost: spent });
    } else {
      updateWorkflow(id, { status: "failed", data: { cost, error: failure } });
      markFailed(c.data.model);
      const others = p.data.rows.filter((r) => r.lens !== c.data.lens && r.model).map((r) => r.model!);
      const next = row.tried.length < 2 ? assignModels([c.data.lens], p.data.writer, readModels(), failedModels(), others)[0]?.model : null;
      if (next) {
        const child = createChild(c.data.parent, c.data.lens, next, c.data.attempt + 1);
        patchRow(c.data.parent, c.data.lens, { model: next, status: "queued", cost: spent, child, tried: [...row.tried, next] });
      } else {
        patchRow(c.data.parent, c.data.lens, { status: "not run", cost: spent, note: `${c.data.model} failed: ${failure.slice(0, 200)}; no other model to try` });
      }
    }
    await pump(c.data.parent);
  });
}

const ranRows = (p: ParentData) => p.rows.filter((r) => r.status === "done" || r.status === "unparsed");

/** Merge the reports into the review file, remove the code worktree, wake the Architect, start the next waiting review. */
export async function finishReview(id: string): Promise<void> {
  const w = getWorkflow<ParentData>(id);
  if (!w || w.status !== "running") return;
  await once(id, "finish", async () => {
    const d = w.data;
    const merged: (Finding & { lens: string; model: string })[] = [];
    for (const r of d.rows) {
      const kid = r.child ? getWorkflow<ChildData>(r.child) : null;
      if (r.status === "done" || r.status === "unparsed") for (const f of kid?.data.findings ?? []) merged.push({ ...f, lens: r.lens, model: r.model ?? "" });
    }
    merged.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
    const cost = Math.round(d.rows.reduce((n, r) => n + r.cost, 0) * 10000) / 10000;
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, merged.filter((f) => f.severity === s).length]));
    const ids = merged.map((_, i) => i + 1);
    const notRun = d.rows.filter((r) => r.status === "not run").map((r) => r.lens);
    const dir = join(aliceVault(), "fleet", "reviews", d.slug);
    mkdirSync(dir, { recursive: true });
    const prefix = d.mode === "review" ? "review" : "brainstorm";
    const n = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)\\.md$`))?.[1] ?? 0))) + 1;
    const rel = `fleet/reviews/${d.slug}/${prefix}-${n}.md`;
    const head = [
      "---",
      "type: survey",
      `target: ${d.target}`,
      `mode: ${d.mode}`,
      `depth: ${d.depth}`,
      `sha: ${d.sha || "none"}`,
      `writer: ${d.writer}`,
      `cost_usd: ${cost}`,
      "lenses:",
      ...d.rows.flatMap((r) => [`  - lens: ${r.lens}`, `    model: ${r.model ?? "none"}`, `    status: ${r.status}`, `    cost: ${Math.round(r.cost * 10000) / 10000}`]),
      "---",
      "",
      `# ${d.mode === "review" ? "Review" : "Brainstorm"} ${n} of ${d.slug}`,
      "",
      `Depth ${d.depth} (${d.depthBy}; Jev: ${d.jev}). Written by ${d.writer}; reviewed by models other than it.`,
      ...(d.codeNote ? ["", `Code: ${d.codeNote}.`] : d.sha ? ["", `Code: ${d.ship} at ${d.sha.slice(0, 10)}.`] : []),
      ...(notRun.length ? ["", `Not run: ${d.rows.filter((r) => r.status === "not run").map((r) => `${r.lens} (${r.note})`).join("; ")}.`] : []),
      "",
      "## Findings",
      "",
      ...(merged.length ? merged.flatMap((f, i) => [`### F${i + 1} — ${f.severity}: ${f.scope}`, `Lens: ${f.lens} (${f.model})`, "", f.body, ""]) : ["No findings.", ""]),
    ];
    writeFileSync(join(aliceVault(), rel), head.join("\n"), "utf8");
    const ran = ranRows(d).length;
    await removeCode(d.repo, d.dir);
    const summary = `${counts.Blocker} blockers, ${counts.Major} majors, ${counts.Nit} nits${counts.Unparsed ? `, ${counts.Unparsed} unparsed` : ""}; ${notRun.length ? `not run: ${notRun.join(", ")}` : "all lenses ran"}; $${cost.toFixed(2)}`;
    if (d.by === "architect") await postBus("architect", { from: "surveyor", kind: "survey-done", ref: rel, summary: `${d.mode === "review" ? "Review" : "Brainstorm"} of ${d.slug} (${d.depth}): ${summary}` });
    // Last, so a caller that sees the end of the workflow finds the file and the Architect's message in place.
    updateWorkflow(id, { status: ran ? "done" : "failed", data: { review: rel, ids, cost, counts, ...(ran ? {} : { error: "no surveyor ran" }) } });
    await dashLog("survey", `${id} ${ran ? "done" : "failed"} ${rel} ${summary}`);
    return { review: rel };
  });
  await startNext();
}

async function failReview(id: string, why: string): Promise<void> {
  const w = getWorkflow<ParentData>(id);
  if (!w || (w.status !== "running" && w.status !== "waiting")) return;
  updateWorkflow(id, { status: "failed", data: { error: why } });
  for (const c of listWorkflows<ChildData>("survey-lens").filter((x) => x.data.parent === id && (x.status === "waiting" || x.status === "running"))) updateWorkflow(c.id, { status: "cancelled" });
  await removeCode(w.data.repo, w.data.dir);
  if (w.data.by === "architect") await postBus("architect", { from: "surveyor", kind: "survey-failed", summary: `${w.data.mode} of ${w.data.slug} did not run: ${why}` });
  await dashLog("survey", `${id} failed: ${why}`);
  await startNext();
}

/** Start the oldest waiting review when none is running; a budget spent meanwhile refuses it. */
async function startNext(): Promise<void> {
  if (listWorkflows("survey", "running").length) return;
  const next = listWorkflows<ParentData>("survey", "waiting")[0];
  if (!next) return;
  const spent = surveySpentToday();
  if (budget() && spent >= budget()) {
    updateWorkflow(next.id, { status: "running" });
    return failReview(next.id, `surveyors have spent $${spent.toFixed(2)} today, at the $${budget()} limit`);
  }
  updateWorkflow(next.id, { status: "running" });
  void begin(next.id);
}

/** After a node restart: prune stale worktrees, re-attach reviewers still running, finish the ones that ended, start the next review. */
export async function recoverSurveys(): Promise<void> {
  const repos = new Set<string>(surveyHooks.repos ? await surveyHooks.repos() : [ROOT, ...(await readShips().catch(() => [])).map((s) => s.path)]);
  for (const repo of repos) if (existsSync(repo)) await git(repo, ["worktree", "prune"]).catch(() => null);
  for (const p of listWorkflows<ParentData>("survey", "running")) {
    if (!p.data.rows.length) {
      await failReview(p.id, "the node restarted while it was being prepared");
      continue;
    }
    for (const c of listWorkflows<ChildData>("survey-lens", "running").filter((x) => x.data.parent === p.id)) {
      if (c.data.pid && pidAlive(c.data.pid)) watchHelper("survey-lens", c.id, c.data.pid, minutes() * 60_000, (_kind, cid) => finishLens(cid));
      else await finishLens(c.id);
    }
    await pump(p.id);
  }
  await startNext();
}

// ---------------------------------------------------------------- resolution

export type ReviewCheck = { ok: boolean; message: string; ids: number[]; open: number[]; badDecline: number[] };

/**
 * Whether every finding of a review file (absolute path) has a resolution line under `## Resolution`
 * (lib/review-status.ts reads the ids). `decline` is only for Nits and Unparsed.
 */
export function reviewResolved(file: string): ReviewCheck {
  const st = reviewStatus(file);
  if (!st) return { ok: false, message: `No review file at ${file}.`, ids: [], open: [], badDecline: [] };
  const text = readFileSync(file, "utf8");
  const at = text.search(/^## Resolution\s*$/m);
  const severity = new Map([...(at < 0 ? text : text.slice(0, at)).matchAll(/^### F(\d+) — (Blocker|Major|Nit|Unparsed)\b/gm)].map((m) => [Number(m[1]), m[2]!] as const));
  const declined = at < 0 ? [] : text.slice(at).split("\n").map((l) => /^F(\d+): decline\b/.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  const badDecline = [...new Set(declined.filter((n) => severity.get(n) === "Blocker" || severity.get(n) === "Major"))];
  const open = st.open;
  const problems = [...(open.length ? [`no resolution for ${open.map((n) => `F${n}`).join(", ")}`] : []), ...(badDecline.length ? [`${badDecline.map((n) => `F${n}`).join(", ")} cannot be declined (decline is for Nits and Unparsed only)`] : [])];
  return { ok: !problems.length, message: problems.length ? `${problems.join("; ")}.` : `All ${st.ids.length} findings are resolved.`, ids: st.ids, open, badDecline };
}

// ---------------------------------------------------------------- the gate before the captain

export type ReviewSummary = { depth: string; counts: Record<string, number>; escalations: string[]; rel: string };
export type Ready = { ok: boolean; message: string; review?: ReviewSummary | null; unavailable?: string };

/** A vault path (absolute or relative) as a vault-relative one. */
function vaultRel(path: string): string {
  if (!path.startsWith("/")) return path.replace(/^vault\//, "").replace(/^\.\//, "");
  // A path that went through realpath (macOS /var → /private/var) is still the vault's.
  let rel = relative(aliceVault(), path);
  if (rel.startsWith("..")) {
    try {
      rel = relative(realpathSync(aliceVault()), path);
    } catch {
      /* keep the first answer */
    }
  }
  return rel;
}

/** The `review:` value in a note's frontmatter, or "". */
function reviewField(text: string): string {
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return /^review:[ \t]*["']?([^"'\n]*?)["']?[ \t]*$/m.exec(fm)?.[1]?.trim() ?? "";
}

/** The escalations of a review file: its `F<n>: escalate — <why>` lines. */
function escalations(text: string): string[] {
  const at = text.search(/^## Resolution\s*$/m);
  if (at < 0) return [];
  return text.slice(at).split("\n").flatMap((l) => {
    const m = /^(F\d+): escalate\s+(?:—|-)\s+(.+)$/.exec(l);
    return m ? [`${m[1]}: ${m[2]}`] : [];
  });
}

/**
 * Whether a note may reach the captain: its `review:` names a review file the node's own record says it wrote
 * (every finding resolved), or `skipped` / `unavailable` with a matching review-mode record. Files the Architect
 * can write never pass on their own.
 */
export function reviewReady(notePath: string): Ready {
  const rel = vaultRel(notePath);
  const abs = join(aliceVault(), rel);
  if (!rel || rel.startsWith("..") || !existsSync(abs)) return { ok: false, message: `No note at ${notePath} in the vault.` };
  const field = reviewField(readFileSync(abs, "utf8"));
  if (!field) return { ok: false, message: `${rel} has no \`review:\` in its frontmatter. Run survey mode=review, resolve the review, and set \`review:\` to the review file (or skipped / unavailable).` };
  const mine = listWorkflows<ParentData>("survey").filter((w) => w.data.target === rel && w.data.mode === "review");
  const latest = mine.at(-1);
  if (field === "skipped") {
    return latest?.status === "done" && latest.data.depth === "skip"
      ? { ok: true, message: "Review skipped (Jev: small and easy to undo).", review: null }
      : { ok: false, message: `review: skipped, but the node's latest review of ${rel} is not a skip. Run survey mode=review.` };
  }
  if (field === "unavailable") {
    return latest?.status === "failed"
      ? { ok: true, message: "Not reviewed.", review: null, unavailable: latest.data.error || "no surveyor ran" }
      : { ok: false, message: `review: unavailable, but the node's latest review of ${rel} did not fail. Run survey mode=review.` };
  }
  const file = vaultRel(field);
  const w = mine.find((x) => x.status === "done" && x.data.review === file);
  if (!w) return { ok: false, message: `review: ${field} is not a review the node wrote for ${rel}. Run survey mode=review and name the file it returns.` };
  const full = join(aliceVault(), file);
  const st = reviewStatus(full);
  if (!st) return { ok: false, message: `The review file ${file} is missing from the vault.` };
  const missing = (w.data.ids ?? []).filter((n) => !st.ids.includes(n));
  if (missing.length) return { ok: false, message: `${file} no longer has ${missing.map((n) => `F${n}`).join(", ")}, which the node counted. Do not delete findings; resolve them under ## Resolution.` };
  const r = reviewResolved(full);
  if (!r.ok) return { ok: false, message: `${file}: ${r.message}` };
  return { ok: true, message: r.message, review: { depth: w.data.depth, counts: w.data.counts ?? {}, escalations: escalations(readFileSync(full, "utf8")), rel: file } };
}
