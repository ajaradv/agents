import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "jev-"));
const { jevAsk, jevSpend, resetJevForTests } = await import("./jev.ts");

const q = { urgent: { type: "noul" as const, instructions: "Is `message` urgent?" } };
const answer = (noul: number, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul } }, usage: { input_tokens: 300, ...extra } }), { status: 200 });

describe("jev client", () => {
  test("TypeSafe answers: logged with cost from tokens", async () => {
    resetJevForTests({ typesafe: "t", openrouter: "o" });
    const urls: string[] = [];
    const r = await jevAsk("test-a", { message: "down" }, q, { fetchImpl: (async (u: string) => (urls.push(u), answer(0.9))) as never });
    expect(r).toMatchObject({ ok: true, route: "typesafe", inputTokens: 300 });
    expect(r.ok && r.cost).toBeCloseTo(300 * 0.042e-6, 12);
    expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
  });
  test("TypeSafe fails: OpenRouter answers, with its reported cost", async () => {
    resetJevForTests({ typesafe: "t", openrouter: "o" });
    const r = await jevAsk("test-b", { message: "x" }, q, {
      fetchImpl: (async (u: string) => (u.includes("typesafe.ai") ? new Response("busy", { status: 529 }) : answer(0.2, { cost: 0.000013 }))) as never,
    });
    expect(r).toMatchObject({ ok: true, route: "openrouter", cost: 0.000013 });
  });
  test("both fail: an error naming each route; nothing invented", async () => {
    resetJevForTests({ typesafe: "t", openrouter: "" });
    const r = await jevAsk("test-c", { message: "y" }, q, { fetchImpl: (async () => { throw new Error("offline"); }) as never });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("typesafe: offline");
    expect(!r.ok && r.error).toContain("openrouter: no key");
  });
  test("identical requests are served from the cache; spend is summed per use", async () => {
    resetJevForTests({ typesafe: "t", openrouter: "o" });
    let calls = 0;
    const f = (async () => (calls++, answer(0.5))) as never;
    await jevAsk("test-d", { message: "same" }, q, { fetchImpl: f });
    const again = await jevAsk("test-d", { message: "same" }, q, { fetchImpl: f });
    expect(calls).toBe(1);
    expect(again).toMatchObject({ ok: true, route: "cache" });
    const spend = jevSpend(1);
    expect(spend.find((s) => s.use === "test-d")).toMatchObject({ calls: 1, failed: 0, inputTokens: 300 });
    expect(spend.find((s) => s.use === "test-b")?.failed).toBe(1);
  });
});
