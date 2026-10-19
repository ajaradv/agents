import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { recentShipEvents, shipDb } from "./ship-log.ts";
import { addTask, blockersRefusal, claimTask, getTask, listTasks, parseIds, readyTasks, taskProgress, unblockedBy, updateTask, waitingOn } from "./voyage-tasks.ts";

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
  test("dependencies: waiting, ready, and release when a blocker is done", async () => {
    const v = "/deps.md";
    const recon = await addTask("demo", { voyage: v, title: "Recon the API", assignee: "demo-scout", createdBy: "demo-lead" }, { root });
    const build = await addTask("demo", { voyage: v, title: "Build the page", assignee: "demo-designer", blockedBy: [recon.id], createdBy: "demo-lead" }, { root });
    const docs = await addTask("demo", { voyage: v, title: "Write docs", blockedBy: [recon.id, build.id], createdBy: "demo-lead" }, { root });
    expect(getTask("demo", build.id, { root })!.blockedBy).toEqual([recon.id]);
    let all = listTasks("demo", v, { root });
    expect(waitingOn(all.find((t) => t.id === docs.id)!, all)).toEqual([recon.id, build.id]);
    expect(readyTasks(all).map((t) => t.id)).toEqual([recon.id]);
    await updateTask("demo", recon.id, { status: "done", by: "demo-scout" }, { root });
    expect(unblockedBy("demo", v, recon.id, { root }).map((t) => t.id)).toEqual([build.id]);
    all = listTasks("demo", v, { root });
    expect(readyTasks(all).map((t) => t.id)).toEqual([build.id]);
    await updateTask("demo", build.id, { status: "done", by: "demo-designer" }, { root });
    expect(unblockedBy("demo", v, build.id, { root }).map((t) => t.id)).toEqual([docs.id]);
  });
  test("blockers must exist on the voyage, and no loops", async () => {
    const v = "/loops.md";
    const a = await addTask("demo", { voyage: v, title: "A task", createdBy: "demo-lead" }, { root });
    const b = await addTask("demo", { voyage: v, title: "B task", blockedBy: [a.id], createdBy: "demo-lead" }, { root });
    const c = await addTask("demo", { voyage: v, title: "C task", blockedBy: [b.id], createdBy: "demo-lead" }, { root });
    const all = listTasks("demo", v, { root });
    expect(blockersRefusal(all, [a.id])).toBeNull();
    expect(blockersRefusal(all, [9999])).toContain("no task #9999");
    expect(blockersRefusal(all, [a.id], a.id)).toContain("itself");
    expect(blockersRefusal(all, [c.id], a.id)).toContain("loop");
    expect(blockersRefusal(all, [b.id], c.id)).toBeNull();
    expect(parseIds("#3, 4 4,x,-1")).toEqual([3, 4]);
    expect(parseIds([2, "5", 0])).toEqual([2, 5]);
  });
  test("claim: one step, only when ready and free", async () => {
    const v = "/claim.md";
    const first = await addTask("demo", { voyage: v, title: "First step", createdBy: "demo-lead" }, { root });
    const second = await addTask("demo", { voyage: v, title: "Second step", blockedBy: [first.id], createdBy: "demo-lead" }, { root });
    expect(await claimTask("demo", second.id, "demo-scout", { root })).toEqual({ refusal: `Task #${second.id} still waits on #${first.id}.` });
    const won = await claimTask("demo", first.id, "demo-scout", { root });
    expect("task" in won && won.task.status === "working" && won.task.assignee === "demo-scout").toBe(true);
    expect(await claimTask("demo", first.id, "demo-designer", { root })).toEqual({ refusal: `Task #${first.id} is demo-scout's.` });
    expect(await claimTask("demo", first.id, "demo-scout", { root })).toEqual({ refusal: `Task #${first.id} is working, not open.` });
  });
  test("a task for a role: only that role can claim it", async () => {
    const t = await addTask("demo", { voyage: "/roles.md", title: "UI refresh", role: "designer", createdBy: "demo-lead" }, { root });
    expect(getTask("demo", t.id, { root })!.role).toBe("designer");
    expect(await claimTask("demo", t.id, "demo-scout", { root })).toEqual({ refusal: `Task #${t.id} is for the designer.` });
    const won = await claimTask("demo", t.id, "demo-designer", { root });
    expect("task" in won && won.task.assignee === "demo-designer").toBe(true);
  });
  test("an old ship database gains the blocked_by column", () => {
    const old = mkdtempSync(join(tmpdir(), "ship-old-"));
    mkdirSync(join(old, "ships", "legacy"), { recursive: true });
    const raw = new Database(join(old, "ships", "legacy", "ship.db"), { create: true });
    raw.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, voyage TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', assignee TEXT, kind TEXT NOT NULL DEFAULT 'crew', adw_id TEXT, status TEXT NOT NULL DEFAULT 'open', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    raw.exec("INSERT INTO tasks (voyage, title, created_by, created_at, updated_at) VALUES ('/v.md', 'Old task', 'x-lead', 'now', 'now')");
    raw.close();
    shipDb("legacy", old);
    const t = listTasks("legacy", "/v.md", { root: old });
    expect(t[0]!.blockedBy).toEqual([]);
    expect(t[0]!.role).toBeNull();
  });
});
