import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorOn, MODELS_PATH, readModels, resolveAlias, sameModel } from "./models-config.ts";

function withFile(text: string | null, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "models-config-"));
  const path = join(dir, "models.json");
  if (text !== null) writeFileSync(path, text);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("models config", () => {
  test("reads the roster", () => {
    withFile('{"cursor":"off","aliases":{"sol":"openrouter/openai/gpt-6.1-sol"},"surveyors":{"zoom-out":["sol","luna"]}}', (path) => {
      const m = readModels(path);
      expect(m.cursor).toBe("off");
      expect(m.surveyors["zoom-out"]).toEqual(["sol", "luna"]);
      expect(resolveAlias("sol", m)).toBe("openrouter/openai/gpt-6.1-sol");
      expect(resolveAlias("cursor/composer-2.5", m)).toBe("cursor/composer-2.5");
      expect(cursorOn(path)).toBe(false);
    });
  });

  test("a missing or broken file means Cursor on and no aliases", () => {
    withFile(null, (path) => {
      expect(readModels(path)).toEqual({ cursor: "on", aliases: {}, surveyors: {} });
      expect(cursorOn(path)).toBe(true);
    });
    withFile("not json", (path) => expect(cursorOn(path)).toBe(true));
  });

  test("anything but off is on", () => {
    withFile('{"cursor":"on"}', (path) => expect(cursorOn(path)).toBe(true));
  });

  test("sameModel compares the last two segments", () => {
    expect(sameModel("openrouter/deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro")).toBe(true);
    expect(sameModel("openrouter/deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4-flash")).toBe(false);
    expect(sameModel("cursor/composer-2.5", "cursor/composer-2.5")).toBe(true);
  });

  test("the shipped roster names every alias the agents use", () => {
    const m = readModels(MODELS_PATH);
    expect(m.aliases["grok-4.7"]).toBe("cursor/grok-4.7@256k");
    expect(Object.keys(m.surveyors)).toContain("zoom-out");
  });
});
