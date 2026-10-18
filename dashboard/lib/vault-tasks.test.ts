import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkName, readVaultTasks, vaultTasksReport } from "./vault-tasks.ts";

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
});
