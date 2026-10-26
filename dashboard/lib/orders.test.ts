import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the vault and inbox at scratch folders before the modules read them.
const vault = mkdtempSync(join(tmpdir(), "orders-vault-"));
const inbox = mkdtempSync(join(tmpdir(), "orders-inbox-"));
const prev = { vault: process.env.ALICE_VAULT, inbox: process.env.FLEET_INBOX };
process.env.ALICE_VAULT = vault;
process.env.FLEET_INBOX = inbox;

const notes = await import("./order-note.ts");
const orders = await import("./orders.ts");
const { recentShipEvents } = await import("./ship-log.ts");

const BODY = `## Intent

Check on kinwork.

## Steps

1. \`ship_tasks\` ship=kinwork
   expect: the voyage, if any
2. \`fleet_chat\` to=kinwork-designer text="Status, please."
   expect: it lands in the thread

## Acceptance

- \`agent_chat_read\` agent=kinwork-designer n=3
  expect: the message is there
`;

afterAll(() => {
  if (prev.vault === undefined) delete process.env.ALICE_VAULT;
  else process.env.ALICE_VAULT = prev.vault;
  if (prev.inbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev.inbox;
});

describe("order watcher", () => {
  let slug = "";
  beforeAll(async () => {
    orders._resetOrdersForTest();
    orders._setExpectCheckForTest(async () => null); // no Jev in tests
    const r = await notes.createOrder({ title: "Kinwork check", ship: "kinwork", by: "claude-code", body: BODY });
    expect(r.errors).toEqual([]);
    slug = r.slug;
  });

  test("a queued order waits for the Go; after it, the watcher starts it", async () => {
    await orders.kickOrders();
    expect(orders.runningOrder()).toBeNull();
    expect((await notes.readOrder(slug)).meta!.status).toBe("queued");
    expect((await notes.approveOrder(slug)).ok).toBe(true);
    await orders.kickOrders();
    expect(orders.runningOrder()?.slug).toBe(slug);
    expect((await notes.readOrder(slug)).meta!.status).toBe("running");
  });

  test("reads outside the plan are allowed; fleet_chat outside it is refused without pausing", async () => {
    expect((await orders.checkOrderCall("fleet_status", {}, true, {})).ok).toBe(true);
    const r = await orders.checkOrderCall("fleet_chat", { to: "x", text: "y" }, false, {});
    expect(r.ok).toBe(false);
    expect(orders.runningOrder()?.slug).toBe(slug);
  });

  test("steps must be called before they are logged, in order", async () => {
    expect((await orders.orderStep(slug, 1, true, "no voyage", "")).message).toContain("Call step 1's tool first");
    expect((await orders.checkOrderCall("ship_tasks", { ship: "kinwork" }, true, { order: slug, step: 1 })).ok).toBe(true);
    expect((await orders.orderStep(slug, 1, true, "no voyage", "ship_tasks")).ok).toBe(true);
    expect((await orders.orderStep(slug, 3, true, "x", "")).message).toContain("next step to log is 2");
  });

  test("a call that differs from the plan is refused and pauses the order at that step", async () => {
    const r = await orders.checkOrderCall("fleet_chat", { to: "kinwork-designer", text: "Something else" }, false, { order: slug, step: 2 });
    expect(r.ok).toBe(false);
    expect(orders.runningOrder()).toBeNull();
    const after = await notes.readOrder(slug);
    expect(after.meta!.status).toBe("needs-captain");
    expect(after.meta!.resume).toBe(2);
    expect(after.text).toContain("refused fleet_chat as step 2");
  });

  test("retry resumes at the paused step and a clean run ends done with a report", async () => {
    expect((await notes.retryOrder(slug)).ok).toBe(true);
    await orders.kickOrders();
    expect(orders.runningOrder()?.next).toBe(2);
    expect((await orders.checkOrderCall("fleet_chat", { to: "kinwork-designer", text: "Status,  please." }, false, { order: slug, step: 2 })).ok).toBe(true);
    expect((await orders.orderStep(slug, 2, true, "sent", "ts 1")).ok).toBe(true);
    expect((await orders.checkOrderCall("agent_chat_read", { agent: "kinwork-designer", n: "3" }, true, { order: slug, step: 3 })).ok).toBe(true);
    expect((await orders.orderStep(slug, 3, true, "message present", "")).message).toContain("call order_finish");
    expect((await orders.orderFinish(slug, "done", "")).ok).toBe(true);
    const done = await notes.readOrder(slug);
    expect(done.meta!.status).toBe("done");
    expect(done.text).toContain("| 1 | step | `ship_tasks` ship=kinwork | ok | no voyage |");
    expect(done.text).toContain("refused fleet_chat as step 2");
    expect(done.text).toContain("**Pauses**");
    expect(done.text).toContain("reads outside the plan (allowed, they change nothing): fleet_status");
    const kinds = recentShipEvents("flagship", 50).map((e) => e.kind);
    expect(kinds).toContain("order-start");
    expect(kinds).toContain("order-finish");
    expect(recentShipEvents("kinwork", 50).some((e) => e.kind === "order-step")).toBe(true);
    expect(readFileSync(join(inbox, "alice", "captain-chat.jsonl"), "utf8")).toContain(`Fleet order ${slug}`);
  });
});

describe("orders survive a node restart", () => {
  let slug = "";
  test("a running order resumes at the next unlogged step", async () => {
    orders._resetOrdersForTest();
    const r = await notes.createOrder({ title: "Restart check", ship: "kinwork", by: "captain", body: BODY, status: "approved" });
    slug = r.slug;
    await orders.kickOrders();
    expect(orders.runningOrder()?.slug).toBe(slug);
    expect((await orders.checkOrderCall("ship_tasks", { ship: "kinwork" }, true, { order: slug, step: 1 })).ok).toBe(true);
    orders.recordOrderCall(1, "ship_tasks", { ship: "kinwork" }, "no voyage");
    expect((await orders.orderStep(slug, 1, true, "no voyage", "")).ok).toBe(true);
    // The node dies here; a new one boots.
    orders._resetOrdersForTest();
    await orders.kickOrders();
    expect(orders.runningOrder()?.slug).toBe(slug);
    expect(orders.runningOrder()?.next).toBe(2);
    expect(readFileSync(join(inbox, "alice", "captain-chat.jsonl"), "utf8")).toContain("Resuming after a fleet node restart: steps before 2 are done");
  });
  test("an action cut off mid-call pauses for the captain instead of repeating", async () => {
    expect((await orders.checkOrderCall("fleet_chat", { to: "kinwork-designer", text: "Status, please." }, false, { order: slug, step: 2 })).ok).toBe(true);
    // No recordOrderCall: the node died while fleet_chat was running.
    orders._resetOrdersForTest();
    await orders.kickOrders();
    expect(orders.runningOrder()).toBeNull();
    const n = await notes.readOrder(slug);
    expect(n.meta!.status).toBe("needs-captain");
    expect(n.meta!.reason).toContain("check whether it happened");
  });
});

describe("independent expect check", () => {
  test("a clear disagreement holds the step once; a second ok is accepted and recorded", async () => {
    orders._resetOrdersForTest();
    const r = await notes.createOrder({ title: "Expect check", ship: "kinwork", by: "claude-code", body: BODY });
    expect((await notes.approveOrder(r.slug)).ok).toBe(true);
    await orders.kickOrders();
    const asked: string[] = [];
    orders._setExpectCheckForTest(async (exp, actual) => (asked.push(`${exp} | ${actual}`), 0.1));
    expect((await orders.checkOrderCall("ship_tasks", { ship: "kinwork" }, true, { order: r.slug, step: 1 })).ok).toBe(true);
    orders.recordOrderCall(1, "ship_tasks", { ship: "kinwork" }, "error: No ship named kinwork.");
    const first = await orders.orderStep(r.slug, 1, true, "looks fine", "");
    expect(first.ok).toBe(false);
    expect(first.message).toContain("independent check");
    expect(asked[0]).toBe("the voyage, if any | error: No ship named kinwork.");
    const second = await orders.orderStep(r.slug, 1, true, "it is fine: no voyage is a valid answer", "checked by hand");
    expect(second.ok).toBe(true);
    expect(recentShipEvents("flagship", 20).some((e) => e.kind === "order-step" && e.summary.includes("over the independent check"))).toBe(true);
    orders._setExpectCheckForTest(async () => null);
  });
});


describe("chat priority and Alice's own tools", () => {
  test("the captain's message pauses the order after the current step; it resumes once Alice goes quiet", async () => {
    orders._resetOrdersForTest();
    orders._setExpectCheckForTest(async () => null);
    for (const o of await notes.listOrders()) if (o.meta && !["done", "failed", "cancelled"].includes(o.meta.status)) await notes.updateOrder(o.slug, { status: "cancelled" });
    const { slug } = await notes.createOrder({ title: "Chat while running", ship: "kinwork", by: "captain", body: BODY, status: "approved" });
    await orders.kickOrders();
    expect(orders.runningOrder()?.slug).toBe(slug);
    // Alice's own tools are tagged with the order; fleet calls are not doubled.
    orders.noteAgentTool("alice", "bash: git log -3");
    orders.noteAgentTool("alice", "ship_tasks");
    orders.noteAgentTool("kinwork-designer", "bash: ls");
    orders.captainWrote("alice");
    expect((await orders.checkOrderCall("ship_tasks", { ship: "kinwork" }, true, { order: slug, step: 1 })).ok).toBe(true);
    const logged = await orders.orderStep(slug, 1, true, "no voyage", "ship_tasks");
    expect(logged.message).toContain("answer them now");
    expect(orders.runningOrder()?.chatPaused).toBe(true);
    // Alice answers and her turn ends: the watcher resumes at step 2 instead of pausing for the captain.
    orders.runningOrder()!.lastActive = Date.now() - 60_000;
    await orders.kickOrders();
    expect(orders.runningOrder()?.slug).toBe(slug);
    expect(orders.runningOrder()?.chatPaused).toBe(false);
    expect((await notes.readOrder(slug)).meta!.status).toBe("running");
    const events = recentShipEvents("flagship", 200).filter((e) => e.payload?.order === slug);
    expect(events.filter((e) => e.kind === "order-tool").map((e) => e.summary)).toEqual(["Alice used bash: git log -3"]);
    expect(events.some((e) => e.kind === "order-chat")).toBe(true);
    // Finish it: the report lists Alice's own tools and the pause.
    for (const [n, tool, args] of [[2, "fleet_chat", { to: "kinwork-designer", text: "Status, please." }], [3, "agent_chat_read", { agent: "kinwork-designer", n: "3" }]] as const) {
      expect((await orders.checkOrderCall(tool, args, tool !== "fleet_chat", { order: slug, step: n })).ok).toBe(true);
      orders.recordOrderCall(n, tool, args, "ok");
      expect((await orders.orderStep(slug, n, true, "ok", tool)).ok).toBe(true);
    }
    expect((await orders.orderFinish(slug, "done", "")).ok).toBe(true);
    const text = readFileSync(join(notes.ordersDir(), `${slug}.md`), "utf8");
    expect(text).toContain("Alice's own tools during the order");
    expect(text).toContain("git log -3");
    expect(text).toContain("paused 1 time to answer the captain");
  });
});

describe("editing and deleting orders", () => {
  test("an order that has not started can be edited (it must still parse) and deleted; a running one cannot", async () => {
    const { slug } = await notes.createOrder({ title: "Edit me", ship: "kinwork", by: "claude-code", body: BODY });
    const before = await notes.readOrder(slug);
    expect(notes.editableBody(before.text)).toStartWith("## Intent");
    expect((await notes.editOrder(slug, "Edit me", "## Steps\n\nnot a step\n")).ok).toBe(false);
    const edited = await notes.editOrder(slug, "Edited", BODY.replace("n=3", "n=5"));
    expect(edited).toEqual({ ok: true, message: "Saved: 2 step(s), 1 check(s)." });
    const after = await notes.readOrder(slug);
    expect(after.meta!.title).toBe("Edited");
    expect(after.meta!.status).toBe("queued");
    expect(after.text).toContain("n=5");
    expect((await notes.deleteOrder(slug)).ok).toBe(true);
    expect((await notes.readOrder(slug)).meta).toBeNull();
    expect(readFileSync(join(notes.ordersDir(), "deleted", `${slug}.md`), "utf8")).toContain("Edited");
    const { slug: busy } = await notes.createOrder({ title: "Busy", ship: "kinwork", by: "captain", body: BODY, status: "running" });
    expect((await notes.editOrder(busy, "x y z", BODY)).ok).toBe(false);
    expect((await notes.deleteOrder(busy)).ok).toBe(false);
    await notes.updateOrder(busy, { status: "cancelled" });
  });
});
