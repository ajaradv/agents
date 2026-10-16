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
    const kinds = recentShipEvents("fleet", 50).map((e) => e.kind);
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
