import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "recall-inbox-"));
const vault = mkdtempSync(join(tmpdir(), "recall-vault-"));
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
const r = await import("./recall.ts");
afterAll(() => {
  if (prev.inbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev.inbox;
  if (prev.vault === undefined) delete process.env.ALICE_VAULT;
  else process.env.ALICE_VAULT = prev.vault;
});

const chat = (agent: string, from: string, text: string) => {
  mkdirSync(join(inbox, agent), { recursive: true });
  appendFileSync(join(inbox, agent, "captain-chat.jsonl"), JSON.stringify({ ts: new Date().toISOString(), from, text }) + "\n");
};

describe("recall", () => {
  test("finds chat lines, helper results, and digests; indexes only what is new", () => {
    chat("alice", "captain", "Keep Kinwork's palette warm, no neon greens.");
    chat("architect", "architect", "The journal lives in SQLite with WAL mode.");
    mkdirSync(join(inbox, "alice", "delegations", "d1"), { recursive: true });
    writeFileSync(join(inbox, "alice", "delegations", "d1", "result.md"), "Lineage Atria has three ADWs: plan, build, review.");
    mkdirSync(join(vault, "fleet", "digests"), { recursive: true });
    writeFileSync(join(vault, "fleet", "digests", "2026-10-15.md"), "Morning digest: the scout finished recon on pochteca.");
    expect(r.indexRecall()).toBe(4);
    expect(r.indexRecall()).toBe(0);
    expect(r.recall("palette")[0]!.source).toBe("chat:alice");
    expect(r.recall("ADWs")[0]!.source).toBe("helper");
    expect(r.recall("pochteca")[0]!.source).toBe("digest");
    expect(r.recall("\"WAL mode\"")[0]!.snippet).toContain("«WAL mode»");
    chat("alice", "alice", "Palette noted in the captain profile.");
    expect(r.recall("palette").length).toBe(2);
  });
  test("prefix matching, and nothing for empty or junk queries", () => {
    expect(r.recall("journ").length).toBeGreaterThan(0);
    expect(r.recall("")).toEqual([]);
    expect(r.recall("\"")).toEqual([]);
    expect(r.recall("zzzunfindable")).toEqual([]);
  });
});
