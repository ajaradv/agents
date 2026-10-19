import { describe, expect, test } from "bun:test";
import { askAboutFiles } from "./cheap-reads.ts";

describe("cheap reads", () => {
  test("one Jev call per file; answers in words with a probability; secrets redacted before sending", async () => {
    const sent: unknown[] = [];
    const ask = (async (_use: string, state: Record<string, unknown>) => {
      sent.push(state);
      const yes = String(state.file).includes("verify(");
      return { ok: true, answers: { q: { type: "noul", noul: yes ? 0.95 : 0.1 } }, route: "typesafe", inputTokens: 100, cost: 0, ms: 1 };
    }) as never;
    const r = await askAboutFiles({ type: "noul", instructions: "Does it validate tokens?" }, [
      { path: "auth.ts", content: "export function check(t) { return verify(t); }" },
      { path: "seed.ts", content: "const OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv;" },
    ], ask);
    expect(r.results).toEqual([{ path: "auth.ts", answer: "yes", p: 0.95 }, { path: "seed.ts", answer: "no", p: 0.1 }]);
    expect(JSON.stringify(sent)).not.toContain("sk-proj-abcdefghijklmnopqrstuv");
  });
  test("choice and score answers come back as the option or level; a bad question answers nothing", async () => {
    const choice = (async () => ({ ok: true, answers: { q: { type: "choice", choice: "billing", confidence: 0.8, probabilities: { billing: 0.85 } } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 })) as never;
    expect((await askAboutFiles({ type: "choice", instructions: "Which area?", criteria: { billing: null, web: null } }, [{ path: "a.ts", content: "x" }], choice)).results[0]).toEqual({ path: "a.ts", answer: "billing", p: 0.85 });
    const score = (async () => ({ ok: true, answers: { q: { type: "score", score: 1.8, confidence: 0.7, probabilities: {} } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 })) as never;
    expect((await askAboutFiles({ type: "score", instructions: "How risky?", criteria: ["low", "medium", "high"] }, [{ path: "a.ts", content: "x" }], score)).results[0]!.answer).toBe("high");
    expect((await askAboutFiles({ type: "essay" }, [{ path: "a.ts", content: "x" }])).results[0]!.error).toBe("bad question");
  });
});
