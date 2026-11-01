import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "bus-api-"));
const vault = join(inbox, "vault");
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
mkdirSync(join(vault, "fleet/plans/feature"), { recursive: true });
const { busPost, busRead } = await import("./bus-api.ts");
const j = await import("./journal.ts");
afterAll(() => {
  j._closeJournal();
  for (const [k, v] of [["FLEET_INBOX", prev.inbox], ["ALICE_VAULT", prev.vault]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(inbox, { recursive: true, force: true });
});
const known = async (id: string) => ["alice", "architect"].includes(id);

describe("buses through the node (S3b)", () => {
  test("a hand-off lands on the other agent's bus, from the caller its token names", async () => {
    const r = await busPost("architect", { to: "alice", kind: "handoff", summary: "Plan  for pochteca\nis final", ref: "fleet/plans/x.md", ship: "pochteca", from: "someone-else", ts: "1999" }, known);
    expect(r.ok).toBe(true);
    const line = JSON.parse(readFileSync(join(inbox, "alice", "events.jsonl"), "utf8").trim());
    expect(line).toMatchObject({ from: "architect", kind: "handoff", summary: "Plan for pochteca is final", ref: "fleet/plans/x.md", ship: "pochteca" });
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
  test("the Architect's plan-ready is refused; other agents' kinds are unchanged", async () => {
    const r = await busPost("architect", { to: "alice", kind: "plan-ready", summary: "Plan for pochteca is final", ref: "fleet/plans/feature/p.md" }, known);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Plans don't sail");
    expect((await busPost("alice", { to: "architect", kind: "plan-ready", summary: "not the architect's to send" }, known)).ok).toBe(true);
    expect((await busPost("alice", { to: "architect", kind: "plan-draft", summary: "not from the architect" }, known)).ok).toBe(true);
  });
  test("a plan-draft needs a ref and a review the node recorded", async () => {
    const note = (review: string) => writeFileSync(join(vault, "fleet/plans/feature/p.md"), `---\ntitle: p\n${review}---\nbody\n`);
    const draft = (ref?: string) => busPost("architect", { to: "alice", kind: "plan-draft", summary: "Draft of the p plan", ...(ref ? { ref } : {}) }, known);
    expect((await draft()).message).toContain("needs ref");
    note("");
    expect((await draft("fleet/plans/feature/p.md")).message).toContain("no `review:`");
    // A review file the Architect wrote itself, with no record on the node, does not pass.
    mkdirSync(join(vault, "fleet/reviews/p"), { recursive: true });
    writeFileSync(join(vault, "fleet/reviews/p/review-1.md"), "### F1 — Nit: a\n\n## Resolution\nF1: fix — done\n");
    note("review: fleet/reviews/p/review-1.md\n");
    expect((await draft("fleet/plans/feature/p.md")).message).toContain("not a review the node wrote");
    j.upsertWorkflow("survey", "s-bus1", { by: "architect", mode: "review", target: "fleet/plans/feature/p.md", review: "fleet/reviews/p/review-1.md", ids: [1], depth: "light", counts: { Nit: 1 } }, { status: "done" });
    expect((await draft("fleet/plans/feature/p.md")).ok).toBe(true);
    const lines = readFileSync(join(inbox, "alice", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ kind: "plan-draft", ref: "fleet/plans/feature/p.md" });
    // An unavailable review is passed on with a note.
    j.upsertWorkflow("survey", "s-bus2", { by: "architect", mode: "review", target: "fleet/plans/feature/p.md", error: "no surveyor ran" }, { status: "failed" });
    note("review: unavailable\n");
    expect((await draft("fleet/plans/feature/p.md")).ok).toBe(true);
    const last = JSON.parse(readFileSync(join(inbox, "alice", "events.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(last.summary).toContain("not reviewed: no surveyor ran");
  });
});
