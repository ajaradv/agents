import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "router-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { EventRouter, wakes, wakeText } = await import("./event-router.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const bus = (owner: string) => join(inbox, owner, "events.jsonl");
const add = (owner: string, e: Record<string, unknown>) => appendFileSync(bus(owner), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("which lines wake an agent", () => {
  test("not its own lines, not noise; anything else does", () => {
    expect(wakes("firstmate", { from: "designer", kind: "design-ship" })).toBe(true);
    expect(wakes("firstmate", { from: "firstmate", kind: "design-ship-accepted" })).toBe(false);
    expect(wakes("firstmate", { from: "firstmate", kind: "heartbeat" })).toBe(false);
    expect(wakes("alice", { from: "dashboard", kind: "captain-chat" })).toBe(false);
    expect(wakes("alice", { from: "router", kind: "x" })).toBe(false);
  });
  test("Firstmate gets one line for its TUI; others get the list", () => {
    const e = [{ from: "designer", kind: "design-ship", project: "kinwork", summary: "Captain signed off.", ref: "DESIGN.md" }];
    expect(wakeText("firstmate", e, true)).toBe("Bus: design-ship from designer (kinwork): Captain signed off. [DESIGN.md]. Read fleet/inbox/firstmate/events.jsonl and act per your role.");
    expect(wakeText("architect", e, false)).toContain("- design-ship from designer (kinwork): Captain signed off. [DESIGN.md]");
  });
});

describe("EventRouter", () => {
  test("starts at the end of a bus, batches new lines into one wake, and skips noise", async () => {
    mkdirSync(join(inbox, "firstmate"), { recursive: true });
    writeFileSync(bus("firstmate"), JSON.stringify({ from: "designer", kind: "design-ship", summary: "old, before the router" }) + "\n");
    const woken: { owner: string; kinds: string[] }[] = [];
    const r = new EventRouter(async (owner, events) => {
      woken.push({ owner, kinds: events.map((e) => String(e.kind)) });
      return { ok: true, detail: "test" };
    }, () => ["firstmate"], 60);
    await r.poll(); // first sight: offset at the end, the old line is not replayed
    add("firstmate", { from: "firstmate", kind: "heartbeat" });
    add("firstmate", { from: "designer", kind: "design-ship", summary: "new" });
    add("firstmate", { from: "alice", kind: "request", summary: "triage this" });
    await r.poll();
    await wait(120);
    expect(woken).toEqual([{ owner: "firstmate", kinds: ["design-ship", "request"] }]);
  });
  test("a failed wake keeps its lines for the next try", async () => {
    mkdirSync(join(inbox, "designer"), { recursive: true });
    writeFileSync(bus("designer"), "");
    let calls = 0;
    const r = new EventRouter(async () => {
      calls++;
      return { ok: false, detail: "TUI closed" };
    }, () => ["designer"], 30);
    await r.poll();
    add("designer", { from: "firstmate", kind: "design-request", summary: "home page" });
    await r.poll();
    await wait(80);
    expect(calls).toBe(1);
    // The line is still queued (retried in five minutes); flushing now retries it.
    await r.flush("designer");
    expect(calls).toBe(2);
  });
  test("an owner that stays unreachable is reported once, then retried quietly; recovery is noted", async () => {
    mkdirSync(join(inbox, "architect"), { recursive: true });
    writeFileSync(bus("architect"), "");
    let up = false;
    const told: string[] = [];
    const r = new EventRouter(async () => (up ? { ok: true, detail: "ok" } : { ok: false, detail: "●━━━━\n●  WORKTREE TANGLE\n●━━━━" }), () => ["architect"], 30, (summary) => void told.push(summary));
    await r.poll();
    add("architect", { from: "captain", kind: "plan-request", summary: "graphics" });
    await r.poll();
    await wait(80);
    await r.flush("architect");
    expect(told).toEqual([]);
    await r.flush("architect");
    expect(told).toEqual(["architect cannot be woken; 1 bus line(s) wait for it"]);
    await r.flush("architect");
    expect(told.length).toBe(1);
    up = true;
    await r.flush("architect");
    await r.flush("architect");
    expect(told.length).toBe(1);
  });
});

describe("test inboxes never reach the captain's live TUIs", () => {
  test("realFleet is false for any inbox but the default, unless allowed", async () => {
    const { realFleet } = await import("./paths.ts");
    expect(realFleet()).toBe(false); // FLEET_INBOX points at a temp folder in this file
    process.env.FLEET_ALLOW_TUI = "1";
    expect(realFleet()).toBe(true);
    delete process.env.FLEET_ALLOW_TUI;
    const { firstmateTuiReachable, sendFmText } = await import("./firstmate-chat.ts");
    expect((await firstmateTuiReachable()).ok).toBe(false);
    expect((await sendFmText("fleet:w5:p1", "x")).ok).toBe(false);
  });
});
