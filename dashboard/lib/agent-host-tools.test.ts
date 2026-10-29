import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "agent-host-tools-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const host = await import("./agent-host.ts");
const targets = await import("./chat-targets.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

describe("tools used in a turn", () => {
  test("land on the answer line, not the step lines, and reset each turn", async () => {
    await targets.refreshAgentTargets();
    const lines: { text: string; step?: boolean; tools?: string[] }[] = [];
    host.registerHostHooks({ line: (_id, l) => void lines.push(l), event: () => {}, settled: () => {} });
    const p = { id: "alice", running: false, streamText: "", toolArgs: new Map(), turnTools: [] as string[], turnCost: 0, turnTokens: 0, turnCacheRead: 0, turnPrompt: 0, dialogs: new Map() } as never;
    const rec = (r: Record<string, unknown>) => host.onRecord(p, r);
    const say = (text: string, stopReason: string) => rec({ type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
    const run = async (n: number) => {
      await rec({ type: "agent_start" });
      await rec({ type: "tool_execution_start", toolCallId: `a${n}`, toolName: "codemode", args: { code: "await tools.vault_tasks({}); await tools.fleet_query({});" } });
      await say("looking", "toolUse");
      await rec({ type: "tool_execution_start", toolCallId: `b${n}`, toolName: "bash", args: { command: "ls" } });
      await say("done", "stop");
    };
    await run(1);
    expect(lines.map((l) => [l.text, l.step ?? false, l.tools])).toEqual([["looking", true, undefined], ["done", false, ["vault_tasks", "fleet_query", "bash"]]]);
    const saved = readFileSync(join(inbox, "alice", "captain-chat.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tools?: string[] });
    expect(saved.map((l) => l.tools)).toEqual([undefined, ["vault_tasks", "fleet_query", "bash"]]);
    // The next turn starts clean and a tool-free answer carries no field.
    (p as { running: boolean }).running = false;
    lines.length = 0;
    await rec({ type: "agent_start" });
    await say("no tools", "stop");
    expect(lines[0]!.tools).toBeUndefined();
  });
});
