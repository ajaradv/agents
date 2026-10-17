import { describe, expect, test } from "bun:test";
import { publicPrompt, sensitiveReason } from "./public-helper.ts";

describe("public helper", () => {
  test("refuses text that looks private", () => {
    expect(sensitiveReason("What is a Bloom filter?")).toBeNull();
    expect(sensitiveReason("Reword: our launch is next week, keep it friendly.")).toBeNull();
    expect(sensitiveReason("key sk-or-v1-abcdefghijklmnopqrstuvwxyz123456")).toContain("API key");
    expect(sensitiveReason("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("token");
    expect(sensitiveReason("DEEPSEEK_API_KEY=abcdef123456")).toContain("credential");
    expect(sensitiveReason("see /Users/avega/Workspace/brain/fleet/plans/x.md")).toContain("file path");
    expect(sensitiveReason("-----BEGIN OPENSSH PRIVATE KEY-----")).toContain("private key");
    expect(sensitiveReason("op://Private/item/field")).toContain("1Password");
    expect(sensitiveReason("x".repeat(12_001))).toContain("characters");
  });
  test("the prompt carries the supplied text separately", () => {
    expect(publicPrompt(" Summarise ", "")).toBe("Summarise");
    expect(publicPrompt("Summarise", "Some public text.")).toBe("Summarise\n\n--- Text supplied with the question ---\nSome public text.");
  });
});
