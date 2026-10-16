import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "push-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const p = await import("./push.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const notice = (n: number, summary: string) => ({ kind: "notice" as const, id: `notice:${n}`, noticeId: n, ts: "", from: "alice", noticeKind: "done" as const, summary, detail: "", ref: "" });

describe("push", () => {
  test("VAPID keys are made once and kept", () => {
    const a = p.vapidKeys().publicKey;
    expect(a.length).toBeGreaterThan(60);
    expect(p.vapidKeys().publicKey).toBe(a);
  });
  test("subscriptions are validated, stored once per endpoint, and removed", () => {
    expect(p.validSub({ endpoint: "http://x", keys: { p256dh: "a", auth: "b" } })).toBe(false);
    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } };
    expect(p.validSub(sub)).toBe(true);
    p.addSubscription(sub, "phone");
    p.addSubscription(sub, "phone");
    expect(p.subscriptions().length).toBe(1);
    expect(p.removeSubscription(sub.endpoint)).toBe(true);
    expect(p.subscriptions().length).toBe(0);
  });
  test("messages say who and what, and open Needs you", () => {
    const m = p.messageFor(notice(1, "Kinwork's voyage docked."));
    expect(m).toEqual({ title: "Done: alice", body: "Kinwork's voyage docked.", tag: "notice:1", url: "/needs" });
    const g = p.messageFor({ kind: "go", id: "go:7", goId: "7", ts: "", tool: "voyage_start", summary: "Set sail on kinwork.", agentId: "alice", label: "Alice", art: null });
    expect(g.title).toBe("Go? (Alice)");
  });
  test("the first pass only records what is there; later items count once", async () => {
    expect(await p.pushNewNeeds([notice(1, "old")])).toBe(0);
    expect(await p.pushNewNeeds([notice(1, "old"), notice(2, "new")])).toBe(1);
    expect(await p.pushNewNeeds([notice(1, "old"), notice(2, "new")])).toBe(0);
  });
});
