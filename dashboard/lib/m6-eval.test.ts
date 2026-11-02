import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "m6-eval-inbox-"));
const vault = mkdtempSync(join(tmpdir(), "m6-eval-vault-"));
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
const e = await import("./m6-eval.ts");
const rec = await import("./recall.ts");
const j = await import("./journal.ts");
afterAll(() => {
  j._closeJournal();
  if (prev.inbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev.inbox;
  if (prev.vault === undefined) delete process.env.ALICE_VAULT;
  else process.env.ALICE_VAULT = prev.vault;
});

describe("parseEvalTable", () => {
  test("reads rows: args JSON, several answers, escaped pipes", () => {
    const md = [
      "# Eval",
      "Some prose | with a pipe.",
      "| # | tool | query | args | answers | source |",
      "|---|---|---|---|---|---|",
      '| 1 | vault_search | gate rules | {"type":"Plan"} | vault/fleet/plans/jev.md; ./tasks/m1.md | candidate |',
      "| 2 | recall | palette | {} | chat:alice\\|alice captain\\|2026-10-01T00:00:00Z | captain |",
      "| 3 | recall | journal | | digest\\|/x/d.md\\|t | sample |",
    ].join("\n");
    const rows = e.parseEvalTable(md);
    expect(rows).toEqual([
      { n: 1, tool: "vault_search", query: "gate rules", args: { type: "Plan" }, answers: ["fleet/plans/jev.md", "tasks/m1.md"], source: "candidate" },
      { n: 2, tool: "recall", query: "palette", args: {}, answers: ["chat:alice|alice captain|2026-10-01T00:00:00Z"], source: "captain" },
      { n: 3, tool: "recall", query: "journal", args: {}, answers: ["digest|/x/d.md|t"], source: "sample" },
    ]);
  });

  test("a row it cannot read is an error", () => {
    expect(() => e.parseEvalTable("| 1 | grep | x | {} | a | sample |")).toThrow("tool must be");
    expect(() => e.parseEvalTable("| 1 | recall | x | {oops | a | sample |")).toThrow("args is not JSON");
    expect(() => e.parseEvalTable("| 1 | recall | x | {} | | sample |")).toThrow("no answers");
  });
});

describe("scoring", () => {
  test("recall@5: an answer ranked sixth is not found; per tool and source", () => {
    const ts = "2026-10-01T00:00:00Z";
    const add = (ref: string, text: string) => rec.recallDb().query("INSERT INTO recall_fts (source, ref, ts, text) VALUES ('notice', ?, ?, ?)").run(ref, ts, text);
    for (let i = 1; i <= 5; i++) add(`n${i}`, `zebra zebra zebra zebra filler${i}`); // short, dense: rank first
    add("n6", "zebra " + "padding ".repeat(60));
    const id = (ref: string) => `notice|${ref}|${ts}`;
    const rows = e.parseEvalTable(
      [`| 1 | recall | zebra | {} | ${id("n1")} | sample |`.replace(/\|(?=n|20)/g, "\\|"), `| 2 | recall | zebra | {} | ${id("n6")} | candidate |`.replace(/\|(?=n|20)/g, "\\|")].join("\n"),
    );
    expect(rows.map((r) => r.answers[0])).toEqual([id("n1"), id("n6")]);
    expect(e.topRefs(rows[0]!, "fts")).toHaveLength(5);
    const s = e.scoreEval(rows, "fts");
    expect(s.overall).toEqual({ rows: 2, found: 1, recall_at_5: 0.5 });
    expect(s.by_tool.recall).toEqual({ rows: 2, found: 1, recall_at_5: 0.5 });
    expect(s.by_source.sample!.found).toBe(1);
    expect(s.by_source.candidate!.found).toBe(0);
    expect(s.missed).toEqual([2]);
  });

  test("the strict variant puts AND matches first, then OR fills the rest", () => {
    const ts = "2026-10-02T00:00:00Z";
    const add = (ref: string, text: string) => rec.recallDb().query("INSERT INTO recall_fts (source, ref, ts, text) VALUES ('notice', ?, ?, ?)").run(ref, ts, text);
    for (let i = 1; i <= 5; i++) add(`m${i}`, `quokka quokka quokka quokka only${i}`); // OR ranks these first
    for (let i = 1; i <= 5; i++) add(`w${i}`, `wombat wombat wombat wombat only${i}`);
    add("both", "quokka wombat " + "padding ".repeat(80));
    const row = e.parseEvalTable(`| 1 | recall | quokka wombat | {} | notice\\|both\\|${ts} | sample |`)[0]!;
    expect(e.topRefs(row, "fts")).not.toContain(`notice|both|${ts}`);
    const strict = e.topRefs(row, "strict");
    expect(strict[0]).toBe(`notice|both|${ts}`);
    expect(strict).toHaveLength(5);
    expect(e.strictFirst(["a", "b"], ["b", "c", "d"], 3)).toEqual(["a", "b", "c"]);
    expect(rec.ftsQueryStrict("quokka wombat")).toContain(" AND ");
  });
});
