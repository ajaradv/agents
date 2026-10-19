import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "free-models-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const f = await import("./free-models.ts");
const m = await import("./metrics.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const model = (over: Partial<import("./free-models.ts").FreeModel>) =>
  ({ provider: "openrouter", model: "x:free", ctx: 262144, tools: true, images: false, uptime: 99, latencyMs: 500, checkOk: true, checkMs: 1500, note: "", checkedAt: "", ...over }) as import("./free-models.ts").FreeModel;

describe("free model lanes", () => {
  test("the capability check is scored by code", () => {
    expect(f.checkPassed('{"city": "Lisbon", "items": 3}')).toBe(true);
    expect(f.checkPassed('Sure! ```json\n{"city":"Lisbon","items":"3"}\n```')).toBe(true);
    expect(f.checkPassed('{"city": "Porto", "items": 3}')).toBe(false);
    expect(f.checkPassed("Lisbon, 3")).toBe(false);
  });

  test("the catalog yields zero-price text models only", () => {
    const got = f.freeFromCatalog([
      { id: "a/b:free", pricing: { prompt: "0", completion: "0" }, context_length: 1000, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "google/lyria", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } },
      { id: "paid/model", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "openrouter/free", pricing: { prompt: "0", completion: "0" } },
    ]);
    expect(got).toEqual([{ provider: "openrouter", model: "a/b:free", ctx: 1000, tools: true, images: true }]);
    expect(f.geminiCandidates([
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.1-flash-live-preview", supportedGenerationMethods: ["bidiGenerateContent"] },
      { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent"] },
    ])).toEqual(["gemini-3.5-flash-lite", "gemma-4-31b-it"]);
  });

  test("picking: passed the check, fits the needs, has quota; most reliable and fastest first", () => {
    const all = [
      model({ model: "slow:free", checkMs: 13_000 }),
      model({ model: "fast:free", checkMs: 1400 }),
      model({ model: "flaky:free", uptime: 30 }),
      model({ model: "failed:free", checkOk: false }),
      model({ model: "small:free", ctx: 32_000 }),
      model({ provider: "google", model: "gemini-flash-lite-latest", uptime: null, checkMs: 400, ctx: 1_048_576 }),
    ];
    const quota = { openrouterRemaining: 500, googleUsed: () => 0 };
    expect(f.pickFreeModels(all, { minCtx: 100_000 }, quota).map((x) => x.model)).toEqual(["fast:free", "gemini-flash-lite-latest", "slow:free", "flaky:free"]);
    expect(f.pickFreeModels(all, { images: true }, quota)).toEqual([]);
    expect(f.pickFreeModels(all, {}, { openrouterRemaining: 2, googleUsed: () => 999 })).toEqual([]);
  });

  test("calls are counted per lane per quota day (Gemini's day starts at midnight Pacific)", () => {
    f.recordFreeCall({ provider: "google", model: "gemini-flash-lite-latest", purpose: "test", ok: true, ms: 400 });
    expect(f.callsToday("google")).toBe(1);
    expect(f.callsToday("google", "gemini-flash-lite-latest")).toBe(1);
    expect(f.quotaDayStart("openrouter", new Date("2026-10-17T05:00:00Z"))).toBe("2026-10-17T00:00:00.000Z");
    expect(f.quotaDayStart("google", new Date("2026-10-17T05:00:00Z"))).toBe("2026-10-16T07:00:00.000Z");
  });
});

describe("two Gemini accounts", () => {
  test("the free lanes never use the paid key (GEMINI_API_KEY is a paid plan)", async () => {
    // Code only: comments may name the paid key to say it is not used.
    const src = (await Bun.file(join(import.meta.dir, "free-models.ts")).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src).not.toContain("GEMINI_API_KEY");
    expect(src).toContain('nodeKey("GEMINI_FREE_API_KEY")');
  });
  test("calls are counted per account with their tokens", () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    f.recordFreeCall({ provider: "google", model: "gemini-x", purpose: "test", ok: true, ms: 5, account: "gemini-free", tokensIn: 120, tokensOut: 30 });
    f.recordFreeCall({ provider: "google", model: "gemini-x", purpose: "test", ok: false, ms: 5, account: "gemini-free" });
    expect(f.geminiUsage("gemini-free", since)).toEqual({ calls: 2, failed: 1, tokensIn: 120, tokensOut: 30 });
    expect(f.geminiUsage("gemini-paid", since).calls).toBe(0);
  });
  test("the free key is the node's own: stripped from any child's environment", async () => {
    const { withoutSecrets } = await import("./fleet-env.ts");
    expect(withoutSecrets({ GEMINI_FREE_API_KEY: "x", GEMINI_API_KEY: "y", PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
});
