import { describe, expect, test } from "bun:test";
import type { ChatLine } from "./chat.ts";
import type { ChatTarget } from "./chat-targets.ts";
import { holdItems, pendingInThread, sortNeeds, type NeedItem } from "./needs-you.ts";

const scout: ChatTarget = { id: "pochteca-scout", kind: "headless", label: "pochteca · scout", art: null, ship: "pochteca", runtime: "rpc" };
const captain = (ts: string, text = "do it"): ChatLine => ({ ts, from: "captain", kind: "chat", text });
const question = (ts: string, dialog = true): ChatLine => ({
  ts,
  from: "pochteca-scout",
  kind: "question",
  text: "Question for you:\n- Red or blue?",
  questions: [{ id: "q", question: "Red or blue?", options: ["Red", "Blue"] }],
  ...(dialog ? { dialog: { id: "d1", method: "select" } } : {}),
});

describe("pendingInThread", () => {
  test("a live dialog is waiting even when notices follow it", () => {
    const item = pendingInThread(scout, [captain("t1"), question("t2"), { ts: "t3", from: "pochteca-scout", kind: "chat", text: "still here" }], true);
    expect(item).toMatchObject({ kind: "question", id: "question:pochteca-scout:t2", live: true, dialog: { id: "d1" } });
  });
  test("an answered dialog is not waiting", () => {
    expect(pendingInThread(scout, [question("t2"), { ts: "t3", from: "captain", kind: "answer", text: "Blue", ref: "t2" }], true)).toBeNull();
  });
  test("a question left as the newest line waits; its answer goes as a message", () => {
    const item = pendingInThread(scout, [captain("t1"), question("t2")], false);
    expect(item).toMatchObject({ kind: "question", live: false });
    expect(item && "dialog" in item && item.dialog).toBeFalsy();
  });
  test("a reply after the question means it is settled", () => {
    expect(pendingInThread(scout, [question("t2", false), { ts: "t3", from: "pochteca-scout", kind: "chat", text: "went with red" }], false)).toBeNull();
  });
  test("a failed send carries the message to send again", () => {
    const item = pendingInThread(scout, [captain("t1", "hand it off"), { ts: "t2", from: "dashboard", kind: "error", text: "402 nope", ref: "t1" }], false);
    expect(item).toMatchObject({ kind: "failed", id: "failed:pochteca-scout:t2", sentText: "hand it off", sentTs: "t1", error: "402 nope" });
  });
  test("an error after the agent already replied is not a failed send", () => {
    const lines: ChatLine[] = [captain("t1"), { ts: "t2", from: "pochteca-scout", kind: "chat", text: "Wednesday" }, { ts: "t2", from: "dashboard", kind: "error", text: "503 busy", ref: "t1" }];
    expect(pendingInThread(scout, lines, false)).toBeNull();
  });
  test("an error that is not about a captain message is not a failed send", () => {
    expect(pendingInThread(scout, [{ ts: "t2", from: "dashboard", kind: "error", text: "x" }], false)).toBeNull();
  });
});

describe("sortNeeds", () => {
  test("blocked agents first, then holds, then failed sends; newest first", () => {
    const failed = pendingInThread(scout, [captain("2026-01-01T00:00:01Z"), { ts: "2026-01-01T00:00:02Z", from: "dashboard", kind: "error", text: "e", ref: "2026-01-01T00:00:01Z" }], false)!;
    const old = pendingInThread(scout, [question("2026-01-01T00:00:00Z")], false)!;
    const fresh = pendingInThread({ ...scout, id: "kinwork-designer" }, [question("2026-01-02T00:00:00Z")], false)!;
    const [hold] = holdItems([{ id: "kw-ship", title: "Ship the home page", holdReason: "Pick a launch date" }]) as NeedItem[];
    expect(sortNeeds([failed, hold!, old, fresh]).map((i) => i.id)).toEqual([fresh.id, old.id, "hold:kw-ship", failed.id]);
  });
});
