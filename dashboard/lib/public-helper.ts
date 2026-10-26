import { freeComplete } from "./free-models.ts";
import { recordTurn } from "./metrics.ts";
import { logShipEvent } from "./ship-log.ts";
import { OFFICER_SHIP } from "./ship-events.ts";

/**
 * The public helper (vault research note free-model-lanes): an officer asks a
 * question, optionally with text it supplies, and gets an answer from a free
 * model, with no tools and no file access. For general knowledge, drafting,
 * rewording, and summarising text that is already public. It runs on the free
 * lanes (lib/free-models), which may train on what they are sent, so the node
 * refuses text that looks private; the officer is responsible for the rest.
 */

const MAX_CHARS = 12_000;

const SYSTEM =
  "You are a concise assistant answering a question from an agent in a software fleet. You have no tools and no access to files, repositories, or the internet: answer from general knowledge and from the text given. If the question needs information you do not have, say so in one line rather than guessing. Plain prose, no preamble.";

/** Why text must not go to a free model, or null when it looks fine. Defence in depth, not a guarantee. */
export function sensitiveReason(text: string): string | null {
  if (text.length > MAX_CHARS) return `it is ${text.length} characters (limit ${MAX_CHARS}); long pastes are usually repo or vault content`;
  const checks: [RegExp, string][] = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "it contains a private key"],
    [/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{20,}/, "it contains something that looks like an API key"],
    [/\b(ghp|gho|github_pat|xox[abp]|AIza)[A-Za-z0-9_-]{16,}/, "it contains something that looks like a token"],
    [/\b[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S{6,}/, "it contains a credential assignment"],
    [/\/(Users|home)\/[a-z0-9._-]+\//i, "it contains a local file path (repo or vault content stays private)"],
    [/op:\/\/[^\s]+/, "it contains a 1Password reference"],
  ];
  for (const [re, why] of checks) if (re.test(text)) return why;
  return null;
}

export function publicPrompt(question: string, context: string): string {
  return context.trim() ? `${question.trim()}\n\n--- Text supplied with the question ---\n${context.trim()}` : question.trim();
}

/** Ask the public helper; answers in one call (free models first, a paid fallback last). */
export async function askPublic(from: string, question: string, context = ""): Promise<{ ok: boolean; message: string; model?: string; free?: boolean }> {
  const q = question.trim();
  if (q.length < 3) return { ok: false, message: "Ask a question." };
  const why = sensitiveReason(`${q}\n${context}`);
  if (why) {
    logShipEvent(OFFICER_SHIP, from, "notice", `Public helper refused a request: ${why}`);
    return { ok: false, message: `Not sent: ${why}. The public helper uses free models that may train on what they get; send only public or general text. Use delegate for anything that needs the vault or a repo.` };
  }
  const r = await freeComplete(publicPrompt(q, context), { purpose: `public:${from}`, system: SYSTEM, maxTokens: 1200, attempts: 3, attemptMs: 25_000 });
  recordTurn({ agent: `${from}-public`, model: r.model, ok: r.ok, ms: r.ms, cost: r.cost, ...(r.ok ? {} : { error: r.error ?? "" }) });
  logShipEvent(OFFICER_SHIP, from, "delegation", `Public helper ${r.ok ? "answered" : "failed"} (${r.model || "no model"}${r.free ? ", free" : `, paid $${r.cost.toFixed(4)}`}): ${q.slice(0, 140)}`, { model: r.model, free: r.free, tried: r.tried, cost: r.cost });
  if (!r.ok) return { ok: false, message: `The public helper could not answer (${r.error ?? "unknown error"}; tried ${r.tried.join(", ") || "nothing"}).` };
  return { ok: true, message: `${r.text.trim()}\n\n(public helper: ${r.model}${r.free ? ", free" : `, paid fallback $${r.cost.toFixed(4)}`})`, model: r.model, free: r.free };
}
