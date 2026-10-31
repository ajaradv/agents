import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "mqueue-"));
const saved = { inbox: process.env.FLEET_INBOX, floor: process.env.FLEET_MEMORY_QUEUE_FLOOR, days: process.env.FLEET_MEMORY_QUEUE_DAYS };
process.env.FLEET_INBOX = join(tmp, "inbox");
delete process.env.FLEET_MEMORY_QUEUE_FLOOR;
delete process.env.FLEET_MEMORY_QUEUE_DAYS;
const q = await import("./memory-queue.ts");
const { acceptance, proposalReport } = await import("./memory-extract.ts");
const { _closeJournal, journalDb } = await import("./journal.ts");

afterAll(() => {
  _closeJournal();
  for (const [k, v] of [["FLEET_INBOX", saved.inbox], ["FLEET_MEMORY_QUEUE_FLOOR", saved.floor], ["FLEET_MEMORY_QUEUE_DAYS", saved.days]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
let n = 0;
function add(o: { label?: string; confidence?: number; days?: number; status?: string; target?: string | null; replaces?: string | null; quote?: string; agent?: string }): number {
  n++;
  const r = journalDb()
    .query("INSERT INTO memory_proposals (ts, agent, line_ts, quote, label, confidence, target, replaces, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), o.agent ?? "alice", ago(o.days ?? 1) + n, o.quote ?? `quote ${n}`, o.label ?? "preference", o.confidence ?? 0.9, o.target ?? null, o.replaces ?? null, o.status ?? "observed");
  return Number(r.lastInsertRowid);
}
const row = (id: number) => journalDb().query("SELECT * FROM memory_proposals WHERE id = ?").get(id) as Record<string, unknown>;
const sent: { to: string; from: string; text: string }[] = [];
const send = async (to: string, from: string, text: string) => void sent.push({ to, from, text });

beforeEach(() => {
  journalDb().exec("DELETE FROM memory_proposals");
  sent.length = 0;
});

describe("the queue", () => {
  test("queues strong recent observed proposals of the four labels, newest message first", () => {
    const keep = add({ label: "preference" });
    const keep2 = add({ label: "fact", days: 0.5 });
    add({ label: "task" });
    add({ label: "none" });
    add({ confidence: 0.79 });
    add({ days: 8 });
    add({ status: "approved" });
    add({ status: "dismissed" });
    expect(q.queuedProposals().map((p) => p.id)).toEqual([keep2, keep]);
  });
  test("the floor and the window are tunable", () => {
    add({ confidence: 0.6 });
    add({ days: 10 });
    process.env.FLEET_MEMORY_QUEUE_FLOOR = "0.5";
    process.env.FLEET_MEMORY_QUEUE_DAYS = "14";
    expect(q.queuedProposals().length).toBe(2);
    delete process.env.FLEET_MEMORY_QUEUE_FLOOR;
    delete process.env.FLEET_MEMORY_QUEUE_DAYS;
    expect(q.queuedProposals().length).toBe(0);
  });
});

describe("approve", () => {
  test("a preference goes to Alice as the memory sender with the quote, section, and bullet", async () => {
    const id = add({ quote: "Keep replies to two sentences.", target: "captain.md#Voice", replaces: "Keep replies short." });
    const r = await q.approveProposal(id, {}, send);
    expect(r.ok).toBe(true);
    expect(row(id)).toMatchObject({ status: "approved", captain_label: "preference" });
    expect(row(id).labelled_at).toBeTruthy();
    expect(sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ to: "alice", from: "memory" });
    expect(sent[0]!.text).toContain('"Keep replies to two sentences."');
    expect(sent[0]!.text).toContain("remember");
    expect(sent[0]!.text).toContain("captain.md › Voice");
    expect(sent[0]!.text).toContain('"Keep replies short."');
    expect(sent[0]!.text).toContain("one line");
    expect(q.queuedProposals().length).toBe(0);
  });
  test("a correction is written as a standing rule with remember", async () => {
    await q.approveProposal(add({ label: "correction", quote: "No, I said bun." }), {}, send);
    expect(sent[0]!.text).toContain("remember");
    expect(sent[0]!.text).toContain("standing rule");
  });
  test("a fact is written with fact_set and a source naming the chat and date", async () => {
    const id = add({ label: "fact", agent: "architect", target: "fact:hub.host", replaces: "12", quote: "The hub moved to fleet-hub-new." });
    await q.approveProposal(id, {}, send);
    const date = String(row(id).line_ts).slice(0, 10);
    expect(sent[0]!.text).toContain("fact_set");
    expect(sent[0]!.text).toContain(`source "captain in architect chat ${date}"`);
    expect(sent[0]!.text).toContain("hub.host");
  });
  test("a decision lets Alice choose where it goes", async () => {
    await q.approveProposal(add({ label: "decision", quote: "We drop the old dashboard." }), {}, send);
    expect(sent[0]!.text).toContain("fact_set");
    expect(sent[0]!.text).toContain("remember");
    expect(sent[0]!.text).toContain("vault_patch");
    expect(sent[0]!.text).toContain("Choose");
  });
  test("a relabel on approval sets the captain's label and the wording follows it", async () => {
    const id = add({ label: "decision" });
    await q.approveProposal(id, { label: "preference" }, send);
    expect(row(id).captain_label).toBe("preference");
    expect(sent[0]!.text).not.toContain("Choose");
    expect((await q.approveProposal(add({}), { label: "task" }, send)).ok).toBe(false);
  });
  test("approving twice posts once; a dismissed one cannot be approved", async () => {
    const id = add({});
    await Promise.all([q.approveProposal(id, {}, send), q.approveProposal(id, {}, send)]);
    expect(sent.length).toBe(1);
    const again = await q.approveProposal(id, {}, send);
    expect(again).toMatchObject({ ok: true, already: true });
    const d = add({});
    q.dismissProposal(d);
    expect((await q.approveProposal(d, {}, send)).ok).toBe(false);
    expect(sent.length).toBe(1);
    expect((await q.approveProposal(9999, {}, send)).ok).toBe(false);
  });
  test("a failed post puts the proposal back in the queue", async () => {
    const id = add({});
    const r = await q.approveProposal(id, {}, async () => {
      throw new Error("down");
    });
    expect(r.ok).toBe(false);
    expect(row(id)).toMatchObject({ status: "observed", captain_label: null });
    expect(q.queuedProposals().length).toBe(1);
  });
});

describe("dismiss", () => {
  test("labels none by default, or the relabel; posts nothing", () => {
    const a = add({});
    const b = add({});
    expect(q.dismissProposal(a).ok).toBe(true);
    expect(row(a)).toMatchObject({ status: "dismissed", captain_label: "none" });
    expect(row(a).labelled_at).toBeTruthy();
    q.dismissProposal(b, { label: "task" });
    expect(row(b)).toMatchObject({ status: "dismissed", captain_label: "task" });
    expect(q.dismissProposal(add({}), { label: "nonsense" }).ok).toBe(false);
    expect(sent.length).toBe(0);
  });
  test("twice is a no-op that keeps the first label", () => {
    const id = add({});
    q.dismissProposal(id, { label: "task" });
    expect(q.dismissProposal(id, { label: "fact" })).toMatchObject({ ok: true, already: true });
    expect(row(id).captain_label).toBe("task");
    expect(q.dismissProposal(9999).ok).toBe(false);
  });
});

describe("acceptance", () => {
  test("counts approved and dismissed overall, per label, and per confidence bucket", async () => {
    await q.approveProposal(add({ label: "preference", confidence: 0.95 }), {}, send);
    await q.approveProposal(add({ label: "preference", confidence: 0.85 }), {}, send);
    q.dismissProposal(add({ label: "preference", confidence: 0.85 }));
    q.dismissProposal(add({ label: "decision", confidence: 0.92 }));
    add({ label: "fact" });
    const a = proposalReport({ days: 7 }).acceptance;
    expect(a).toMatchObject({ approved: 2, dismissed: 2, rate: 0.5 });
    expect(a.perLabel.preference).toEqual({ approved: 2, dismissed: 1, rate: 0.67 });
    expect(a.perLabel.decision).toEqual({ approved: 0, dismissed: 1, rate: 0 });
    expect(a.perLabel.fact).toEqual({ approved: 0, dismissed: 0, rate: null });
    expect(a.buckets.find((b) => b.bucket === ">=0.9")).toMatchObject({ approved: 1, dismissed: 1 });
    expect(a.buckets.find((b) => b.bucket === "0.8-0.9")).toMatchObject({ approved: 1, dismissed: 1 });
    expect(acceptance([]).rate).toBeNull();
  });
});
