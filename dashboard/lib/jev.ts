import { createHash } from "node:crypto";
import { agentKeyEnv } from "./fleet-env.ts";
import { metricsDb } from "./metrics.ts";

/**
 * The fleet's Jev client (vault research note jev-system-one; guideline
 * docs/system-one.md). Jev (TypeSafe's System One model) answers typed questions
 * about a state with probabilities: noul (yes/no), choice (one of your options),
 * score (a position on levels you describe). Every fleet use goes through here:
 *
 * - TypeSafe's API first, OpenRouter's `~typesafe/jev-latest` when it fails;
 * - a 5 s timeout per route;
 * - identical requests cached for 5 minutes;
 * - every call logged (use, route, input tokens, cost, latency) in the metrics
 *   database, so spend per use can be read back (`jevSpend`).
 *
 * Pricing measured 2026-10-18: $0.042 per million input tokens, output free.
 * Callers redact secrets before sending (tool-gate.ts `redact`).
 */

export type State = string | Record<string, unknown> | unknown[];
export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  /** Levels low to high, 2 to 10 of them. */
  | { type: "score"; instructions: string; criteria: string[] };
export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number; legend?: Record<string, string> };

export type JevResult =
  | { ok: true; answers: Record<string, Answer>; route: "typesafe" | "openrouter" | "cache"; inputTokens: number; cost: number; ms: number }
  | { ok: false; error: string };

export const JEV_INPUT_PRICE_PER_M = 0.042;
const TIMEOUT_MS = 5000;
const CACHE_MS = 5 * 60_000;

const LOG = `CREATE TABLE IF NOT EXISTS jev_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, use TEXT NOT NULL, route TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
); CREATE INDEX IF NOT EXISTS jev_calls_ts ON jev_calls(ts);`;

const cache = new Map<string, { at: number; answers: Record<string, Answer> }>();
// Kept once read: the 1Password environment can stop answering mid-session.
const keys: { typesafe: string; openrouter: string } = { typesafe: "", openrouter: "" };
let keysFixed = false;

async function loadKeys(): Promise<void> {
  if (keysFixed || (keys.typesafe && keys.openrouter)) return;
  const k = await agentKeyEnv();
  keys.typesafe ||= process.env.TYPESAFE_API_KEY || k.TYPESAFE_API_KEY || "";
  keys.openrouter ||= process.env.OPENROUTER_API_KEY || k.OPENROUTER_API_KEY || "";
}

function record(use: string, route: string, inputTokens: number, cost: number, ms: number, error = ""): void {
  try {
    const d = metricsDb();
    d.exec(LOG);
    d.query("INSERT INTO jev_calls (ts, use, route, input_tokens, cost, ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(new Date().toISOString(), use, route, inputTokens, cost, ms, error ? 0 : 1, error.slice(0, 200));
  } catch (e) {
    console.error("[jev] log:", e instanceof Error ? e.message : e);
  }
}

type Route = { name: "typesafe" | "openrouter"; url: string; model: string; key: () => string };
const ROUTES: Route[] = [
  { name: "typesafe", url: `${process.env.TYPESAFE_BASE ?? "https://api.typesafe.ai"}/v1/systemone`, model: "jev-latest", key: () => keys.typesafe },
  { name: "openrouter", url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", key: () => keys.openrouter },
];

/** Ask Jev. `use` names the fleet use (tool-gate, compaction, triage, ...) for the spend log. */
export async function jevAsk(use: string, state: State, questions: Record<string, Question>, opts: { fetchImpl?: typeof fetch } = {}): Promise<JevResult> {
  const id = createHash("sha256").update(JSON.stringify([state, questions])).digest("hex");
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, answers: hit.answers, route: "cache", inputTokens: 0, cost: 0, ms: 0 };
  // Safety net: under bun test, never reach the real service unless a test set fake keys and a fetch.
  if (process.env.NODE_ENV === "test" && !(keysFixed && opts.fetchImpl)) return { ok: false, error: "Jev is not called in tests" };
  await loadKeys();
  const doFetch = opts.fetchImpl ?? fetch;
  const errors: string[] = [];
  for (const r of ROUTES) {
    const key = r.key();
    if (!key) {
      errors.push(`${r.name}: no key`);
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await doFetch(r.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: r.model, state, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      if (!res.ok) {
        const why = `${r.name}: HTTP ${res.status}`;
        errors.push(why);
        record(use, r.name, 0, 0, ms, why);
        continue;
      }
      const j = (await res.json()) as { answers?: Record<string, Answer>; usage?: { input_tokens?: number; cost?: number } };
      if (!j.answers || Object.keys(questions).some((q) => !j.answers![q])) {
        const why = `${r.name}: answer missing questions`;
        errors.push(why);
        record(use, r.name, 0, 0, ms, why);
        continue;
      }
      const inputTokens = Number(j.usage?.input_tokens ?? 0);
      const cost = typeof j.usage?.cost === "number" ? j.usage.cost : (inputTokens * JEV_INPUT_PRICE_PER_M) / 1e6;
      record(use, r.name, inputTokens, cost, ms);
      cache.set(id, { at: Date.now(), answers: j.answers });
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return { ok: true, answers: j.answers, route: r.name, inputTokens, cost, ms };
    } catch (e) {
      const why = `${r.name}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(why);
      record(use, r.name, 0, 0, Date.now() - t0, why);
    }
  }
  return { ok: false, error: `Jev did not answer (${errors.join("; ") || "no route"})` };
}

/** Spend per use over the last `days` (the cost calculator's Jev side). */
export function jevSpend(days = 7): { use: string; calls: number; failed: number; inputTokens: number; cost: number; avgMs: number }[] {
  try {
    const d = metricsDb();
    d.exec(LOG);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return d
      .query("SELECT use, COUNT(*) AS calls, SUM(1 - ok) AS failed, SUM(input_tokens) AS inputTokens, SUM(cost) AS cost, CAST(AVG(ms) AS INTEGER) AS avgMs FROM jev_calls WHERE ts >= ? GROUP BY use ORDER BY cost DESC")
      .all(since) as ReturnType<typeof jevSpend>;
  } catch {
    return [];
  }
}

/** Test seam: forget cached answers and use exactly these keys (never the real ones). */
export function resetJevForTests(k: Partial<typeof keys> = {}): void {
  cache.clear();
  keysFixed = true;
  keys.typesafe = k.typesafe ?? "";
  keys.openrouter = k.openrouter ?? "";
}
