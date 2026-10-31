import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "proactive-"));
const saved = { inbox: process.env.FLEET_INBOX, mode: process.env.FLEET_PROACTIVE, rep: process.env.FLEET_PROACTIVE_REPEAT_DAYS };
process.env.FLEET_INBOX = join(tmp, "inbox");
delete process.env.FLEET_PROACTIVE;
delete process.env.FLEET_PROACTIVE_REPEAT_DAYS;
const p = await import("./proactive.ts");
const { _closeJournal, journalDb } = await import("./journal.ts");

afterAll(() => {
  _closeJournal();
  for (const [k, v] of [["FLEET_INBOX", saved.inbox], ["FLEET_PROACTIVE", saved.mode], ["FLEET_PROACTIVE_REPEAT_DAYS", saved.rep]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const now = new Date(2026, 9, 30, 12, 0, 0); // local noon, 2026-10-30
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const input = (o: Partial<import("./proactive.ts").SweepInput> = {}) => ({ now, tasks: [], steps: [], facts: [], observations: [], ...o });
const task = (id: string, o: { status?: string; due?: string; modified?: Date | null } = {}) => ({ id, title: id, status: o.status ?? "open", due: o.due ?? "", modified: o.modified === undefined ? ago(1) : o.modified });

beforeEach(() => journalDb().exec("DELETE FROM proactive_raised; DELETE FROM proactive_items"));

describe("findings", () => {
  test("due: within 2 days or overdue, open or in progress only", () => {
    const f = p.computeFindings(input({ tasks: [task("late", { due: "2026-10-28" }), task("today", { due: "2026-10-30" }), task("soon", { due: "2026-11-01" }), task("far", { due: "2026-11-02" }), task("done", { due: "2026-10-01", status: "done" })] }));
    expect(f.map((x) => x.key)).toEqual(["late", "soon", "today"].sort((a, b) => (a === "late" ? -1 : b === "late" ? 1 : a.localeCompare(b))));
    expect(f[0]!.summary).toBe("late is overdue since 2026-10-28");
    expect(f.find((x) => x.key === "today")!.summary).toBe("today is due today");
  });
  test("closeable comes from the steps", () => {
    const f = p.computeFindings(input({ steps: [{ id: "a", closeable: true, progress: "3/3" }, { id: "b", progress: "1/2" }] }));
    expect(f.map((x) => [x.kind, x.key, x.fingerprint])).toEqual([["closeable", "a", "closeable:a:3/3"]]);
  });
  test("stale task: in progress and untouched for over 21 days", () => {
    const f = p.computeFindings(input({ tasks: [task("old", { status: "in-progress", modified: ago(25) }), task("fresh", { status: "in-progress", modified: ago(20) }), task("open-old", { modified: ago(40) }), task("nodate", { status: "in-progress", modified: null })] }));
    expect(f.map((x) => [x.kind, x.key])).toEqual([["stale-task", "old"]]);
    expect(f[0]!.summary).toContain("25 days");
    process.env.FLEET_PROACTIVE_STALE_DAYS = "10";
    expect(p.computeFindings(input({ tasks: [task("fresh", { status: "in-progress", modified: ago(20) })] }))).toHaveLength(1);
    delete process.env.FLEET_PROACTIVE_STALE_DAYS;
  });
  test("stale task: skipped while it waits on something", () => {
    const tasks = [task("parked", { status: "in-progress", modified: ago(40) }), task("free", { status: "in-progress", modified: ago(40) })];
    const f = p.computeFindings(input({ tasks, steps: [{ id: "parked", progress: "0/1", waitingOn: ["other"] }, { id: "free", progress: "0/1" }] }));
    expect(f.map((x) => x.key)).toEqual(["free"]);
  });
  test("stale fact: current facts older than 60 days", () => {
    const f = p.computeFindings(input({ facts: [{ subject: "hub", key: "host", since: ago(61).toISOString() }, { subject: "hub", key: "model", since: ago(59).toISOString() }] }));
    expect(f.map((x) => [x.kind, x.key])).toEqual([["stale-fact", "hub.host"]]);
  });
  test("expiring observation: open and expiring within 2 days, not already gone", () => {
    const at = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
    const f = p.computeFindings(input({ observations: [{ id: 1, text: "soon", expires: at(1) }, { id: 2, text: "later", expires: at(5) }, { id: 3, text: "gone", expires: at(-1) }] }));
    expect(f.map((x) => [x.kind, x.key])).toEqual([["expiring-observation", "1"]]);
  });
  test("most urgent first: overdue, due, closeable, expiring, stale task, stale fact", () => {
    const f = p.computeFindings(input({
      tasks: [task("t1", { status: "in-progress", modified: ago(30) }), task("t2", { due: "2026-10-31" }), task("t3", { due: "2026-10-01" })],
      steps: [{ id: "c", closeable: true, progress: "2/2" }],
      facts: [{ subject: "a", key: "b", since: ago(90).toISOString() }],
      observations: [{ id: 9, text: "x", expires: new Date(now.getTime() + 3_600_000).toISOString() }],
    }));
    expect(f.map((x) => x.kind)).toEqual(["due", "due", "closeable", "expiring-observation", "stale-task", "stale-fact"]);
    expect(f[0]!.key).toBe("t3");
  });
  test("fingerprints are stable and change with the value", () => {
    const a = p.computeFindings(input({ tasks: [task("x", { due: "2026-10-31" })] }))[0]!.fingerprint;
    expect(p.computeFindings(input({ tasks: [task("x", { due: "2026-10-31" })] }))[0]!.fingerprint).toBe(a);
    expect(a).toBe("due:x:2026-10-31");
    expect(p.computeFindings(input({ tasks: [task("x", { due: "2026-10-30" })] }))[0]!.fingerprint).not.toBe(a);
    expect(p.computeFindings(input({ steps: [{ id: "c", closeable: true, progress: "3/3" }] }))[0]!.fingerprint).not.toBe(p.computeFindings(input({ steps: [{ id: "c", closeable: true, progress: "4/4" }] }))[0]!.fingerprint);
  });
});

describe("dedupe and feedback", () => {
  const fs = () => p.computeFindings(input({ tasks: [task("x", { due: "2026-10-31" })] }));
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);

  test("new once, quiet inside the repeat window, raised again after it", () => {
    expect(p.judge(fs(), now)[0]).toMatchObject({ raise: true, why: "new" });
    p.markRaised(fs(), now);
    expect(p.judge(fs(), day(3))[0]!.raise).toBe(false);
    expect(p.judge(fs(), day(7))[0]).toMatchObject({ raise: true });
    p.markRaised(fs(), day(7));
    expect(journalDb().query("SELECT times FROM proactive_raised").get()).toEqual({ times: 2 });
  });
  test("FLEET_PROACTIVE_REPEAT_DAYS moves the window", () => {
    process.env.FLEET_PROACTIVE_REPEAT_DAYS = "2";
    p.markRaised(fs(), now);
    expect(p.judge(fs(), day(2))[0]!.raise).toBe(true);
    delete process.env.FLEET_PROACTIVE_REPEAT_DAYS;
  });
  test("a changed value is a new finding", () => {
    p.markRaised(fs(), now);
    const moved = p.computeFindings(input({ tasks: [task("x", { due: "2026-10-30" })] }));
    expect(p.judge(moved, now)[0]!.raise).toBe(true);
  });
  test("nothing is raised while snoozed, and again once the snooze ends", () => {
    expect(p.giveFeedback("x", { snooze: 3 }, now, fs())).toBe(1);
    expect(p.judge(fs(), day(2))[0]).toMatchObject({ raise: false, why: "snoozed until 2026-11-02" });
    expect(p.judge(fs(), day(4))[0]).toMatchObject({ raise: true, why: "snooze ended" });
  });
  test("snooze by fingerprint, and done holds past the repeat window", () => {
    expect(p.giveFeedback("due:x:2026-10-31", { snooze: 1 }, now, fs())).toBe(1);
    expect(p.giveFeedback("nope", "done", now, fs())).toBe(0);
    p.giveFeedback("x", "done", now, fs());
    expect(p.judge(fs(), day(30))[0]).toMatchObject({ raise: false, why: "marked done" });
  });
});

describe("the sweep", () => {
  let vault = "";
  const sent: { to: string; from: string; text: string }[] = [];
  const send = async (to: string, from: string, text: string) => void sent.push({ to, from, text });
  beforeEach(() => {
    sent.length = 0;
    vault = mkdtempSync(join(tmp, "vault-"));
    mkdirSync(join(vault, "tasks"));
    process.env.ALICE_VAULT = vault;
    writeFileSync(join(vault, "tasks", "late.md"), "---\ntype: Task\ntitle: Late\nstatus: open\ndue: 2026-10-20\n---\n");
    writeFileSync(join(vault, "tasks", "done-it.md"), "---\ntype: Task\ntitle: Done it\nstatus: in-progress\n---\n\n## Done when\n- [x] a\n- [x] b\n");
    writeFileSync(join(vault, "tasks", "dusty.md"), "---\ntype: Task\ntitle: Dusty\nstatus: in-progress\n---\n\n## Done when\n- [ ] a\n");
    const old = ago(30);
    utimesSync(join(vault, "tasks", "dusty.md"), old, old);
  });
  afterAll(() => delete process.env.ALICE_VAULT);

  test("the note's last change is its mtime or frontmatter updated, whichever is later", () => {
    const f = p.computeFindings(p.gatherInput(now, vault));
    expect(f.filter((x) => x.kind === "stale-task").map((x) => x.key)).toEqual(["dusty"]);
    writeFileSync(join(vault, "tasks", "dusty.md"), `---\ntype: Task\ntitle: Dusty\nstatus: in-progress\nupdated: ${ago(2).toISOString()}\n---\n`);
    utimesSync(join(vault, "tasks", "dusty.md"), ago(30), ago(30));
    expect(p.computeFindings(p.gatherInput(now, vault)).some((x) => x.kind === "stale-task")).toBe(false);
  });
  test("observe (the default) reports and sends nothing, marks nothing", async () => {
    expect(p.proactiveMode()).toBe("observe");
    const note = await p.runSweep(send, now);
    expect(note).toStartWith("observe: 3 findings, 3 would be raised");
    expect(sent).toEqual([]);
    expect(journalDb().query("SELECT COUNT(*) AS n FROM proactive_raised").get()).toEqual({ n: 0 });
  });
  test("on: one line to alice from proactive, then the same findings stay quiet", async () => {
    const note = await p.runSweep(send, now, "on");
    expect(note).toBe("3 findings, 3 sent to alice");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "alice", from: "proactive" });
    const lines = sent[0]!.text.split("\n").filter((l) => /^p\d+\. /.test(l));
    expect(lines.map((l) => l.split("]")[0])).toEqual(["p1. [due", "p2. [closeable", "p3. [stale-task"]);
    expect(sent[0]!.text).toContain("proactive_report");
    expect(sent[0]!.text).toContain("notify_captain");
    expect(sent[0]!.text).toContain("Change nothing yourself");
    expect(await p.runSweep(send, now, "on")).toBe("3 findings, nothing new");
    expect(sent).toHaveLength(1);
  });
  test("a failed send marks nothing, so the next sweep tries again", async () => {
    await expect(p.runSweep(async () => { throw new Error("no host"); }, now, "on")).rejects.toThrow("no host");
    expect(journalDb().query("SELECT COUNT(*) AS n FROM proactive_raised").get()).toEqual({ n: 0 });
  });
  test("off does nothing; more than 8 wait for the next sweep", async () => {
    expect(await p.runSweep(send, now, "off")).toStartWith("skipped:");
    for (let i = 0; i < 10; i++) writeFileSync(join(vault, "tasks", `d${i}.md`), "---\ntype: Task\ntitle: D\nstatus: open\ndue: 2026-10-01\n---\n");
    expect(await p.runSweep(send, now, "on")).toBe("13 findings, 8 sent to alice (5 more tomorrow)");
    expect(sent[0]!.text.split("\n").filter((l) => /^p\d+\. /.test(l))).toHaveLength(8);
  });
  test("the mode reads FLEET_PROACTIVE", () => {
    for (const [v, m] of [["on", "on"], ["OFF", "off"], ["observe", "observe"], ["bogus", "observe"]] as const) {
      process.env.FLEET_PROACTIVE = v;
      expect(p.proactiveMode()).toBe(m);
    }
    delete process.env.FLEET_PROACTIVE;
  });
});

describe("migration", () => {
  test("journal.db has proactive_raised and proactive_items at schema version 7", () => {
    const cols = (journalDb().query("PRAGMA table_info(proactive_raised)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["fingerprint", "kind", "key", "first_raised", "last_raised", "times", "status", "snoozed_until"]);
    expect((journalDb().query("PRAGMA user_version").get() as { user_version: number }).user_version).toBeGreaterThanOrEqual(7);
  });
});

describe("proposals", () => {
  const sent: { to: string; from: string; text: string }[] = [];
  const send = async (to: string, from: string, text: string) => void sent.push({ to, from, text });
  const fnd = (key: string, due = "2026-10-31") => ({ kind: "due" as const, key, summary: `${key} is due ${due}`, fingerprint: `due:${key}:${due}`, rank: 1 });
  const rows = () => journalDb().query("SELECT * FROM proactive_items ORDER BY id").all() as import("./proactive.ts").ItemRow[];
  const raised = (...keys: string[]) => p.markRaised(keys.map((k) => fnd(k)), now);
  beforeEach(() => (sent.length = 0));

  test("short ids map back to the sweep's findings", () => {
    raised("a", "b");
    expect(rows().map((r) => [r.short_id, r.key])).toEqual([["p1", "a"], ["p2", "b"]]);
    expect(p.aliceLine([fnd("a"), fnd("b")])).toContain("p2. [due] b is due");
  });
  test("proactive_report stores proposals against the latest line and shows them open", () => {
    raised("a", "b");
    const r = p.proactiveReport([{ id: "p1", proposal: "Chase a." }, { id: "P2", proposal: "Close b." }, { id: "p9", proposal: "x" }, { id: "p1", proposal: "" }], [], now);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("2 proposals shown");
    expect(r.message).toContain("p9: not in the latest sweep line");
    expect(p.openProposals().map((x) => x.proposal)).toEqual(["Chase a.", "Close b."]);
    // A later line replaces the mapping: p1 now means another finding.
    p.markRaised([fnd("c")], new Date(now.getTime() + 1000));
    expect(p.proactiveReport([{ id: "p1", proposal: "Chase c." }], [], now).ok).toBe(true);
    expect(rows().find((x) => x.key === "c")!.proposal).toBe("Chase c.");
    expect(rows().find((x) => x.key === "a")!.proposal).toBe("Chase a.");
    expect(p.proactiveReport([{ id: "p7", proposal: "x" }]).ok).toBe(false);
  });
  test("dropped items are marked done for their fingerprint, with why", () => {
    raised("a", "b");
    p.proactiveReport([{ id: "p1", proposal: "Chase a." }], [{ id: "p2", why: "it was finished yesterday" }], now);
    expect(rows()[1]!.dropped_why).toBe("it was finished yesterday");
    expect(p.openProposals().map((x) => x.key)).toEqual(["a"]);
    expect(p.judge([fnd("b")], new Date(now.getTime() + 30 * 86_400_000))[0]).toMatchObject({ raise: false, why: "marked done" });
    expect(p.proactiveReport([], [{ id: "p2", why: "again" }]).ok).toBe(true);
  });
  test("Go posts the line to alice from proactive, once", async () => {
    raised("a");
    p.proactiveReport([{ id: "p1", proposal: "Chase a" }], [], now);
    const id = rows()[0]!.id;
    expect(await p.answerProposal(id, "go", send, now)).toMatchObject({ ok: true });
    expect(sent).toEqual([{ to: "alice", from: "proactive", text: "The captain said Go to your proposal for a is due 2026-10-31: Chase a. Do it now with your tools (Go-gated actions still ask), and reply in one line." }]);
    expect(await p.answerProposal(id, "go", send, now)).toMatchObject({ ok: true, already: true });
    expect(await p.answerProposal(id, "done", send, now)).toMatchObject({ ok: false, already: true });
    expect(sent).toHaveLength(1);
    expect(p.openProposals()).toEqual([]);
  });
  test("a Go that cannot reach Alice leaves the card open", async () => {
    raised("a");
    p.proactiveReport([{ id: "p1", proposal: "Chase a" }], [], now);
    const r = await p.answerProposal(rows()[0]!.id, "go", async () => { throw new Error("no host"); }, now);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toContain("no host");
    expect(p.openProposals()).toHaveLength(1);
  });
  test("Snooze holds the finding for 7 days; Done ends it; unreported items cannot be answered", async () => {
    raised("a", "b", "c");
    p.proactiveReport([{ id: "p1", proposal: "x" }, { id: "p2", proposal: "y" }], [], now);
    const [a, b, c] = rows();
    expect((await p.answerProposal(a!.id, "snooze", send, now)).message).toBe("snoozed 7 days");
    expect(p.judge([fnd("a")], new Date(now.getTime() + 6 * 86_400_000))[0]!.raise).toBe(false);
    expect(p.judge([fnd("a")], new Date(now.getTime() + 8 * 86_400_000))[0]!.raise).toBe(true);
    expect((await p.answerProposal(b!.id, "done", send, now)).message).toBe("marked done");
    expect(p.judge([fnd("b")], new Date(now.getTime() + 90 * 86_400_000))[0]!.why).toBe("marked done");
    expect((await p.answerProposal(c!.id, "go", send, now)).ok).toBe(false);
    expect((await p.answerProposal(9999, "go", send, now)).ok).toBe(false);
    expect(sent).toEqual([]);
  });
  test("Needs you gets one proactive card per open proposal", async () => {
    raised("a", "b");
    p.proactiveReport([{ id: "p1", proposal: "Chase a." }, { id: "p2", proposal: "Close b." }], [], now);
    const { collectNeedsYou } = await import("./needs-you.ts");
    const cards = (await collectNeedsYou({ waiting: () => false, holds: [] })).filter((i) => i.kind === "proactive");
    expect(cards.map((c) => c.kind === "proactive" && [c.findingKind, c.summary, c.proposal, c.id === `proactive:${c.itemId}`])).toEqual([["due", "a is due 2026-10-31", "Chase a.", true], ["due", "b is due 2026-10-31", "Close b.", true]]);
    await p.answerProposal(rows()[0]!.id, "done", send, now);
    expect((await collectNeedsYou({ waiting: () => false, holds: [] })).filter((i) => i.kind === "proactive")).toHaveLength(1);
  });
  test("the report counts reported, answers, drops and the go rate per kind", async () => {
    p.markRaised([fnd("a"), fnd("b"), fnd("c"), fnd("d"), { ...fnd("e"), kind: "closeable", fingerprint: "closeable:e:1/1" }], now);
    p.proactiveReport([{ id: "p1", proposal: "x" }, { id: "p2", proposal: "x" }, { id: "p3", proposal: "x" }, { id: "p5", proposal: "x" }], [{ id: "p4", why: "wrong" }], now);
    const [a, b, , , e] = rows();
    await p.answerProposal(a!.id, "go", send, now);
    await p.answerProposal(b!.id, "snooze", send, now);
    await p.answerProposal(e!.id, "go", send, now);
    const r = p.proposalReport(30, now);
    expect(r).toMatchObject({ reported: 4, open: 1, go: 2, snoozed: 1, done: 0, dropped: 1, goRate: 0.67 });
    expect(r.perKind).toEqual([
      { kind: "closeable", reported: 1, go: 1, snoozed: 0, done: 0, dropped: 0, goRate: 1 },
      { kind: "due", reported: 3, go: 1, snoozed: 1, done: 0, dropped: 1, goRate: 0.5 },
    ]);
  });
});
