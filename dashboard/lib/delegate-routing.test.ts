import { describe, expect, test } from "bun:test";
import { helperModel } from "./delegate.ts";

const pick = (choice: string, p: number) => (async () => ({ ok: true, answers: { difficulty: { type: "choice", choice, confidence: p, probabilities: { [choice]: p } } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 })) as never;

describe("helper model routing", () => {
  test("only a confident hard task gets the strong model; unsure or failed stays cheap", async () => {
    expect((await helperModel("Trace why the export crashes across these five modules and propose a fix plan", pick("hard", 0.85))).model).toBe("openrouter/deepseek/deepseek-v4-pro");
    expect((await helperModel("Trace why the export crashes", pick("hard", 0.6))).model).toBe("openrouter/deepseek/deepseek-v4-flash");
    expect((await helperModel("Find the note about the Kinwork stack", pick("easy", 0.9))).model).toBe("openrouter/deepseek/deepseek-v4-flash");
    expect((await helperModel("anything", (async () => ({ ok: false, error: "down" })) as never)).model).toBe("openrouter/deepseek/deepseek-v4-flash");
  });
});
