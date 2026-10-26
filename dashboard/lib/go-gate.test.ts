import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "go-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;

const gate = await import("./go-gate.ts");
const api = await import("./fleet-api.ts");
const { parseOrder } = await import("./order-note.ts");

afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const chat = () => readFileSync(join(inbox, "alice", "captain-chat.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

describe("tier 2 arguments", () => {
  test("crew_change takes exactly one change; orchestrator is firstmate or lead", () => {
    expect(gate.tier2ArgError("crew_change", { ship: "kinwork", add: "scout" })).toBeNull();
    expect(gate.tier2ArgError("crew_change", { ship: "kinwork", add: "scout", remove: "lead" })).toContain("exactly one");
    expect(gate.tier2ArgError("crew_change", { ship: "kinwork", budget: "4" })).toContain("needs role");
    expect(gate.tier2ArgError("orchestrator_set", { ship: "kinwork", orchestrator: "alice" })).toContain("firstmate or lead");
    expect(gate.tier2ArgError("voyage_start", { ship: "kinwork", goal: "x" })).toContain("needs to");
    // Every host the shipyard sails on passes the gate's check, exe.dev included.
    for (const on of ["hub", "laptop", "exe"]) expect(gate.tier2ArgError("voyage_start", { ship: "kinwork", goal: "Mobile fixes", to: "kinwork-lead", on })).toBeNull();
    expect(gate.tier2ArgError("voyage_start", { ship: "kinwork", goal: "Mobile fixes", to: "kinwork-lead", on: "moon" })).toContain("on is hub, laptop, exe");
    expect(gate.tier2ArgError("merge", {})).toContain("not a fleet action");
  });
  test("the captain reads one plain sentence", () => {
    expect(gate.describeAction("voyage_start", { ship: "kinwork", goal: "Mobile fixes", to: "kinwork-lead" })).toBe('Set sail on kinwork: "Mobile fixes", sent to kinwork-lead.');
    expect(gate.describeAction("crew_change", { ship: "pochteca", role: "scout", budget: "none" })).toBe("Set pochteca's scout daily budget to none.");
  });
  test("orders may name tier 2 actions (their Go is the order's)", () => {
    const note = `---\ntitle: "t"\norder: "2026-10-15-t"\nstatus: "queued"\nship: "kinwork"\nsubmitted_by: "captain"\n---\n\n## Steps\n\n1. \`voyage_start\` ship=kinwork goal="Mobile fixes" to=kinwork-lead\n   expect: a voyage under sail\n`;
    expect(parseOrder(note).errors).toEqual([]);
  });
});

describe("the Go gate", () => {
  test("outside an order an action is held, asked in the thread, and not run", async () => {
    const r = await api.requestGo("alice", "agent_abort", { agent: "kinwork-designer" });
    expect(r.message).toContain("Waiting for the captain's Go");
    const held = await gate.readGoRequests();
    expect(held.map((g) => g.tool)).toEqual(["agent_abort"]);
    const line = chat().at(-1);
    expect(line.kind).toBe("question");
    expect(line.go.id).toBe(held[0]!.id);
    expect(line.questions[0].options).toEqual(["Go", "No"]);
  });
  test("No drops it and tells the officer; nothing runs", async () => {
    const [g] = await gate.readGoRequests();
    expect((await api.decideGo(g!.id, false)).ok).toBe(true);
    expect(await gate.readGoRequests()).toEqual([]);
    const lines = chat();
    expect(lines.some((l) => l.kind === "answer" && l.text === "No" && l.ref === g!.lineTs)).toBe(true);
    expect(lines.at(-1).text).toContain("The captain said No");
    expect((await api.decideGo(g!.id, true)).message).toContain("no longer waiting");
  });
  test("Go runs the stored action and reports the result to the officer", async () => {
    await api.requestGo("alice", "agent_abort", { agent: "nobody-here" });
    const [g] = await gate.readGoRequests();
    const r = await api.decideGo(g!.id, true);
    expect(r.message).toContain("not a live agent");
    expect(chat().at(-1).text).toContain("The captain said Go: Stop nobody-here mid-turn.");
  });
});

describe("a dock Go is for the work as asked", () => {
  test("a newer dock ask replaces the older; a Go after the branch moved docks nothing and tells the lead", async () => {
    let head = "aaaaaaa1111";
    api.setDockHeadProbe(async () => head);
    try {
      await api.requestGo("alice", "voyage_dock", { ship: "kinwork", summary: "first" });
      await api.requestGo("alice", "voyage_dock", { ship: "kinwork", summary: "second" });
      const held = (await gate.readGoRequests()).filter((g) => g.tool === "voyage_dock");
      expect(held.map((g) => [g.args.summary, g.head])).toEqual([["second", "aaaaaaa1111"]]);
      head = "bbbbbbb2222";
      const r = await api.decideGo(held[0]!.id, true);
      expect(r.ok).toBe(false);
      expect(r.message).toContain("aaaaaaa → bbbbbbb");
      expect(await gate.readGoRequests()).toEqual([]);
      expect(chat().at(-1).text).toContain("the branch moved since you asked");
    } finally {
      api.setDockHeadProbe(null);
    }
  });
});
