import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCaptainAnswers,
  findTaskPlanFile,
  unansweredQuestionNumbers,
} from "./plan-questions.ts";

const draft = `# Plan

## Open questions

- Q1: Single entry or vendors.js?
- Q2: Custom theme or default?

## Suggested execution

Ship it.
`;

describe("plan questions", () => {
  test("lists unanswered Q numbers", () => {
    expect(unansweredQuestionNumbers(draft)).toEqual(["1", "2"]);
  });

  test("writes one An line per open question", () => {
    const next = appendCaptainAnswers(draft, "Follow Atria.\nDefault theme.");
    expect(unansweredQuestionNumbers(next)).toEqual([]);
    expect(next).toContain("- A1: Follow Atria.");
    expect(next).toContain("  Default theme.");
    expect(next).toContain("- A2: Follow Atria.");
    expect(next).toContain("## Suggested execution");
  });

  test("does not duplicate an answer already in the section", () => {
    const once = appendCaptainAnswers(draft, "Follow Atria.");
    expect(appendCaptainAnswers(once, "Follow Atria.")).toBe(once);
  });

  test("finds the plan named in the task brief", async () => {
    const root = await mkdtemp(join(tmpdir(), "plan-gate-"));
    const vault = join(root, "vault");
    const plan = join(vault, "fleet/plans/refactor/demo.md");
    const home = join(root, "home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(vault, "fleet/plans/refactor"), { recursive: true });
    await mkdir(join(home, "data/demo-task"), { recursive: true });
    await writeFile(plan, draft, "utf8");
    await writeFile(
      join(home, "data/demo-task/brief.md"),
      "Write fleet/plans/refactor/demo.md and stop.\n",
      "utf8",
    );
    expect(await findTaskPlanFile({ fmHome: home, vault, taskId: "demo-task" })).toBe(plan);
    await rm(root, { recursive: true, force: true });
  });
});

// bin/plan-ship-gate.ts is a local, untracked script on the captain's machine; clean checkouts
// (crew worktrees, other hosts) do not have it, so the test runs only where it exists.
const GATE = join(import.meta.dir, "..", "..", "bin", "plan-ship-gate.ts");

describe("plan ship gate", () => {
  test.skipIf(!existsSync(GATE))("refuses a draft with an open question and allows it after An", async () => {
    const root = await mkdtemp(join(tmpdir(), "ship-gate-"));
    const vault = join(root, "vault");
    const home = join(root, "home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(vault, "fleet/plans/refactor"), { recursive: true });
    await mkdir(join(home, "data/demo-task"), { recursive: true });
    const plan = join(vault, "fleet/plans/refactor/demo.md");
    await writeFile(plan, draft, "utf8");
    await writeFile(
      join(home, "data/demo-task/brief.md"),
      "See fleet/plans/refactor/demo.md\n",
      "utf8",
    );
    const gate = join(import.meta.dir, "..", "..", "bin", "plan-ship-gate.ts");
    const blocked = Bun.spawn(["bun", gate, "demo-task"], {
      env: { ...process.env, FM_HOME: home, ALICE_VAULT: vault },
      stdout: "pipe",
      stderr: "pipe",
    });
    const blockedErr = await new Response(blocked.stderr).text();
    expect(await blocked.exited).toBe(1);
    expect(blockedErr).toContain("Q1");
    expect(blockedErr).toContain("Q2");

    await writeFile(plan, appendCaptainAnswers(draft, "Use the recommendation."), "utf8");
    const open = Bun.spawn(["bun", gate, "demo-task"], {
      env: { ...process.env, FM_HOME: home, ALICE_VAULT: vault },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await open.exited).toBe(0);
    expect(unansweredQuestionNumbers(await readFile(plan, "utf8"))).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
