import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { examineVault, fixVault, quoteColonValues } from "./vault-doctor.ts";

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const task = (fm: string, body = "") => `---\ntype: Task\n${fm}\n---\n\n${body}`;

describe("vault doctor", () => {
  test("finds each kind of problem, and nothing in a clean vault", () => {
    const root = vault({
      "tasks/index.md": "# Tasks\n\n1. [[good]]\n",
      "tasks/good.md": task('title: "Good"\nstatus: open\npriority: high', "See [[notes/ref]] and ![[pic.png]]."),
      "tasks/bad-fields.md": task('title: "Bad"\nstatus: someday\npriority: urgent'),
      "tasks/waits.md": task('title: "Waits"\nstatus: open\npriority: low\nblocked_by:\n  - "[[ghost]]"'),
      "tasks/finished.md": task('title: "Done"\nstatus: done\npriority: low'),
      "notes/ref.md": "---\ntitle: Ref\ndescription: a value: with a colon\n---\nLinks to [[nowhere]] but not `[[in-code]]`.\n",
      "notes/pic.png": "png",
      "templates/task.md": "---\ntitle: {{title}}\nstatus: <% tp.x %>: y\n---\n[[template-link]]\n",
    });
    const r = examineVault(root);
    const got = r.problems.map((p) => `${p.check} ${p.note} ${p.detail}`);
    expect(got).toContain('task-fields tasks/bad-fields.md status "someday" is not one of open, in-progress, blocked, done');
    expect(got).toContain('task-fields tasks/bad-fields.md priority "urgent" is not one of low, medium, high');
    expect(got).toContain("link tasks/waits.md blocked_by names ghost, which does not exist");
    expect(got).toContain("link notes/ref.md [[nowhere]] points at nothing");
    expect(got).toContain("frontmatter notes/ref.md frontmatter is not valid YAML (tools skip this note)");
    expect(got).toContain("task-index tasks/index.md does not list bad-fields, which is not done");
    expect(got.some((g) => g.includes("finished"))).toBe(false);
    expect(got.some((g) => g.includes("templates/") || g.includes("in-code") || g.includes("pic.png"))).toBe(false);
    expect(r.problems.find((p) => p.check === "frontmatter")!.fixable).toBe(true);
    const clean = vault({ "tasks/index.md": "[[a]]\n", "tasks/a.md": task('title: "A"\nstatus: open\npriority: medium') });
    expect(examineVault(clean).problems).toEqual([]);
  });
  test("--fix repairs only frontmatter that quoting makes valid, and leaves the body alone", () => {
    const root = vault({ "a.md": "---\ntitle: A\ndescription: one: two\n---\nbody: stays\n", "b.md": "---\nbroken: [unclosed\n---\n" });
    expect(fixVault(root)).toEqual(["a.md"]);
    expect(readFileSync(join(root, "a.md"), "utf8")).toBe('---\ntitle: A\ndescription: "one: two"\n---\nbody: stays\n');
    expect(examineVault(root).problems.map((p) => p.note)).toEqual(["b.md"]);
    expect(quoteColonValues('title: "already: quoted"')).toBeNull();
  });
});
