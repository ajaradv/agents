import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveEndedTaskThreads, CHAT_ID_RE, TASK_MARKER } from "./chat-targets.ts";

describe("CHAT_ID_RE", () => {
  test("accepts agent and task ids, refuses paths", () => {
    expect(CHAT_ID_RE.test("alice")).toBe(true);
    expect(CHAT_ID_RE.test("kinwork-stack-plan")).toBe(true);
    expect(CHAT_ID_RE.test("../etc")).toBe(false);
    expect(CHAT_ID_RE.test("a/b")).toBe(false);
    expect(CHAT_ID_RE.test("x'y")).toBe(false);
  });
});

describe("archiveEndedTaskThreads", () => {
  test("moves only ended task threads", async () => {
    const root = await mkdtemp(join(tmpdir(), "inbox-"));
    const prev = process.env.FLEET_INBOX;
    process.env.FLEET_INBOX = root;
    try {
      for (const id of ["alice", "live-task", "ended-task"]) await mkdir(join(root, id));
      await writeFile(join(root, "live-task", TASK_MARKER), "");
      await writeFile(join(root, "ended-task", TASK_MARKER), "");
      const moved = await archiveEndedTaskThreads(new Set(["alice", "live-task"]));
      expect(moved).toEqual(["ended-task"]);
      const left = (await readdir(root)).sort();
      expect(left).toEqual(["alice", "archive", "live-task"]);
      const archived = await readdir(join(root, "archive"));
      expect(archived[0]).toMatch(/^ended-task-\d{4}-\d{2}-\d{2}$/);
    } finally {
      if (prev === undefined) delete process.env.FLEET_INBOX;
      else process.env.FLEET_INBOX = prev;
    }
  });
});
