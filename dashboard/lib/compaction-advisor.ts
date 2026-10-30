import { jevAsk, type Answer, type Question } from "./jev.ts";
import { metricsDb } from "./metrics.ts";

/**
 * The compaction advisor (Level 7 in the vault research note jev-system-one;
 * questions after disler/ten-levels-of-jev, MIT). context-guard's percent lines
 * fire late on a large window (40% of 1M tokens is 400k), so after each settled
 * run it asks here whether the work has moved on: a new task, or a finished
 * unit that needs little of the history. Numbers stay in code; Jev judges.
 * Every verdict is logged with the context size, so the saving can be measured
 * before the advisor is switched from observe to on.
 */

export type AdviceState = { current_request: string; previous_work: string; recent_turn: string; tools_this_turn: string[] };

export const COMPACT_QUESTIONS: Record<string, Question> = {
  switched_gears: {
    type: "noul",
    instructions: "Is `current_request` a different task from `previous_work`?",
    criteria: { true: "A new feature, a different file area, a different goal, or an unrelated question", false: "The same task continuing, a follow up, a fix to what was just done" },
  },
  at_boundary: {
    type: "noul",
    instructions: "Did `recent_turn` finish a unit of work?",
    criteria: { true: "Tests passed, a commit was made, a summary was given, or a question was asked of the user", false: "Mid task, more steps clearly remain" },
  },
  needs_history: {
    type: "score",
    instructions: "How much of `previous_work` does the next step need?",
    criteria: ["None; the new work stands alone", "Some references, a file name or a decision", "Most of it; the work continues directly from it"],
  },
  mid_operation: {
    type: "noul",
    instructions: "Is the agent in the middle of a multi step edit whose partial state only exists in the conversation?",
    criteria: { true: "Half applied changes, a plan being executed step by step, an unfinished refactor", false: "A clean point, nothing half done" },
  },
};

export type Verdict = { movedOn: boolean; reason: string; switched: number; boundary: number; needsHistory: number; midOperation: number };

const num = (a: Answer | undefined, k: "noul" | "score") => (a && k in a ? Number((a as Record<string, unknown>)[k]) : 0);

/** The decision, thresholds in code (as in the ten-levels Level 7). */
export function judge(answers: Record<string, Answer>): Verdict {
  const switched = num(answers.switched_gears, "noul");
  const boundary = num(answers.at_boundary, "noul");
  const needsHistory = num(answers.needs_history, "score");
  const midOperation = num(answers.mid_operation, "noul");
  const base = { switched, boundary, needsHistory, midOperation };
  if (midOperation > 0.6) return { movedOn: false, reason: "mid operation", ...base };
  if (switched > 0.7) return { movedOn: true, reason: "the task changed", ...base };
  if (boundary > 0.6 && needsHistory < 1) return { movedOn: true, reason: "a unit of work finished and the next step needs little of the history", ...base };
  return { movedOn: false, reason: "same work continuing", ...base };
}

const LOG = `CREATE TABLE IF NOT EXISTS compaction_advice (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent TEXT NOT NULL, mode TEXT NOT NULL,
  tokens INTEGER NOT NULL, percent REAL NOT NULL, moved_on INTEGER NOT NULL, reason TEXT NOT NULL,
  switched REAL, boundary REAL, needs_history REAL, mid_operation REAL
);`;

/** Ask Jev whether the agent's work has moved on; log the verdict with the context size. */
export async function adviseCompaction(
  c: { agent: string; mode: string; tokens: number; percent: number; state: AdviceState },
  ask: typeof jevAsk = jevAsk,
): Promise<{ ok: boolean; verdict?: Verdict; error?: string }> {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const state = { current_request: clip(c.state.current_request, 600), previous_work: clip(c.state.previous_work, 1500), recent_turn: clip(c.state.recent_turn, 600), tools_this_turn: c.state.tools_this_turn.slice(0, 20) };
  const r = await ask("compaction", state, COMPACT_QUESTIONS);
  if (!r.ok) return { ok: false, error: r.error };
  const verdict = judge(r.answers);
  try {
    const d = metricsDb();
    d.exec(LOG);
    d.query("INSERT INTO compaction_advice (ts, agent, mode, tokens, percent, moved_on, reason, switched, boundary, needs_history, mid_operation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      new Date().toISOString(), c.agent, c.mode, Math.round(c.tokens), c.percent, verdict.movedOn ? 1 : 0, verdict.reason, verdict.switched, verdict.boundary, verdict.needsHistory, verdict.midOperation,
    );
  } catch (e) {
    console.error("[compaction] log:", e instanceof Error ? e.message : e);
  }
  return { ok: true, verdict };
}

/** Which earlier request starts the work that is still live: folded into the compaction instructions. */
export async function cutPoint(requests: string[], ask: typeof jevAsk = jevAsk): Promise<string | null> {
  if (requests.length < 2) return null;
  const criteria: Record<string, string> = {};
  requests.slice(-40).forEach((r, i) => (criteria[String(i)] = r.slice(0, 160)));
  criteria.none = "Every request is still live; keep the most recent context only";
  const r = await ask("compaction-cut", { turns: Object.entries(criteria).filter(([k]) => k !== "none").map(([k, v]) => ({ index: Number(k), request: v })) }, {
    live_from: { type: "choice", instructions: "Which turn in `turns` starts the work that is still live? Earlier turns can be summarized briefly.", criteria },
  });
  if (!r.ok) return null;
  const a = r.answers.live_from;
  if (!a || a.type !== "choice" || a.choice === "none" || a.confidence < 0.6) return null;
  const from = criteria[a.choice];
  return `The live work starts at the request "${from}". Summarize everything before it in a few lines. Keep the decisions, file paths, and open questions from that request onward in full detail.`;
}

/** Measurement: advice in the last `days` (the observe-mode report). */
export function compactionAdviceSummary(days = 7, window?: { from: string; to: string }): { agent: string; checks: number; movedOn: number; avgTokensWhenMovedOn: number }[] {
  try {
    const d = metricsDb();
    d.exec(LOG);
    const since = window?.from ?? new Date(Date.now() - days * 86_400_000).toISOString();
    return d
      .query("SELECT agent, COUNT(*) AS checks, SUM(moved_on) AS movedOn, CAST(COALESCE(AVG(CASE WHEN moved_on = 1 THEN tokens END), 0) AS INTEGER) AS avgTokensWhenMovedOn FROM compaction_advice WHERE ts >= ? AND ts < ? GROUP BY agent ORDER BY checks DESC")
      .all(since, window?.to ?? "9999") as ReturnType<typeof compactionAdviceSummary>;
  } catch {
    return [];
  }
}

/** Health: Jev spend per use, and what the compaction advisor would have done (observe) or did (on). */
export function jevHtml(esc: (s: string) => string, spend: { use: string; calls: number; failed: number; inputTokens: number; cost: number; avgMs: number }[]): string {
  const advice = compactionAdviceSummary(7);
  const total = spend.reduce((a, s) => a + s.cost, 0);
  const spendRows = spend.map((s) => `<tr><td>${esc(s.use)}</td><td>${s.calls}${s.failed ? ` <span class="warn">(${s.failed} failed)</span>` : ""}</td><td>${s.inputTokens.toLocaleString()}</td><td>$${s.cost.toFixed(5)}</td><td>${s.avgMs} ms</td></tr>`).join("");
  const adviceRows = advice.map((a) => `<tr><td>${esc(a.agent)}</td><td>${a.checks}</td><td>${a.movedOn}</td><td>${a.movedOn ? `${Math.round(a.avgTokensWhenMovedOn / 1000)}k` : "-"}</td></tr>`).join("");
  if (!spend.length && !advice.length) return `<details class="fold"><summary>Jev · no calls in 7 days</summary><p class="muted">Jev (TypeSafe's decision model) answers the tool gate, the result screen, and the compaction advisor. Its calls and their cost show here.</p></details>`;
  return `<details class="fold"><summary>Jev · ${spend.reduce((a, s) => a + s.calls, 0)} calls, $${total.toFixed(4)} in 7 days</summary>
    ${spendRows ? `<table class="spend-table"><thead><tr><th>Use</th><th>Calls</th><th>Input tokens</th><th>Cost</th><th>Avg</th></tr></thead><tbody>${spendRows}</tbody></table>` : ""}
    ${adviceRows ? `<h3>Compaction advisor</h3><table class="spend-table"><thead><tr><th>Agent</th><th>Checks</th><th>Moved on</th><th>Context then</th></tr></thead><tbody>${adviceRows}</tbody></table><p class="muted">"Moved on" means Jev judged the work had switched task or finished a unit needing little history. In observe mode nothing was compacted; the context size then is what a compaction would have cut from every later step.</p>` : ""}
  </details>`;
}
