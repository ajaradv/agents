import { describe, expect, test } from "bun:test";
import { agentSaid, looksAtVault, staleTaskMentions, toolUsed, turnEnded, turnStarted } from "./fact-check.ts";
import type { VaultTask } from "./vault-tasks.ts";

const task = (id: string, status: string): VaultTask => ({ id, title: id, status, priority: "high", plan: "", blockedBy: [], timestamp: "", description: "", due: "" });
const tasks = [task("fleet-tool-failure-log", "done"), task("fleet-observe-reviews", "open"), task("fleet-firstmate-analysis", "dropped")];

describe("fact check on vault answers", () => {
  test("names of closed tasks are found, open ones and partial words are not", () => {
    expect(staleTaskMentions("`fleet-tool-failure-log` — it's high-priority", tasks).map((t) => t.id)).toEqual(["fleet-tool-failure-log"]);
    expect(staleTaskMentions("pick [[fleet-firstmate-analysis]] or fleet-observe-reviews", tasks).map((t) => t.id)).toEqual(["fleet-firstmate-analysis"]);
    expect(staleTaskMentions("fleet-tool-failure-logger is new", tasks)).toEqual([]);
  });
  test("the 2026-10-19 answer gets a note; looking first, or saying it is done, does not", () => {
    turnStarted("alice");
    agentSaid("alice", "`fleet-tool-failure-log` — it's high-priority and it kills two birds.");
    expect(turnEnded("alice", () => tasks)).toContain("Call vault_tasks");
    turnStarted("alice");
    toolUsed("alice", "vault_tasks ready");
    agentSaid("alice", "`fleet-tool-failure-log` — it's high-priority.");
    expect(turnEnded("alice", () => tasks)).toBeNull();
    turnStarted("alice");
    agentSaid("alice", "`fleet-tool-failure-log` is already done; next is fleet-observe-reviews.");
    expect(turnEnded("alice", () => tasks)).toBeNull();
  });
  test("only Alice is checked, and tool names that read the vault count as looking", () => {
    turnStarted("fleet-lead");
    agentSaid("fleet-lead", "`fleet-tool-failure-log`");
    expect(turnEnded("fleet-lead", () => tasks)).toBeNull();
    expect(looksAtVault("read: /Users/x/Workspace/brain/tasks/fleet-observe-reviews.md")).toBe(true);
    expect(looksAtVault("fleet_status")).toBe(true);
    expect(looksAtVault("bash: ls")).toBe(false);
  });
});
