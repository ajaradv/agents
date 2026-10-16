import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "journal-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const j = await import("./journal.ts");
const api = await import("./fleet-api.ts");
afterAll(() => {
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

describe("journal", () => {
  test("a step runs once; a finished step returns its stored result", async () => {
    j.upsertWorkflow("go", "w1", { a: 1 });
    let runs = 0;
    const fn = async () => ++runs;
    expect(await j.once("w1", "send", fn)).toEqual({ ran: true, result: 1 });
    expect(await j.once("w1", "send", fn)).toEqual({ ran: false, result: 1 });
    expect(runs).toBe(1);
  });
  test("a step started but never finished (a crash) is uncertain, never re-run", async () => {
    j.upsertWorkflow("go", "w2", {});
    j.stepStarted("w2", "act");
    let runs = 0;
    expect(await j.once("w2", "act", async () => ++runs)).toEqual({ ran: false, uncertain: true });
    expect(runs).toBe(0);
  });
  test("workflows are idempotent by id and keep a trace", () => {
    const a = j.upsertWorkflow("order", "o1", { title: "x" }, { trace: "t-1" });
    const b = j.upsertWorkflow("order", "o1", { title: "changed" });
    expect(b.data).toEqual({ title: "x" });
    j.updateWorkflow("o1", { status: "done" });
    expect(j.traceEvents(a.trace).map((e) => e.kind)).toEqual(["order-created", "order-done"]);
  });
});

describe("Go requests on the journal", () => {
  test("an action interrupted mid-run is reported as uncertain and never repeated", async () => {
    await api.requestGo("alice", "agent_abort", { agent: "nobody-here" });
    const [w] = j.listWorkflows("go", "waiting");
    // Simulate a node that died inside the action: the captain had said Go, the run had started.
    j.updateWorkflow(w!.id, { status: "running", data: { decision: "go" } });
    j.stepStarted(w!.id, "answer");
    j.stepFinished(w!.id, "answer", "ts");
    j.stepStarted(w!.id, "run");
    const res = await api.finishGo(w!.id);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not known whether it happened");
    expect(j.getWorkflow(w!.id)!.status).toBe("failed");
    expect(j.step(w!.id, "run")!.status).toBe("started"); // untouched: it did not run again
  });
  test("a decided request that never started runs once, even if finished twice", async () => {
    await api.requestGo("alice", "agent_abort", { agent: "nobody-else" });
    const [w] = j.listWorkflows("go", "waiting");
    j.updateWorkflow(w!.id, { status: "running", data: { decision: "go" } });
    await api.finishGo(w!.id);
    const first = j.step(w!.id, "run")!;
    await api.finishGo(w!.id);
    expect(j.step(w!.id, "run")!.ended).toBe(first.ended);
  });
});
