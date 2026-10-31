import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCheck } from "./plan-check.ts";

const tmp = mkdtempSync(join(tmpdir(), "plan-check-"));
const vault = join(tmp, "vault");
mkdirSync(join(vault, "fleet", "plans"), { recursive: true });
const configPath = join(tmp, "crew-dispatch.json");
writeFileSync(configPath, JSON.stringify({ rules: [{ id: "mechanical", when: "trivial", use: { harness: "claude", model: "claude-haiku-4-5", effort: "low" } }] }));
const plan = (block: string) => `---\ntitle: T\nstatus: finalized\n${block}---\n# T\n`;
writeFileSync(join(vault, "fleet", "plans", "good.md"), plan("execution:\n  - task: rename\n    rule: mechanical\n"));
writeFileSync(join(vault, "fleet", "plans", "bad.md"), plan("execution:\n  - task: rename\n    rule: nope\n"));
writeFileSync(join(vault, "fleet", "plans", "none.md"), plan(""));
writeFileSync(join(tmp, "outside.md"), plan("execution:\n  - task: x\n    rule: mechanical\n"));
symlinkSync(join(tmp, "outside.md"), join(vault, "fleet", "plans", "link.md"));

describe("planCheck", () => {
  test("binds each task to its rule and profiles, as TOON", () => {
    const r = planCheck("fleet/plans/good.md", { vault, configPath });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("plan: fleet/plans/good.md");
    expect(r.message).toContain("mechanical");
    expect(r.message).toContain("claude");
  });

  test("an unknown rule is an error with a suggestion; no block says so", () => {
    const bad = planCheck("fleet/plans/bad", { vault, configPath });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("errors");
    expect(bad.message).toContain("nope");
    const none = planCheck("fleet/plans/none.md", { vault, configPath });
    expect(none.ok).toBe(true);
    expect(none.message).toContain("no execution block");
  });

  test("only notes inside the vault", () => {
    expect(planCheck("../outside.md", { vault, configPath }).ok).toBe(false);
    expect(planCheck(join(tmp, "outside.md"), { vault, configPath }).ok).toBe(false);
    expect(planCheck("fleet/plans/link.md", { vault, configPath })).toEqual({ ok: false, message: "fleet/plans/link.md resolves outside the vault." });
    expect(planCheck("fleet/plans/missing.md", { vault, configPath }).ok).toBe(false);
  });

  test("missing dispatch rules say so", () => {
    const r = planCheck("fleet/plans/good.md", { vault, configPath: join(tmp, "none.json") });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("dispatch rules");
  });
});
