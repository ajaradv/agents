import { jevAsk, type Answer } from "./jev.ts";
import { spawnTimed } from "./proc.ts";
import { redact } from "./redact.ts";

/**
 * Dock review (Level 3B in the vault research note jev-system-one): when a
 * voyage docks with commits, Jev scores the branch's diff and commit messages
 * on security risk, complexity, and commit quality, and says whether it needs
 * a careful look. Weights in code turn that into how closely the captain
 * should review before merging. Advisory: docking never waits on it.
 */

export type DockReview = { level: "light" | "normal" | "careful"; risk: number; security: number; complexity: number; commitQuality: number; needsReview: number; files: number; lines: string };

const WEIGHTS = { security: 0.5, complexity: 0.3, commitQuality: 0.2 };

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await spawnTimed(["git", ...args], { timeoutMs: 15_000, cwd });
  return r.exitCode === 0 ? r.stdout : "";
}

const score = (a: Answer | undefined) => (a && a.type === "score" ? a.score : 0);
const noul = (a: Answer | undefined) => (a && a.type === "noul" ? a.noul : 0);

/** Combine Jev's answers into a review level (numbers in code; scores run 0..3, commit quality inverted). */
export function reviewLevel(a: Record<string, Answer>): Pick<DockReview, "level" | "risk" | "security" | "complexity" | "commitQuality" | "needsReview"> {
  const security = score(a.security) / 3;
  const complexity = score(a.complexity) / 3;
  const commitQuality = score(a.commit_quality) / 3;
  const needsReview = noul(a.needs_review);
  const risk = WEIGHTS.security * security + WEIGHTS.complexity * complexity + WEIGHTS.commitQuality * (1 - commitQuality);
  const level = security >= 0.66 || risk >= 0.55 || needsReview >= 0.8 ? "careful" : risk >= 0.3 || needsReview >= 0.5 ? "normal" : "light";
  return { level, risk, security, complexity, commitQuality, needsReview };
}

export async function reviewBranch(repo: string, base: string, branch: string, ask: typeof jevAsk = jevAsk): Promise<DockReview | null> {
  const stat = await git(repo, ["diff", "--shortstat", `${base}...${branch}`]);
  if (!stat.trim()) return null;
  const files = await git(repo, ["diff", "--stat=120", `${base}...${branch}`]);
  const diff = await git(repo, ["diff", "--unified=2", `${base}...${branch}`]);
  const log = await git(repo, ["log", "--format=%s%n%b", `${base}..${branch}`]);
  const r = await ask(
    "dock-review",
    { files_changed: files.slice(-3000), commit_messages: log.slice(0, 2000), diff: redact(diff).slice(0, 30_000) },
    {
      security: { type: "score", instructions: "How much security risk does `diff` carry?", criteria: ["None: docs, styles, tests, or internal logic only", "Low: touches input handling or config with no sensitive effect", "Notable: auth, permissions, secrets handling, network calls, or user data", "High: weakens a security control, exposes data or secrets, or runs untrusted input"] },
      complexity: { type: "score", instructions: "How complex is the change in `diff` to review?", criteria: ["Trivial: a few lines in one place", "Small: one feature or fix, easy to follow", "Moderate: several files or a tricky change", "Large: many files, refactors, or subtle logic"] },
      commit_quality: { type: "score", instructions: "How well do `commit_messages` describe the change in `diff`?", criteria: ["Misleading or empty", "Vague", "Clear", "Clear and specific about what and why"] },
      needs_review: { type: "noul", instructions: "Does this change need a careful human review before it is merged, beyond a quick look?", criteria: { true: "Risky, surprising, hard to reverse, or easy to get subtly wrong", false: "Routine and low risk; a quick look is enough" } },
    },
  );
  if (!r.ok) return null;
  return { ...reviewLevel(r.answers), files: (files.trim().split("\n").length || 1) - 1, lines: stat.trim() };
}

export function reviewLine(d: DockReview): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const advice = { light: "a quick look is enough", normal: "review it as usual", careful: "review it carefully before merging" }[d.level];
  return `Dock review (Jev, advisory): ${d.level} — ${advice}. Security ${pct(d.security)}, complexity ${pct(d.complexity)}, commit messages ${pct(d.commitQuality)}; ${d.lines}.`;
}
