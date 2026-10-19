import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "toolfail-inbox-"));
const vault = mkdtempSync(join(tmpdir(), "toolfail-vault-"));
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
const f = await import("./tool-failures.ts");
const { journalDb } = await import("./journal.ts");
afterAll(() => {
  if (prev.inbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev.inbox;
  if (prev.vault === undefined) delete process.env.ALICE_VAULT;
  else process.env.ALICE_VAULT = prev.vault;
});

const notices = () => (journalDb().query("SELECT summary FROM notices WHERE summary LIKE '%failed%'").all() as { summary: string }[]).map((r) => r.summary);

describe("tool failure log", () => {
  test("failures are recorded, counted per agent and tool, and shown on Health", () => {
    f.recordToolFailure({ agent: "designer", tool: "read", args: "read: /tmp/shots/tbl.png", error: "ENOENT: no such file", model: "openrouter/anthropic/claude-sonnet-5.5" });
    f.recordToolFailure({ agent: "architect", tool: "turn", error: "Could not parse Anthropic SSE event" });
    expect(f.recentToolFailures(5).map((x) => x.tool)).toEqual(["turn", "read"]);
    expect(f.toolFailureCounts(24)).toContainEqual(expect.objectContaining({ agent: "designer", tool: "read", n: 1 }));
    const html = f.toolFailuresHtml();
    expect(html).toContain("Tool failures · 2 in 24h");
    expect(html).toContain("tbl.png");
  });
  test("a tool that keeps failing raises one notice a day, not one per failure", () => {
    for (let i = 0; i < 5; i++) f.recordToolFailure({ agent: "designer", tool: "bash", error: "No module named 'PIL'" });
    expect(notices().filter((s) => s.includes("designer: bash failed")).length).toBe(1);
  });
});

describe("failure noise", () => {
  test("a search or test that answered no is noise; real errors are not", () => {
    expect(f.expectedFailure("bash", 'bash: cd /workspace && grep -n "just pytest " README.md', "(no output) Command exited with code 1")).toBe(true);
    expect(f.expectedFailure("bash", "bash: rg TODO src | grep -v test", "Command exited with code 1")).toBe(true);
    expect(f.expectedFailure("bash", "bash: test -f .env.local", "Command exited with code 1")).toBe(true);
    expect(f.expectedFailure("bash", "bash: git diff --quiet", "Command exited with code 1")).toBe(true);
    expect(f.expectedFailure("bash", "bash: cd /x && git status", "/bin/bash: line 1: cd: /x: No such file or directory Command exited with code 1")).toBe(false);
    expect(f.expectedFailure("bash", "bash: grep -r foo missing-dir", "grep: missing-dir: No such file or directory Command exited with code 2")).toBe(false);
    expect(f.expectedFailure("bash", "bash: just pytest", "1 failed, 41 passed Command exited with code 1")).toBe(false);
    expect(f.expectedFailure("read", "read: x", "Command exited with code 1")).toBe(false);
  });
  test("noise is kept but not counted; other bash failures go to the background judge", () => {
    const judged: string[] = [];
    const judge = (_id: number, x: { args: string }) => judged.push(x.args);
    f.recordToolFailure({ agent: "scout", tool: "bash", args: 'bash: grep -n "x" README.md', error: "(no output) Command exited with code 1" }, judge);
    f.recordToolFailure({ agent: "scout", tool: "bash", args: "bash: python3 build.py", error: "Traceback: KeyError 'x' Command exited with code 1" }, judge);
    expect(judged).toEqual(["bash: python3 build.py"]);
    expect(f.toolFailureCounts(24).find((c) => c.agent === "scout")?.n).toBe(1);
    expect((journalDb().query("SELECT COUNT(*) AS n FROM tool_failures WHERE agent = 'scout'").get() as { n: number }).n).toBe(2);
  });
});
