import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { splitNote } from "./vault-note.ts";
import { vaultPatch } from "./vault-patch.ts";

const TASK = `---
type: Task
title: "Build: the thing"   # keep this comment
status: open
priority: high
blocked_by:
  - "[[recon]]"
  - "[[plan]]"
tags: [a,b]
description: >-
  A folded
  description.
timestamp: 2026-10-29T00:00:00Z
---

# Task

Some prose with [ ] brackets that is not a checklist.

## Done when

- [ ] Write the \`fleet_query\` tool
- [ ] Write the vault_note tool
- [x] Plan the work
  - [ ] nested item about tests

\`\`\`
- [ ] inside a fence
\`\`\`
`;

function setup(files: Record<string, string> = { "tasks/t.md": TASK }): string {
  const root = mkdtempSync(join(tmpdir(), "vault-patch-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
const read = (root: string, rel = "tasks/t.md") => readFileSync(join(root, rel), "utf8");

describe("vault_patch set", () => {
  test("replaces a field in place; every other byte, comment and key order stays", () => {
    const root = setup();
    const r = vaultPatch({ path: "tasks/t.md", set: { status: "done" } }, root);
    expect(r).toMatchObject({ ok: true, changed: true, message: "tasks/t.md: status: open -> done" });
    expect(read(root)).toBe(TASK.replace("status: open", "status: done"));
  });

  test("adds a new field at the end of the frontmatter; the body is untouched", () => {
    const root = setup();
    vaultPatch({ path: "tasks/t.md", set: { due: "2026-11-02", note: "has: a colon" } }, root);
    const out = read(root);
    expect(out).toContain('timestamp: 2026-10-29T00:00:00Z\ndue: 2026-11-02\nnote: "has: a colon"\n---\n\n# Task');
    expect(out.slice(out.indexOf("# Task"))).toBe(TASK.slice(TASK.indexOf("# Task")));
    expect(Object.keys(parse(splitNote(out).fmText!))).toEqual(["type", "title", "status", "priority", "blocked_by", "tags", "description", "timestamp", "due", "note"]);
  });

  test("replaces lists and multi-line values and the YAML stays valid", () => {
    const root = setup();
    vaultPatch({ path: "tasks/t.md", set: { blocked_by: ["[[x]]"], description: "one line: with colon", tags: [] } }, root);
    const fm = parse(splitNote(read(root)).fmText!) as Record<string, unknown>;
    expect(fm.blocked_by).toEqual(["[[x]]"]);
    expect(fm.description).toBe("one line: with colon");
    expect(fm.tags).toEqual([]);
    expect(fm.title).toBe("Build: the thing");
    expect(read(root)).toContain("# keep this comment");
    expect(read(root)).toContain("priority: high\nblocked_by:\n  - \"[[x]]\"\ntags: []\ndescription: ");
  });

  test("values that look like other types are quoted so they stay what was asked", () => {
    const root = setup();
    vaultPatch({ path: "tasks/t.md", set: { status: "true", priority: "123", flag: true, n: 5, nothing: null } }, root);
    const fm = parse(splitNote(read(root)).fmText!) as Record<string, unknown>;
    expect(fm).toMatchObject({ status: "true", priority: "123", flag: true, n: 5, nothing: null });
  });

  test("setting what is already there says so and writes nothing", () => {
    const root = setup();
    const r = vaultPatch({ path: "tasks/t.md", set: { status: "open", priority: "high" } }, root);
    expect(r).toMatchObject({ ok: true, changed: false, message: "tasks/t.md: no change (status already open; priority already high)" });
    expect(read(root)).toBe(TASK);
  });

  test("refuses notes without frontmatter, frontmatter that does not parse, and odd field names", () => {
    const root = setup({ "a.md": "# no frontmatter\n", "b.md": "---\ntitle: a: b\n---\nbody\n", "tasks/t.md": TASK });
    expect(vaultPatch({ path: "a.md", set: { x: 1 } }, root)).toMatchObject({ ok: false, message: expect.stringContaining("no frontmatter") });
    expect(vaultPatch({ path: "b.md", set: { x: 1 } }, root)).toMatchObject({ ok: false, message: expect.stringContaining("does not parse") });
    expect(vaultPatch({ path: "tasks/t.md", set: { "bad key: x": 1 } }, root)).toMatchObject({ ok: false });
    expect(read(root, "b.md")).toBe("---\ntitle: a: b\n---\nbody\n");
  });

  test("a failure partway writes nothing", () => {
    const root = setup();
    expect(vaultPatch({ path: "tasks/t.md", set: { status: "done" }, check: "no such item" }, root).ok).toBe(false);
    expect(read(root)).toBe(TASK);
  });
});

describe("vault_patch checklist", () => {
  test("ticks the one item whose text matches, case-insensitively, changing one character", () => {
    const root = setup();
    const r = vaultPatch({ path: "tasks/t.md", check: "VAULT_NOTE" }, root);
    expect(r).toMatchObject({ ok: true, message: "tasks/t.md: checked: Write the vault_note tool" });
    expect(read(root)).toBe(TASK.replace("- [ ] Write the vault_note", "- [x] Write the vault_note"));
  });

  test("unticks, and repeating either says it already holds", () => {
    const root = setup();
    expect(vaultPatch({ path: "tasks/t.md", uncheck: "plan the work" }, root)).toMatchObject({ ok: true, changed: true });
    expect(read(root)).toContain("- [ ] Plan the work");
    expect(vaultPatch({ path: "tasks/t.md", uncheck: "plan the work" }, root)).toMatchObject({ ok: true, changed: false, message: expect.stringContaining("already unchecked") });
    expect(vaultPatch({ path: "tasks/t.md", check: "fleet_query" }, root).ok).toBe(true);
    expect(vaultPatch({ path: "tasks/t.md", check: "fleet_query" }, root)).toMatchObject({ changed: false, message: expect.stringContaining("already checked") });
  });

  test("several matches is an error that lists the candidates; so are none", () => {
    const root = setup();
    const many = vaultPatch({ path: "tasks/t.md", check: "write the" }, root);
    expect(many.ok).toBe(false);
    expect(many.message).toContain("2 items contain");
    expect(many.message).toContain("[ ] Write the `fleet_query` tool");
    expect(many.message).toContain("[ ] Write the vault_note tool");
    expect(vaultPatch({ path: "tasks/t.md", check: "unicorn" }, root)).toMatchObject({ ok: false, message: expect.stringContaining("No checklist item contains") });
    expect(read(root)).toBe(TASK);
  });

  test("code fences and frontmatter are not checklists", () => {
    const root = setup();
    expect(vaultPatch({ path: "tasks/t.md", check: "inside a fence" }, root).ok).toBe(false);
  });

  test("a nested item is found; CRLF files keep their line endings", () => {
    const crlf = TASK.replace(/\n/g, "\r\n");
    const root = setup({ "tasks/t.md": crlf });
    expect(vaultPatch({ path: "tasks/t.md", check: "nested item" }, root).ok).toBe(true);
    expect(read(root)).toBe(crlf.replace("[ ] nested", "[x] nested"));
  });
});

describe("vault_patch paths", () => {
  test("refuses career/ and profile/, whatever the spelling", () => {
    const root = setup({ "career/cv.md": "---\na: 1\n---\n- [ ] x\n", "profile/me.md": "---\na: 1\n---\n", "tasks/t.md": TASK });
    for (const p of ["career/cv.md", "profile/me.md", "./career/cv", join(root, "career/cv.md")]) {
      expect(vaultPatch({ path: p, set: { a: 2 } }, root)).toMatchObject({ ok: false, message: expect.stringContaining("captain's") });
    }
    expect(read(root, "career/cv.md")).toBe("---\na: 1\n---\n- [ ] x\n");
  });

  test("refuses .. and symlinks that leave the vault", () => {
    const outside = setup({ "secret.md": "---\na: 1\n---\n" });
    const root = setup();
    symlinkSync(join(outside, "secret.md"), join(root, "tasks/link.md"));
    symlinkSync(outside, join(root, "tasks/dir"));
    for (const p of ["../x.md", "tasks/../../x.md", "tasks/link.md", "tasks/dir/secret.md"]) {
      expect(vaultPatch({ path: p, set: { a: 2 } }, root).ok).toBe(false);
    }
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("---\na: 1\n---\n");
  });

  test("asks for something to do", () => {
    expect(vaultPatch({ path: "tasks/t.md" }, setup())).toMatchObject({ ok: false, message: expect.stringContaining("Nothing to do") });
  });
});
