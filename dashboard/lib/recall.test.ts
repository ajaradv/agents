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

describe("search log", () => {
  const rowsOf = () => r.recallDb().query("SELECT * FROM search_log ORDER BY id").all() as { ts: string; agent: string; tool: string; query: string; args: string; hits: number; refs: string }[];

  test("logSearch writes a row with canonical refs", () => {
    r.logSearch("alice", "vault_search", "gate", { type: "Plan", limit: 5 }, 3, ["./vault/fleet/plans/a.md#Gate", "vault/b.md", "c.md"]);
    r.logSearch("alice", "recall", "palette", {}, 1, ["chat:alice|alice captain|2026-10-01T00:00:00Z"]);
    const [v, c] = rowsOf().slice(-2);
    expect(v).toMatchObject({ agent: "alice", tool: "vault_search", query: "gate", hits: 3 });
    expect(JSON.parse(v!.args)).toEqual({ type: "Plan", limit: 5 });
    expect(JSON.parse(v!.refs)).toEqual(["fleet/plans/a.md", "b.md", "c.md"]);
    expect(Date.parse(v!.ts)).toBeGreaterThan(Date.now() - 5000);
    expect(JSON.parse(c!.refs)).toEqual(["chat:alice|alice captain|2026-10-01T00:00:00Z"]); // recall ids are kept as they are
    expect(r.recallRef({ source: "digest", ref: "/x/d.md", ts: "t" })).toBe("digest|/x/d.md|t");
  });

  test("logSearch keeps at most 10 refs", () => {
    r.logSearch("alice", "vault_search", "many", {}, 30, Array.from({ length: 15 }, (_, i) => `n${i}.md`));
    expect(JSON.parse(rowsOf().at(-1)!.refs)).toHaveLength(10);
  });

  test("the 90-day prune drops old rows only", () => {
    const d = r.recallDb();
    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    d.query("INSERT INTO search_log (ts, agent, tool, query, args, hits, refs) VALUES (?, 'alice', 'recall', 'ancient', '{}', 0, '[]')").run(old);
    expect(r.pruneSearchLog()).toBe(1);
    expect(rowsOf().some((x) => x.query === "ancient")).toBe(false);
    expect(rowsOf().some((x) => x.query === "many")).toBe(true);
  });

  test("ftsQueryStrict requires every word", () => {
    expect(r.ftsQueryStrict("jev gate")).toBe('"jev"* AND "gate"*');
    expect(r.ftsQuery("jev gate")).toBe('"jev"* OR "gate"*');
    expect(r.ftsQueryStrict("   ")).toBeNull();
  });
});

describe("logSearch on a closed database", () => {
  test("never throws", async () => {
    const j = await import("./journal.ts");
    j._closeJournal();
    process.env.FLEET_INBOX = "/nonexistent/path/for/closed-db";
    expect(() => r.logSearch("alice", "recall", "x", {}, 0, [])).not.toThrow();
    process.env.FLEET_INBOX = inbox;
  });
});
