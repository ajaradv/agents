import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { factGet } from "./facts.ts";
import { jevAsk, type Question } from "./jev.ts";
import { journalDb } from "./journal.ts";
import { dashLog } from "./log.ts";
import { aliceVault, fleetInboxRoot } from "./paths.ts";
import { redact } from "./redact.ts";
import { PROFILE } from "./remember.ts";

/**
 * Memory extraction (vault plan alice-memory-and-tools, M4), observe mode: Jev
 * reads the captain's own chat messages, labels the ones that carry something
 * worth remembering (a standing preference, a changing fact, a decision, a
 * correction), and, for preferences and facts, says which current captain.md
 * bullet or fact the new statement would replace. Every proposal goes into
 * journal.db (memory_proposals) with the quote; nothing is written to
 * captain.md or the facts. The captain labels the right class later
 * (bin/fleet-axi extract label), which measures the confidence floors.
 * FLEET_MEMORY_EXTRACT=off turns it off; FLEET_MEMORY_EXTRACT_FLOOR (default
 * 0.5) is the confidence below which a preference or fact is not matched
 * against existing memory.
 */

export const LABELS = ["preference", "fact", "decision", "correction", "task", "none"] as const;
export type MemoryLabel = (typeof LABELS)[number];

const CRITERIA: Record<MemoryLabel, string> = {
  preference: "A standing preference or instruction: how the captain wants things done from now on, not tied to one task",
  fact: "A changing exact value: a host, model, owner, date, version, or spec the fleet should look up later",
  decision: "A decision about the fleet or a project: what will be built, kept, dropped, or how it will be done",
  correction: "Corrects an agent: says it did something wrong or misunderstood",
  task: "A task request or a status about one task: do this now, or how a piece of work stands",
  none: "Chit-chat, a question, thanks, or anything none of the others fit",
};

export const extractMode = (): "observe" | "off" => (process.env.FLEET_MEMORY_EXTRACT === "off" ? "off" : "observe");
export const floor = (): number => {
  const n = Number(process.env.FLEET_MEMORY_EXTRACT_FLOOR);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
};

const BATCH = 5;
const MAX_QUOTE = 600;
const MIN_CHARS = 12;
const MAX_NOUL = 10;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type Candidate = { agent: string; line_ts: string; text: string };

/**
 * The captain's own words only. Skipped: lines that are not captain chat; Claude Code's messages relayed
 * into a thread ("(From Claude Code..." or the older "(Claude Code) ..."); anything under 12 characters ("yes", "ok", "go ahead");
 * and a bare question (one sentence ending in "?"), which asks for something and states nothing.
 */
export function isCandidate(l: { from?: unknown; kind?: unknown; text?: unknown }): boolean {
  if (l.from !== "captain" || l.kind !== "chat" || typeof l.text !== "string") return false;
  const t = l.text.trim();
  if (t.length < MIN_CHARS || /^\((From )?Claude Code\b/.test(t)) return false;
  if (t.endsWith("?") && !/[.!\n]/.test(t.slice(0, -1))) return false;
  return true;
}

/** Candidates from every agent's captain-chat.jsonl (or one agent's), oldest first, not yet proposed. */
export function candidates(opts: { agent?: string; since?: string } = {}): Candidate[] {
  const root = fleetInboxRoot();
  let agents: string[] = [];
  try {
    agents = opts.agent ? [opts.agent] : readdirSync(root).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
  const done = new Set((journalDb().query("SELECT agent, line_ts FROM memory_proposals").all() as { agent: string; line_ts: string }[]).map((r) => `${r.agent}|${r.line_ts}`));
  const out: Candidate[] = [];
  for (const agent of agents) {
    const file = join(root, agent, "captain-chat.jsonl");
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let l: { ts?: string; from?: string; kind?: string; text?: string };
      try {
        l = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof l.ts !== "string" || !isCandidate(l) || (opts.since && l.ts < opts.since) || done.has(`${agent}|${l.ts}`)) continue;
      out.push({ agent, line_ts: l.ts, text: clip(redact(l.text!.trim()), MAX_QUOTE) });
    }
  }
  return out.sort((a, b) => a.line_ts.localeCompare(b.line_ts));
}

/** The `## ` sections of the captain profile with their bullets; empty when the file is missing. */
export function profileSections(vault = aliceVault()): { name: string; bullets: string[] }[] {
  const file = join(vault, PROFILE);
  if (!existsSync(file)) return [];
  const out: { name: string; bullets: string[] }[] = [];
  for (const l of readFileSync(file, "utf8").split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) out.push({ name: h[1]!, bullets: [] });
    else if (/^#\s/.test(l)) out.push({ name: "", bullets: [] });
    else if (l.startsWith("- ") && out.length && out[out.length - 1]!.name) out[out.length - 1]!.bullets.push(l.slice(2).trim());
  }
  return out.filter((s) => s.name);
}

type Ask = typeof jevAsk;
export type Proposal = { agent: string; line_ts: string; quote: string; label: MemoryLabel; confidence: number; target: string | null; replaces: string | null; replace_p: number | null };

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** Current facts whose subject or key shares a word with the statement, best overlap first, at most MAX_NOUL. */
function likelyFacts(text: string): { id: number; subject: string; key: string; value: string }[] {
  const r = factGet({ limit: 200 }) as { facts?: { id: number; subject: string; key: string; value: string }[] };
  const w = words(text);
  return (r.facts ?? [])
    .map((f) => ({ f, n: [...words(`${f.subject} ${f.key}`.replace(/[._-]/g, " "))].filter((x) => w.has(x)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_NOUL)
    .map((x) => x.f);
}

/** The strongest "yes, it replaces this" among noul answers, null when Jev did not answer or none reached 0.5. */
async function bestReplace(ask: Ask, text: string, items: { label: string; id: string }[], what: string, calls: { n: number }): Promise<{ id: string; p: number } | null> {
  if (!items.length) return null;
  const questions: Record<string, Question> = {};
  items.forEach((it, i) => {
    questions[`r${i}`] = { type: "noul", instructions: `The captain's new statement is \`statement\`. This ${what} is: ${JSON.stringify(it.label)}. Does the new statement replace it (the same thing, now said differently or changed)?` };
  });
  calls.n++;
  const r = await ask("memory-extract", { statement: text }, questions);
  if (!r.ok) return null;
  let best: { id: string; p: number } | null = null;
  items.forEach((it, i) => {
    const a = r.answers[`r${i}`];
    if (a?.type === "noul" && (!best || a.noul > best.p)) best = { id: it.id, p: a.noul };
  });
  return best;
}

/** Where a preference would go and which bullet it replaces: a section choice (one call), then a noul per bullet in it (at most 10). */
async function matchPreference(ask: Ask, text: string, calls: { n: number }): Promise<Pick<Proposal, "target" | "replaces" | "replace_p">> {
  const sections = profileSections();
  const none = { target: null, replaces: null, replace_p: null };
  if (!sections.length) return none;
  let section = sections[0]!;
  if (sections.length > 1) {
    const criteria: Record<string, string> = {};
    for (const s of sections) criteria[s.name] = s.bullets.length ? `Like: ${clip(s.bullets.slice(0, 2).join(" / "), 160)}` : "Nothing in it yet";
    calls.n++;
    const r = await ask("memory-extract", { statement: text }, { section: { type: "choice", instructions: "Which section of the captain's profile does `statement` belong in?", criteria } });
    const a = r.ok ? r.answers.section : undefined;
    if (a?.type === "choice") section = sections.find((s) => s.name === a.choice) ?? section;
    else return none;
  }
  const target = `captain.md#${section.name}`;
  const best = await bestReplace(ask, text, section.bullets.slice(0, MAX_NOUL).map((b) => ({ label: b, id: b })), "bullet of the captain's profile", calls);
  return { target, replaces: best && best.p >= 0.5 ? best.id : null, replace_p: best ? best.p : null };
}

/** Which current fact a statement would change: a noul per plausibly matching fact (at most 10). */
async function matchFact(ask: Ask, text: string, calls: { n: number }): Promise<Pick<Proposal, "target" | "replaces" | "replace_p">> {
  const facts = likelyFacts(text);
  const best = await bestReplace(ask, text, facts.map((f) => ({ label: `${f.subject}.${f.key} = ${f.value}`, id: String(f.id) })), "recorded fact", calls);
  const hit = best && best.p >= 0.5 ? facts.find((f) => String(f.id) === best.id) : undefined;
  return { target: hit ? `fact:${hit.subject}.${hit.key}` : null, replaces: hit ? String(hit.id) : null, replace_p: best ? best.p : null };
}

function store(p: Proposal): boolean {
  const r = journalDb()
    .query("INSERT OR IGNORE INTO memory_proposals (ts, agent, line_ts, quote, label, confidence, target, replaces, replace_p, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed')")
    .run(new Date().toISOString(), p.agent, p.line_ts, p.quote, p.label, p.confidence, p.target, p.replaces, p.replace_p);
  return r.changes > 0;
}

export type ExtractRun = { candidates: number; proposed: number; matched: number; calls: number; failed: number; byLabel: Record<string, number> };

/** Classify candidates in batches of five (one Jev call, a choice question per message), match preferences and facts against memory, store the proposals. Never throws. */
export async function extract(list: Candidate[], ask: Ask = jevAsk): Promise<ExtractRun> {
  const run: ExtractRun = { candidates: list.length, proposed: 0, matched: 0, calls: 0, failed: 0, byLabel: {} };
  const calls = { n: 0 };
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const messages: Record<string, string> = {};
    const questions: Record<string, Question> = {};
    batch.forEach((c, k) => {
      messages[`m${k}`] = c.text;
      questions[`m${k}`] = { type: "choice", instructions: `What does the captain's message messages.m${k} carry for the fleet's memory?`, criteria: CRITERIA };
    });
    calls.n++;
    try {
      const r = await ask("memory-extract", { messages }, questions);
      if (!r.ok) {
        run.failed += batch.length;
        void dashLog("memory-extract", `no verdict: ${r.error}`);
        continue;
      }
      for (const [k, c] of batch.entries()) {
        const a = r.answers[`m${k}`];
        if (!a || a.type !== "choice" || !(LABELS as readonly string[]).includes(a.choice)) {
          run.failed++;
          continue;
        }
        const label = a.choice as MemoryLabel;
        let m: Pick<Proposal, "target" | "replaces" | "replace_p"> = { target: null, replaces: null, replace_p: null };
        if (a.confidence >= floor()) {
          if (label === "preference") m = await matchPreference(ask, c.text, calls);
          else if (label === "fact") m = await matchFact(ask, c.text, calls);
        }
        if (store({ agent: c.agent, line_ts: c.line_ts, quote: c.text, label, confidence: a.confidence, ...m })) {
          run.proposed++;
          run.byLabel[label] = (run.byLabel[label] ?? 0) + 1;
          if (m.replaces) run.matched++;
        }
      }
    } catch (e) {
      run.failed += batch.length;
      console.error("[memory-extract]", e instanceof Error ? e.message : e);
    }
  }
  run.calls = calls.n;
  return run;
}

/** The ongoing pass (every few minutes on the node): captain lines newer than the last proposal, at most 20 a pass. */
export async function extractNew(ask: Ask = jevAsk): Promise<ExtractRun | null> {
  if (extractMode() === "off") return null;
  try {
    const last = (journalDb().query("SELECT MAX(line_ts) AS t FROM memory_proposals").get() as { t: string | null }).t;
    const since = last ?? new Date(Date.now() - 86_400_000).toISOString();
    const list = candidates({ since }).slice(0, 20);
    return list.length ? await extract(list, ask) : null;
  } catch (e) {
    console.error("[memory-extract]", e instanceof Error ? e.message : e);
    return null;
  }
}

export function startMemoryExtract(): void {
  setInterval(() => void extractNew(), 5 * 60_000);
}

export type ProposalRow = { id: number; ts: string; agent: string; line_ts: string; quote: string; label: string; confidence: number; target: string | null; replaces: string | null; replace_p: number | null; status: string; captain_label: string | null; captain_target: string | null; labelled_at: string | null };

/** Confidence buckets, as in the intent report. */
export const BUCKETS = [
  { name: "<0.6", min: 0, max: 0.6 },
  { name: "0.6-0.8", min: 0.6, max: 0.8 },
  { name: "0.8-0.9", min: 0.8, max: 0.9 },
  { name: ">=0.9", min: 0.9, max: 1.01 },
] as const;

export type ProposalReport = {
  total: number;
  rows: ProposalRow[];
  perLabel: Record<string, number>;
  buckets: { bucket: string; count: number; labelled: number; right: number; accuracy: number | null }[];
};

/** Recent proposals and the summary: per label, per confidence bucket, accuracy over the captain-labelled rows. */
export function proposalReport(opts: { days?: number; unlabelledOnly?: boolean; limit?: number } = {}): ProposalReport {
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000).toISOString();
  const all = journalDb().query("SELECT * FROM memory_proposals WHERE ts >= ? ORDER BY id DESC").all(since) as ProposalRow[];
  const perLabel: Record<string, number> = {};
  for (const r of all) perLabel[r.label] = (perLabel[r.label] ?? 0) + 1;
  const buckets = BUCKETS.map((b) => {
    const inB = all.filter((r) => r.confidence >= b.min && r.confidence < b.max);
    const lab = inB.filter((r) => r.captain_label !== null);
    const right = lab.filter((r) => r.captain_label === r.label).length;
    return { bucket: b.name, count: inB.length, labelled: lab.length, right, accuracy: lab.length ? Math.round((right / lab.length) * 100) / 100 : null };
  });
  const shown = opts.unlabelledOnly ? all.filter((r) => r.captain_label === null) : all;
  return { total: all.length, rows: shown.slice(0, opts.limit ?? 30), perLabel, buckets };
}

/** The captain's label: the right class (one of LABELS), and optionally the right target. */
export function labelProposal(id: number, label: string, target?: string): { ok: boolean; message: string } {
  if (!(LABELS as readonly string[]).includes(label)) return { ok: false, message: `${label} is not a label; options: ${LABELS.join(", ")}` };
  const r = journalDb().query("UPDATE memory_proposals SET captain_label = ?, captain_target = ?, labelled_at = ? WHERE id = ?").run(label, target ?? null, new Date().toISOString(), id);
  return r.changes ? { ok: true, message: `proposal ${id} labelled ${label}` } : { ok: false, message: `no proposal with id ${id}` };
}
