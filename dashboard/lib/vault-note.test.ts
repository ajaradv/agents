import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTE_CAP, resolveNote, sectionsOf, splitNote, vaultNote } from "./vault-note.ts";

function vault(notes: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vault-note-"));
  for (const [rel, text] of Object.entries(notes)) {
    mkdirSync(join(root, rel.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const PLAN = `---
title: A plan
type: Plan
status: accepted
summary: "One line that says what this is."
related: ["[[a]]", "[[b]]"]
---

Opening words.

## Phases

| Phase | What |
|---|---|
| M0 | fix |

### Detail

M1 text.

## Progress

\`\`\`
## not a heading
\`\`\`

- done
`;

describe("vault_note", () => {
  const root = vault({ "plans/a.md": PLAN });

  test("default view: compact frontmatter, summary, headings with sizes, no body", () => {
    const r = vaultNote("plans/a.md", {}, root) as unknown as { message: string; frontmatter: Record<string, string>; summary: string; headings: { heading: string; bytes: number }[] };
    expect(r.message).toContain("plans/a.md (");
    expect(r.message).toContain("3 sections");
    expect(r.frontmatter).toEqual({ title: "A plan", type: "Plan", status: "accepted", related: "[[a]], [[b]]" });
    expect(r.summary).toBe("One line that says what this is.");
    expect(r.headings.map((h) => h.heading)).toEqual(["## Phases", "### Detail", "## Progress"]);
    expect(r.headings[0]!.bytes).toBeGreaterThan(r.headings[1]!.bytes); // a section counts its subsections
    expect(JSON.stringify(r)).not.toContain("Opening words");
  });

  test("a section matches case-insensitively and carries its subsections; code fences hide fake headings", () => {
    const r = vaultNote("plans/a.md", { section: "phases" }, root) as unknown as { content: string; section: string; frontmatter?: unknown; headings?: unknown };
    expect(r.section).toBe("Phases");
    expect(r.frontmatter ?? r.headings).toBeUndefined(); // a section read is only the section
    expect(r.content).toContain("### Detail");
    expect(r.content).toContain("M1 text.");
    expect(r.content).not.toContain("## Progress");
    expect((vaultNote("plans/a.md", { section: "## Progress" }, root) as unknown as { content: string }).content).toContain("## not a heading");
    expect(sectionsOf(PLAN.slice(PLAN.indexOf("Opening"))).map((s) => s.heading)).toEqual(["Phases", "Detail", "Progress"]);
  });

  test("a missing or ambiguous section is an error that lists the headings", () => {
    expect(vaultNote("plans/a.md", { section: "nope" }, root)).toMatchObject({ ok: false, message: expect.stringContaining("Headings: Phases; Detail; Progress") });
    expect(vaultNote("plans/a.md", { section: "e" }, root)).toMatchObject({ ok: false, message: expect.stringContaining("matches 3 headings") });
  });

  test("full returns the body, capped at 12 KB with a statement of the cut", () => {
    const big = vault({ "big.md": `---\ntitle: Big\n---\n${"line of text\n".repeat(2000)}` });
    const r = vaultNote("big", { full: true }, big) as unknown as { body: string; cut: string };
    expect(Buffer.byteLength(r.body)).toBeLessThanOrEqual(NOTE_CAP);
    expect(r.cut).toContain("cut at 12000 bytes");
    const small = vaultNote("plans/a.md", { full: true }, root) as unknown as { body: string; cut?: string };
    expect(small.body).toContain("Opening words.");
    expect(small.cut).toBeUndefined();
  });

  test("frontmatter that does not parse is said, and the note still reads", () => {
    const bad = vault({ "b.md": "---\ntitle: a: b\n---\n\n# H\n\ntext\n" });
    const r = vaultNote("b.md", {}, bad) as unknown as { frontmatter_error: string; headings: unknown[] };
    expect(r.frontmatter_error).toContain("does not parse");
    expect(r.headings).toHaveLength(1);
  });

  test("paths stay inside the vault", () => {
    const outside = vault({ "secret.md": "x" });
    symlinkSync(join(outside, "secret.md"), join(root, "plans", "link.md"));
    expect(resolveNote("../secret.md", root).ok).toBe(false);
    expect(resolveNote("plans/../../secret.md", root).ok).toBe(false);
    expect(resolveNote(join(outside, "secret.md"), root).ok).toBe(false);
    expect(resolveNote("plans/link.md", root)).toMatchObject({ ok: false, message: expect.stringContaining("outside the vault") });
    expect(resolveNote(join(root, "plans/a.md"), root)).toMatchObject({ ok: true, rel: "plans/a.md" });
    expect(vaultNote("plans/missing.md", {}, root)).toMatchObject({ ok: false, message: expect.stringContaining("vault_search") });
  });

  test("splitNote handles absent frontmatter", () => {
    expect(splitNote("# just text").fmText).toBeNull();
    expect(splitNote("---\na: 1\n---\nbody").body).toBe("body");
  });
});
