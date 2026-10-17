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
