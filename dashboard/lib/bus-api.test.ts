import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "bus-api-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { busPost, busRead } = await import("./bus-api.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});
const known = async (id: string) => ["alice", "architect"].includes(id);

describe("buses through the node (S3b)", () => {
  test("a hand-off lands on the other agent's bus, from the caller its token names", async () => {
    const r = await busPost("architect", { to: "alice", kind: "plan-ready", summary: "Plan  for pochteca\nis final", ref: "fleet/plans/x.md", ship: "pochteca", from: "someone-else", ts: "1999" }, known);
    expect(r.ok).toBe(true);
    const line = JSON.parse(readFileSync(join(inbox, "alice", "events.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ from: "architect", kind: "plan-ready", summary: "Plan for pochteca is final", ref: "fleet/plans/x.md", ship: "pochteca" });
    expect(line.ts).not.toBe("1999");
  });
  test("only to a known agent, not to itself, with a kind and a summary", async () => {
    expect((await busPost("architect", { to: "nobody", kind: "handoff", summary: "hello there" }, known)).message).toContain("No agent named nobody");
    expect((await busPost("architect", { to: "../alice", kind: "handoff", summary: "hello there" }, known)).ok).toBe(false);
    expect((await busPost("alice", { to: "alice", kind: "handoff", summary: "hello there" }, known)).message).toContain("your own bus");
    expect((await busPost("architect", { to: "alice", kind: "Bad Kind", summary: "hello there" }, known)).message).toContain("A kind");
    expect((await busPost("architect", { to: "alice", kind: "handoff", summary: "hi" }, known)).message).toContain("summary");
  });
  test("bus_read: the caller's own lines, after a time, newest last", async () => {
    const all = await busRead("alice");
    expect((all.events as unknown[]).length).toBe(1);
    const ts = String((all.events as { ts: string }[])[0]!.ts);
    expect(((await busRead("alice", ts)).events as unknown[]).length).toBe(0);
    expect(((await busRead("architect")).events as unknown[]).length).toBe(0);
  });
});
