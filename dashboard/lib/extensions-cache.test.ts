import { describe, expect, test } from "bun:test";
import { cacheMiss, isReadTool, prefixHash, stableJson, strikeKey, toolFailed } from "../../extensions/cache-watch.ts";
import { windowImages } from "../../extensions/image-window.ts";

const img = (n: number) => ({ type: "image", data: "x".repeat(n) });
/** A transcript with `k` earlier-turn images (one per assistant message) and a final captain message. */
function transcript(k: number, size = 10) {
  const msgs: { role: string; content: { type: string; data?: string; text?: string }[] }[] = [];
  for (let i = 0; i < k; i++) msgs.push({ role: "toolResult", content: [img(size)] });
  msgs.push({ role: "user", content: [{ type: "text", text: "next" }] });
  return msgs;
}
const droppedCount = (m: ReturnType<typeof transcript> | null) => (m ? m.flatMap((x) => x.content).filter((b) => b.type === "text" && b.text?.startsWith("[Image")).length : 0);

describe("image-window keeps the cache: drops in batches", () => {
  test("nothing dropped until twice the batch", () => {
    expect(windowImages(transcript(12), 6, 1e9)).toBeNull();
  });
  test("then the oldest go in multiples of the batch, so the dropped set changes once per six images", () => {
    const counts = [13, 14, 17, 18, 23, 24].map((k) => droppedCount(windowImages(transcript(k), 6, 1e9)));
    expect(counts).toEqual([6, 6, 6, 12, 12, 18]);
  });
  test("the dropped images are the oldest, and stay the same as new images arrive within a batch", () => {
    const a = windowImages(transcript(13), 6, 1e9)!;
    const b = windowImages(transcript(16), 6, 1e9)!;
    expect(JSON.stringify(a.slice(0, 13))).toBe(JSON.stringify(b.slice(0, 13)));
  });
  test("this turn's images are always kept", () => {
    const msgs = [...transcript(0), { role: "toolResult", content: [img(10), img(10), img(10)] }];
    expect(windowImages(msgs, 6, 1e9)).toBeNull();
  });
  test("the byte cap also drops in batches", () => {
    expect(droppedCount(windowImages(transcript(10, 100), 6, 500))).toBe(6);
  });
});

describe("cache-watch", () => {
  test("serialization is order-independent and whitespace-free", () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });
  test("the prefix hash ignores tool order but sees any change", () => {
    const t1 = [{ name: "read", description: "r", parameters: { a: 1 } }, { name: "bash", description: "b" }];
    const t2 = [t1[1]!, t1[0]!];
    expect(prefixHash("sys", t1)).toBe(prefixHash("sys", t2));
    expect(prefixHash("sys", t1)).not.toBe(prefixHash("sys ", t1));
    expect(prefixHash("sys", t1)).not.toBe(prefixHash("sys", [{ ...t1[0]!, description: "R" }, t1[1]!]));
  });
  test("a miss is a bug only with the same prefix, within the TTL, big enough, and a caching provider", () => {
    const prev = { hash: "h", at: 0 };
    const usage = { input: 9000, cacheRead: 0 };
    const caches = true;
    expect(cacheMiss(prev, { hash: "h", at: 60_000, provider: "deepseek", usage, caches })).toBe(true);
    expect(cacheMiss(prev, { hash: "h", at: 60_000, provider: "deepseek", usage: { input: 500, cacheRead: 8500 }, caches })).toBe(false);
    expect(cacheMiss(prev, { hash: "other", at: 60_000, provider: "deepseek", usage, caches })).toBe(false);
    expect(cacheMiss(prev, { hash: "h", at: 600_000, provider: "deepseek", usage, caches })).toBe(false);
    expect(cacheMiss(prev, { hash: "h", at: 60_000, provider: "cursor", usage, caches })).toBe(false);
    expect(cacheMiss(prev, { hash: "h", at: 60_000, provider: "deepseek", usage: { input: 900 }, caches })).toBe(false);
    // A model that does not cache (no cache price, never read from cache) cannot have a cache bug.
    expect(cacheMiss(prev, { hash: "h", at: 60_000, provider: "openrouter", usage, caches: false })).toBe(false);
  });
  test("only reads count as repeats", () => {
    expect(["read", "grep", "agent_chat_read", "fleet_status", "obsidian_read"].map(isReadTool)).toEqual([true, true, true, true, true]);
    expect(["bash", "edit", "write", "fleet_chat"].map(isReadTool)).toEqual([false, false, false, false]);
  });
});

import { decide, stateFile } from "../../extensions/context-guard.ts";

describe("context-guard", () => {
  test("compacts now past 65%, while idle past 40%, never below a fresh floor", () => {
    expect(decide(70, 0)).toBe("now");
    expect(decide(45, 0)).toBe("idle");
    expect(decide(30, 0)).toBe("none");
    expect(decide(45, 38)).toBe("none"); // grew only 7 points since the last compaction
  });
  test("the handoff file sits in the agent's inbox folder", () => {
    expect(stateFile({ FLEET_AGENT_ID: "alice", FLEET_INBOX: "/x/inbox" })).toBe("/x/inbox/alice/memory/state.md");
    expect(stateFile({ FLEET_AGENT_ID: "../etc", FLEET_INBOX: "/x" })).toBeNull();
    expect(stateFile({})).toBeNull();
  });
});

describe("cache-watch two strikes", () => {
  test("an error result or an unanswered fleet call is a failure", () => {
    expect(toolFailed(true, [])).toBe(true);
    expect(toolFailed(false, [{ type: "text", text: "The fleet node did not answer (timeout). Tell the captain." }])).toBe(true);
    expect(toolFailed(false, [{ type: "text", text: "{\"ok\":true}" }])).toBe(false);
  });
});

describe("cache-watch strikes count the same call, not the same tool", () => {
  test("two different missing files are two different calls; a node outage is one", () => {
    const enoent = [{ type: "text", text: "ENOENT: no such file or directory" }];
    expect(strikeKey("read", { path: "/tmp/a.png" }, enoent)).not.toBe(strikeKey("read", { path: "/tmp/b.png" }, enoent));
    expect(strikeKey("read", { path: "/tmp/a.png" }, enoent)).toBe(strikeKey("read", { path: "/tmp/a.png" }, enoent));
    const down = [{ type: "text", text: "The fleet node did not answer (timeout). Tell the captain." }];
    expect(strikeKey("ship_log", { ship: "a" }, down)).toBe(strikeKey("ship_log", { ship: "b" }, down));
  });
});

describe("image window: screenshots shrink before they enter a session", () => {
  test("a large PNG becomes a smaller JPEG within 1568 px; small or odd images are left alone", async () => {
    const sharp = (await import("sharp")).default;
    const { shrinkImage } = await import("../../extensions/image-window.ts");
    // Smooth shapes with light grain: large as a PNG, small as a JPEG, like a busy screenshot.
    const raw = Buffer.alloc(1800 * 1000 * 3);
    let seed = 7;
    for (let y = 0; y < 1000; y++) for (let x = 0; x < 1800; x++) for (let c = 0; c < 3; c++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[(y * 1800 + x) * 3 + c] = Math.max(0, Math.min(255, 128 + 60 * Math.sin(x / (9 + c)) + 50 * Math.cos(y / 13) + (seed % 24)));
    }
    const png = (await sharp(raw, { raw: { width: 1800, height: 1000, channels: 3 } }).png().toBuffer()).toString("base64");
    const out = await shrinkImage(png, "image/png");
    expect(out?.mimeType).toBe("image/jpeg");
    expect(out!.data.length).toBeLessThan(png.length);
    expect((await sharp(Buffer.from(out!.data, "base64")).metadata()).width).toBe(1568);
    expect(await shrinkImage(png.slice(0, 1000), "image/png")).toBeNull();
    expect(await shrinkImage(png, "image/gif")).toBeNull();
  });
});
