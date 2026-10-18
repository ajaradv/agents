import { jevAsk, type Question } from "./jev.ts";
import { redact } from "./redact.ts";

/**
 * Cheap reads (an experiment; vault research note jev-system-one, Levels 8-9):
 * one question about each file, one Jev call per file in parallel. The answers
 * go back to the agent instead of the files; each call is logged as use
 * cheap-reads, and its input tokens are the tokens kept out of the agent's context.
 */
export async function askAboutFiles(
  question: Record<string, unknown>,
  files: { path: string; content: string }[],
  ask: typeof jevAsk = jevAsk,
): Promise<{ results: { path: string; answer: string; p: number | null; error?: string }[] }> {
  const q = question as Question;
  if (!["noul", "choice", "score"].includes(String(q?.type)) || !q.instructions) return { results: files.map((f) => ({ path: f.path, answer: "", p: null, error: "bad question" })) };
  const results = await Promise.all(
    files.slice(0, 40).map(async (f) => {
      const r = await ask("cheap-reads", { path: f.path, file: redact(f.content).slice(0, 60_000) }, { q });
      if (!r.ok) return { path: f.path, answer: "", p: null, error: r.error };
      const a = r.answers.q;
      if (!a) return { path: f.path, answer: "", p: null, error: "no answer" };
      if (a.type === "noul") return { path: f.path, answer: a.noul >= 0.5 ? "yes" : "no", p: a.noul };
      if (a.type === "choice") return { path: f.path, answer: a.choice, p: a.probabilities[a.choice] ?? a.confidence };
      const levels = (q as { criteria?: string[] }).criteria ?? [];
      return { path: f.path, answer: levels[Math.round(a.score)] ?? String(a.score), p: a.confidence };
    }),
  );
  return { results };
}
