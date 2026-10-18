import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "notify-inbox-"));
const vault = mkdtempSync(join(tmpdir(), "notify-vault-"));
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
const n = await import("./notify.ts");
afterAll(() => {
  if (prev.inbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev.inbox;
  if (prev.vault === undefined) delete process.env.ALICE_VAULT;
  else process.env.ALICE_VAULT = prev.vault;
});

describe("interruption policy", () => {
  test("done, blocked, decision, milestone interrupt; info waits; snooze holds", () => {
    expect(["done", "blocked", "decision", "milestone", "info"].map((k) => n.deliveryFor(k as never, false))).toEqual(["interrupt", "interrupt", "interrupt", "interrupt", "digest"]);
    expect(n.deliveryFor("done", true)).toBe("held");
    expect(n.deliveryFor("info", true)).toBe("digest");
  });
  test("interrupting notices show until acknowledged", () => {
    const a = n.notifyCaptain({ from: "alice", kind: "done", summary: "Kinwork's voyage docked." });
    n.notifyCaptain({ from: "alice", kind: "info", summary: "The scout finished a recon." });
    expect(n.openNotices().map((x) => x.id)).toContain(a.id);
    expect(n.openNotices().some((x) => x.kind === "info")).toBe(false);
    expect(n.ackNotice(a.id)).toBe(true);
    expect(n.openNotices().some((x) => x.id === a.id)).toBe(false);
  });
});

describe("snooze, wake, and digests", () => {
  test("while snoozed, interruptions are held; wake turns them into one digest notice and a vault note", async () => {
    n.snooze();
    expect(n.quietState().snoozed).toBe(true);
    const held = n.notifyCaptain({ from: "alice", kind: "blocked", summary: "Order 2026-10-16-x needs a decision." });
    expect(held.delivery).toBe("held");
    expect(n.openNotices().some((x) => x.id === held.id)).toBe(false);
    const digest = await n.wake();
    expect(n.quietState().snoozed).toBe(false);
    expect(digest!.summary).toBe("While you were snoozed: 1 item(s)");
    expect(digest!.detail).toContain("## Blocked");
    expect(existsSync(join(vault, digest!.ref))).toBe(true);
    expect(n.openNotices()[0]!.kind).toBe("digest");
  });
  test("the morning digest folds everything waiting since the last digest, once", async () => {
    const d = await n.morningDigest();
    expect(d!.detail).toContain("The scout finished a recon.");
    expect(d!.detail).not.toContain("needs a decision"); // already in the wake digest
    expect(await n.morningDigest()).toBeNull();
    expect(readFileSync(join(vault, d!.ref), "utf8")).toContain("## For your information");
  });
});

describe("notice urgency", () => {
  const said = (p: number) => (async () => ({ ok: true, answers: { urgent: { type: "noul", noul: p } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 })) as never;
  test("a digest notice Jev is sure about is raised to Needs you; others stay in the digest", async () => {
    n._setUrgencyAskForTest(said(0.1));
    const calm = n.notifyCaptain({ from: "scout", kind: "info", summary: "Recon of the auth module finished" });
    expect(calm.delivery).toBe("digest");
    expect(await n.urgencyCheck(calm.id, calm.summary, "")).toBe(false);
    n._setUrgencyAskForTest(said(0.95));
    const hot = n.notifyCaptain({ from: "lead", kind: "info", summary: "Production deploy failing; customers cannot check out" });
    expect(await n.urgencyCheck(hot.id, hot.summary, "")).toBe(true);
    expect(n.openNotices().some((x) => x.id === hot.id)).toBe(true);
    expect(n.openNotices().some((x) => x.id === calm.id)).toBe(false);
    n._setUrgencyAskForTest((async () => ({ ok: false, error: "no" })) as never);
  });
});
