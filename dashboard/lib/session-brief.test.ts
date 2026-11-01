import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "brief-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const b = await import("./session-brief.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

function vault(tasks: Record<string, { fm: string; body?: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "brief-vault-"));
  mkdirSync(join(root, "tasks"));
  for (const [id, t] of Object.entries(tasks)) writeFileSync(join(root, "tasks", `${id}.md`), `---\ntype: Task\ntitle: ${id}\n${t.fm}\n---\n\n# Task\n\n## Done when\n\n${t.body ?? ""}\n`);
  return root;
}

describe("session brief", () => {
  const root = vault({
    overdue: { fm: "status: open\ndue: 2026-10-25" },
    soon: { fm: "status: open\ndue: 2026-11-04" },
    later: { fm: "status: open\ndue: 2026-12-01" },
    finished: { fm: "status: done\ndue: 2026-10-01" },
    working: { fm: "status: in-progress\npriority: high", body: "- [x] one\n- [ ] second step\n- [ ] third step\n- [ ] fourth step" },
    sealed: { fm: "status: in-progress", body: "- [x] all done" },
    waiting: { fm: 'status: open\nblocked_by: ["[[working]]"]', body: "- [ ] hidden step" },
    ready: { fm: "status: open\npriority: low", body: "- [ ] ready step" },
  });
  const text = b.buildBrief("2026-10-29", root);

  test("lists what is due within a week or overdue, soonest first, and nothing later or done", () => {
    expect(text).toContain("## Due within 7 days or overdue\n- overdue: overdue since 2026-10-25\n- soon: due 2026-11-04\n");
    expect(text).not.toContain("later");
    expect(text).not.toContain("finished");
  });

  test("shows the first two open steps of active tasks, in-progress first, and the closeable ones", () => {
    expect(text).toContain("- working [in-progress, high] 1/4: second step / third step\n");
    expect(text).not.toContain("fourth step");
    expect(text).toContain("## Closeable (all Done-when items checked)\n- sealed\n");
    expect(text.indexOf("- working")).toBeLessThan(text.indexOf("- ready"));
    expect(text).not.toContain("hidden step"); // waits on another task
  });

  test("never longer than 1500 bytes, and says how many it left out", () => {
    const many = vault(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`task-${i}`, { fm: `status: in-progress\ndue: 2026-10-${String(10 + (i % 15)).padStart(2, "0")}`, body: "- [ ] a fairly long step description to fill the space quickly, really" }])));
    const out = b.buildBrief("2026-10-29", many);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(b.BRIEF_CAP);
    expect(out).toMatch(/\(\+\d+ more: vault_tasks\)/);
  });

  test("the whole brief is byte-identical to the one the loop in buildBrief wrote before fitSections", () => {
    expect(text).toBe(
      "# Session brief 2026-10-29 (built by the node from the vault tasks; vault_tasks filter=next is live)\n\n## Due within 7 days or overdue\n- overdue: overdue since 2026-10-25\n- soon: due 2026-11-04\n\n## Closeable (all Done-when items checked)\n- sealed\n\n## Active tasks, next steps\n- working [in-progress, high] 1/4: second step / third step\n- ready [open, low] 0/1: ready step\n",
    );
  });

  test("fitSections skips empty sections, adds the more line with its hint, and names the sections it cut", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- line ${i} ${"x".repeat(40)}`);
    const r = b.fitSections("# head", [["A", lines], ["Empty", []], ["B", ["- b"]]], 300, " in the tool");
    expect(r.text).toMatch(/^# head\n\n## A\n- line 0/);
    expect(r.text).toMatch(/\n- \(\+\d+ more in the tool\)$/);
    expect(r.text).not.toContain("Empty");
    expect(r.cut).toEqual(["B"]);
    expect(b.fitSections("# head", [["A", ["- a"]]], 300).cut).toEqual([]);
  });

  test("an empty vault still gives a header and nothing else", () => {
    expect(b.buildBrief("2026-10-29", mkdtempSync(join(tmpdir(), "empty-")))).toMatch(/^# Session brief 2026-10-29[^\n]*\n$/);
  });

  test("writes alice/brief.md under the inbox, and only when it changed", () => {
    expect(b.briefPath()).toBe(join(inbox, "alice", "brief.md"));
    expect(b.writeSessionBrief("2026-10-29", root)).toBe(true);
    expect(readFileSync(b.briefPath(), "utf8")).toBe(text);
    expect(b.writeSessionBrief("2026-10-29", root)).toBe(false);
    expect(b.writeSessionBrief("2026-10-30", root)).toBe(true);
  });
});

describe("session facts", () => {
  test("writes alice/facts.md from the current facts, only when they changed, within the cap", async () => {
    const j = await import("./journal.ts");
    const f = await import("./facts.ts");
    j._closeJournal();
    expect(b.writeSessionFacts()).toBe(false); // no facts, no file
    f.factSet({ subject: "hub", key: "host", value: "exe.dev", source: "test", by: "alice" });
    expect(b.writeSessionFacts()).toBe(true);
    expect(readFileSync(b.factsPath(), "utf8")).toBe("- hub.host = exe.dev\n");
    expect(b.writeSessionFacts()).toBe(false);
    for (let i = 0; i < 40; i++) f.factSet({ subject: "s", key: `k${i}`, value: "v".repeat(100), source: "test", by: "alice" });
    b.writeSessionFacts();
    expect(Buffer.byteLength(readFileSync(b.factsPath(), "utf8"))).toBeLessThanOrEqual(b.FACTS_CAP);
    j._closeJournal();
  });
});
