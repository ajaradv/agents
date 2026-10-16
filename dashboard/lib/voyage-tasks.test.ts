import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recentShipEvents } from "./ship-log.ts";
import { addTask, listTasks, taskProgress, updateTask } from "./voyage-tasks.ts";

describe("voyage tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "ship-"));
  test("add, assign, report, and progress", async () => {
    const a = await addTask("demo", { voyage: "/v.md", title: "Map the auth module", assignee: "demo-scout", createdBy: "demo-lead" }, { root });
    const b = await addTask("demo", { voyage: "/v.md", title: "Build the page", createdBy: "demo-lead" }, { root });
    expect(a.status).toBe("open");
    await updateTask("demo", a.id, { status: "done", note: "auth lives in core/auth.py", by: "demo-scout" }, { root });
    await updateTask("demo", b.id, { status: "blocked", note: "needs an API", by: "demo-lead" }, { root });
    const tasks = listTasks("demo", "/v.md", { root });
    expect(tasks.map((t) => t.status)).toEqual(["done", "blocked"]);
    expect(taskProgress(tasks)).toEqual({ done: 1, total: 2, blocked: 1 });
    expect(recentShipEvents("demo", 10, { root }).filter((e) => e.kind === "task")).toHaveLength(4);
    expect(listTasks("demo", "/other.md", { root })).toHaveLength(0);
  });
});
