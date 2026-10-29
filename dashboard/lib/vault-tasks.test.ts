import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doneWhen, dueTasks, linkName, readVaultTasks, vaultNextSteps, vaultTasksReport } from "./vault-tasks.ts";

function vault(notes: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  mkdirSync(join(root, "tasks"));
  for (const [name, fm] of Object.entries(notes)) writeFileSync(join(root, "tasks", `${name}.md`), `---\n${fm}\n---\n\n# Task\n`);
  return root;
}

describe("vault tasks", () => {
  const root = vault({
    index: "type: Index",
    recon: 'type: Task\ntitle: "Recon"\nstatus: done\npriority: high\ntimestamp: 2026-10-01T00:00:00Z',
    build: 'type: Task\ntitle: "Build"\nstatus: open\npriority: low\nblocked_by:\n  - "[[recon]]"\ntimestamp: 2026-10-02T00:00:00Z',
    ship: 'type: Task\ntitle: "Ship"\nstatus: open\npriority: high\nblocked_by: [[build]]\ntimestamp: 2026-10-03T00:00:00Z',
    lost: 'type: Task\ntitle: "Lost"\nstatus: open\nblocked_by: ["[[nowhere]]"]',
    doing: 'type: Task\ntitle: "Doing"\nstatus: in-progress',
    broken: "type: Task\ntitle: Broken\ndescription: a value: with a colon\nstatus: open",
    idea: "type: Idea\ntitle: not a task",
  });

  test("reads task notes only, and names the ones that do not parse", () => {
    const { tasks, unreadable } = readVaultTasks(root);
    expect(tasks.map((t) => t.id).sort()).toEqual(["build", "doing", "lost", "recon", "ship"]);
    expect(unreadable).toEqual(["tasks/broken.md"]);
    expect(tasks.find((t) => t.id === "ship")!.blockedBy).toEqual(["build"]);
  });
  test("ready: open and waiting on nothing; a missing note is said, not ignored", () => {
    const r = vaultTasksReport("ready", "", root);
    expect((r.tasks as { id: string }[]).map((t) => t.id)).toEqual(["build"]);
    expect(r.message).toContain("3 open (1 ready, 2 waiting), 1 in progress");
    expect(r.unreadable).toEqual(["tasks/broken.md"]);
    const blocked = vaultTasksReport("blocked", "", root).tasks as { id: string; waitingOn: string[] }[];
    expect(blocked.find((t) => t.id === "ship")!.waitingOn).toEqual(["build"]);
    expect(blocked.find((t) => t.id === "lost")!.waitingOn).toEqual(["nowhere (no such note)"]);
  });
  test("one task's detail: what it waits on and what it blocks", () => {
    const r = vaultTasksReport("ready", "[[build]]", root);
    expect(r.task).toMatchObject({ id: "build", waitingOn: [], blocks: ["ship"] });
    expect(vaultTasksReport("ready", "nope", root).ok).toBe(false);
  });
  test("link names", () => {
    expect(linkName("[[a-b|label]]")).toBe("a-b");
    expect(linkName("tasks/x.md")).toBe("x");
  });
  test("due tasks: on or before today, not done; dates in either form", () => {
    const v = vault({
      soon: 'type: Task\ntitle: "Review the gate"\nstatus: open\ndue: 2026-10-25',
      late: "type: Task\ntitle: Late\nstatus: in-progress\ndue: 2026-10-01",
      finished: "type: Task\ntitle: Finished\nstatus: done\ndue: 2026-10-01",
      undated: "type: Task\ntitle: Undated\nstatus: open\ndue:",
    });
    expect(dueTasks("2026-10-24", v).map((t) => t.id)).toEqual(["late"]);
    expect(dueTasks("2026-10-25", v).map((t) => t.id).sort()).toEqual(["late", "soon"]);
  });
});

describe("next steps", () => {
  const body = [
    "# Why",
    "- [ ] stale idea",
    "## Done when",
    "- [x] first",
    "- [ ] **bold** see [[some-note|the note]] and [[plain-link]]",
    "- [ ] " + "x".repeat(200),
    "### Detail",
    "- [ ] nested still counts",
    "## Later",
    "- [ ] other",
  ].join("\n");

  test("doneWhen: section bounds, counts, cleanup, truncation", () => {
    const d = doneWhen(body);
    expect(d.done).toBe(1);
    expect(d.otherOpen).toBe(2);
    expect(d.open.length).toBe(3);
    expect(d.open[0]).toBe("bold see the note and plain-link");
    expect(d.open[1]!.length).toBe(160);
    expect(d.open[1]!.endsWith("…")).toBe(true);
    expect(d.open[2]).toBe("nested still counts");
    expect(doneWhen("# done WHEN\n- [ ] a\n# Next\n- [ ] b")).toEqual({ open: ["a"], done: 0, otherOpen: 1 });
    expect(doneWhen("no checklist")).toEqual({ open: [], done: 0, otherOpen: 0 });
  });

  function withBodies(notes: Record<string, [string, string]>): string {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    mkdirSync(join(root, "tasks"));
    for (const [name, [fm, text]] of Object.entries(notes)) writeFileSync(join(root, "tasks", `${name}.md`), `---\n${fm}\n---\n\n${text}\n`);
    return root;
  }
  const root = withBodies({
    low: ["type: Task\ntitle: Low\nstatus: open\npriority: low", "# Done when\n- [ ] l1"],
    hi: ['type: Task\ntitle: Hi\nstatus: open\npriority: high\ndue: 2026-11-01\nblocked_by: ["[[low]]", "[[ghost]]"]', "# Done when\n- [x] a\n- [ ] b\n\n# Old\n- [ ] stale"],
    sealed: ["type: Task\ntitle: Sealed\nstatus: in-progress\npriority: medium", "# Done when\n- [x] a\n- [x] b"],
    bare: ["type: Task\ntitle: Bare\nstatus: in-progress\npriority: medium", "no checklist"],
    finished: ["type: Task\ntitle: Finished\nstatus: done", "# Done when\n- [ ] ignored"],
  });

  test("vaultNextSteps: active tasks in priority order with steps, waits, and closeable", () => {
    const r = vaultNextSteps(root);
    const tasks = r.tasks as { id: string; [k: string]: unknown }[];
    expect(tasks.map((t) => t.id)).toEqual(["hi", "bare", "sealed", "low"]);
    expect(tasks[0]).toEqual({ id: "hi", status: "open", priority: "high", due: "2026-11-01", waitingOn: ["low", "ghost (no such note)"], progress: "1/2", next: ["b"], otherOpen: 1 });
    expect(tasks.find((t) => t.id === "sealed")).toMatchObject({ closeable: true, progress: "2/2", next: [] });
    expect(tasks.find((t) => t.id === "bare")!.closeable).toBeUndefined();
    expect(r.message).toBe("4 active tasks, 2 open steps; 1 looks closeable (all Done-when items checked): sealed");
    expect(r.unreadable).toBeUndefined();
  });
});
