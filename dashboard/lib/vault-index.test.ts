import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "vault-index-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const idx = await import("./vault-index.ts");
const rec = await import("./recall.ts");
const j = await import("./journal.ts");
afterAll(() => {
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const root = mkdtempSync(join(tmpdir(), "vault-index-vault-"));
const put = (rel: string, text: string, mtime?: number) => {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mtime) utimesSync(join(root, rel), mtime, mtime);
};
const rows = (sql: string, ...a: string[]) => j.journalDb().query(sql).all(...a) as Record<string, unknown>[];

put("tasks/m1.md", "---\ntype: Task\ntitle: M1 tools\nstatus: in-progress\nship: fleet\ndescription: typed tools for Alice\ntimestamp: 2026-10-29T00:00:00Z\n---\n\n# Task\n\nBuild the compaction advisor report.\n\n## Done when\n\n- [ ] zebra crossing item\n");
put("fleet/plans/jev.md", "---\ntype: Plan\ntitle: Jev system one\nstatus: done\nship: fleet\nsummary: Jev answers typed questions.\n---\n\nIntro text about quokkas.\n\n## Gate\n\nThe tool gate asks Jev whether a call is safe.\n");
put("fleet/plans/other.md", "---\ntype: Plan\ntitle: Other plan\nstatus: accepted\n---\n\n## Gate\n\nA different gate, for rivers.\n");
put("fleet/plans/cat.md", "---\ncategory: research\ntitle: Categorised\n---\n\nbody\n");
put("notes/plain.md", "no frontmatter here, only wombats\n");
put(".obsidian/workspace.md", "---\ntype: Config\n---\nsecretword\n");
put("templates/task.md", "---\ntype: Task\n---\n<% tp.date.now() %> secretword\n");
put("career/cv.md", "---\ntitle: CV\n---\n\nsecretword career\n");
put("profile/me.md", "---\ntitle: Me\n---\n\nsecretword profile\n");
put("notes/broken.md", "---\ntitle: a: b\n---\n\n## Heading\n\nbrokenfm content\n");

describe("vault mirror", () => {
  test("mirrors frontmatter for every note, skipping .obsidian, templates, career and profile", () => {
    expect(idx.indexVault(root)).toEqual({ added: 6, removed: 0 });
    expect(rows("SELECT path FROM vault_notes ORDER BY path").map((r) => r.path)).toEqual(["fleet/plans/cat.md", "fleet/plans/jev.md", "fleet/plans/other.md", "notes/broken.md", "notes/plain.md", "tasks/m1.md"]);
    const t = rows("SELECT * FROM vault_notes WHERE path = 'tasks/m1.md'")[0]!;
    expect(t).toMatchObject({ type: "Task", title: "M1 tools", status: "in-progress", ship: "fleet", description: "typed tools for Alice", summary: null, updated: "2026-10-29T00:00:00Z" });
    expect(JSON.parse(t.fm_json as string).status).toBe("in-progress");
    expect(rows("SELECT title FROM vault_notes WHERE path = 'notes/plain.md'")[0]!.title).toBe("plain");
  });

  test("sections are in the FTS index as source vault, with path#heading refs", () => {
    const refs = rows("SELECT ref FROM recall_fts WHERE source = 'vault' AND ref LIKE 'fleet/plans/jev.md#%' ORDER BY ref").map((r) => r.ref);
    expect(refs).toEqual(["fleet/plans/jev.md#", "fleet/plans/jev.md#Gate"]);
  });

  test("a second pass changes nothing; an edit re-indexes only that note and leaves no stale rows", () => {
    expect(idx.indexVault(root)).toEqual({ added: 0, removed: 0 });
    put("fleet/plans/jev.md", "---\ntype: Plan\ntitle: Jev system one\nstatus: done\n---\n\nIntro text about quokkas.\n\n## Renamed\n\nNothing about the old section.\n", Date.now() / 1000 + 10);
    expect(idx.indexVault(root)).toEqual({ added: 1, removed: 0 });
    const refs = rows("SELECT ref FROM recall_fts WHERE source = 'vault' AND ref LIKE 'fleet/plans/jev.md#%' ORDER BY ref").map((r) => r.ref);
    expect(refs).toEqual(["fleet/plans/jev.md#", "fleet/plans/jev.md#Renamed"]);
    expect(rows("SELECT summary FROM vault_notes WHERE path = 'fleet/plans/jev.md'")[0]!.summary).toBeNull();
    expect(rows("SELECT ref FROM recall_fts WHERE recall_fts MATCH 'safe' AND source = 'vault'")).toEqual([]);
  });

  test("a pass by newer code rebuilds every note, whatever the mtimes say", () => {
    j.journalDb().query("UPDATE recall_seen SET mark = 'old' WHERE key = 'vault-index'").run();
    expect(idx.indexVault(root).added).toBe(6);
    expect(idx.indexVault(root)).toEqual({ added: 0, removed: 0 });
  });

  test("a deleted note loses its row and its sections", () => {
    rmSync(join(root, "fleet/plans/other.md"));
    expect(idx.indexVault(root)).toEqual({ added: 0, removed: 1 });
    expect(rows("SELECT path FROM vault_notes WHERE path = 'fleet/plans/other.md'")).toEqual([]);
    expect(rows("SELECT ref FROM recall_fts WHERE source = 'vault' AND ref LIKE 'fleet/plans/other.md#%'")).toEqual([]);
  });

  test("symlinks are not followed", () => {
    symlinkSync(join(root, "tasks/m1.md"), join(root, "tasks/alias.md"));
    expect(idx.indexVault(root)).toEqual({ added: 0, removed: 0 });
  });

  test("recall does not return vault sections", () => {
    expect(rec.recall("quokkas")).toEqual([]);
  });
});

describe("vault search", () => {
  const find = (q: Parameters<typeof idx.searchVault>[0]) => idx.searchVault(q, root) as { ok: boolean; message: string; hits: { path: string; section?: string; snippet?: string; summary: string | null }[] };

  test("frontmatter filters alone list matching notes, newest first", () => {
    expect(find({ type: "Plan" }).hits.map((h) => h.path)).toEqual(["fleet/plans/jev.md"]);
    expect(find({ type: "research" }).hits.map((h) => h.path)).toEqual(["fleet/plans/cat.md"]); // `category:` stands in for a missing type
    expect(find({ status: "in-progress", ship: "FLEET" }).hits.map((h) => h.path)).toEqual(["tasks/m1.md"]);
    expect(find({ path: "tasks/" }).hits.map((h) => h.path)).toEqual(["tasks/m1.md"]);
    expect(find({ path: "fleet/**" }).hits.map((h) => h.path).sort()).toEqual(["fleet/plans/cat.md", "fleet/plans/jev.md"]);
    expect(find({ path: "fleet/plans/jev.md" }).message).toBe("1 note(s) match path=fleet/plans/jev.md");
  });

  test("words find sections: the hit names the matching section and shows a snippet", () => {
    const r = find({ query: "advisor" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ path: "tasks/m1.md", section: "Task" });
    expect(r.hits[0]!.snippet).toContain("«advisor»");
    expect(r.hits[0]!.summary).toBe("typed tools for Alice"); // description stands in for summary
    expect(find({ query: "zebra" }).hits[0]!.section).toBe("Done when");
    expect(find({ query: "quokkas" }).hits[0]!.section).toBe("(top)");
  });

  test("words and filters combine; no match says zero and what was searched", () => {
    expect(find({ query: "advisor", type: "Plan" }).message).toBe('0 notes match "advisor", type=Plan');
    expect(find({ query: "advisor", type: "Task" }).hits).toHaveLength(1);
    expect(find({ query: "secretword" }).hits).toEqual([]);
    expect(find({ query: "!!!" }).ok).toBe(false);
  });

  test("a note with broken frontmatter is still found by its words", () => {
    expect(find({ query: "brokenfm" }).hits[0]).toMatchObject({ path: "notes/broken.md", section: "Heading" });
  });

  test("limit caps the rows and says how many matched", () => {
    const r = find({ path: "", limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.message).toMatch(/^\d+ note\(s\) match all notes; showing the first 2$/);
  });
});
