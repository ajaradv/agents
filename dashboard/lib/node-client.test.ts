import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeToken, tokenMatches } from "./node-auth.ts";
import { memoryAnswer, parseSse } from "./node-client.ts";

describe("parseSse", () => {
  test("splits complete frames and keeps the unfinished rest", () => {
    const { frames, rest } = parseSse('event: state\ndata: {"a":1}\n\n: ping\n\nevent: line\ndata: {"agentId":"x"}\n\nevent: ho');
    expect(frames).toEqual([
      { event: "state", data: '{"a":1}' },
      { event: "line", data: '{"agentId":"x"}' },
    ]);
    expect(rest).toBe("event: ho");
  });
  test("a frame split across chunks parses once whole", () => {
    const a = parseSse('event: turn\ndata: {"k"');
    expect(a.frames).toEqual([]);
    const b = parseSse(a.rest + ":1}\n\n");
    expect(b.frames).toEqual([{ event: "turn", data: '{"k":1}' }]);
  });
});

describe("node token", () => {
  test("written once with owner-only permissions, then reused", () => {
    const prev = process.env.FLEET_INBOX;
    process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "fleet-node-"));
    try {
      const t = nodeToken();
      expect(t).toMatch(/^[0-9a-f]{48}$/);
      expect(nodeToken()).toBe(t);
      expect(statSync(join(process.env.FLEET_INBOX, ".node", "token")).mode & 0o777).toBe(0o600);
    } finally {
      if (prev === undefined) delete process.env.FLEET_INBOX;
      else process.env.FLEET_INBOX = prev;
    }
  });
  test("compare needs the exact token", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("abd", "abc")).toBe(false);
    expect(tokenMatches("", "abc")).toBe(false);
  });
});

describe("memory answers go to the node", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("approve and dismiss post the id, action, and label to /v1/memory and return the node's reply", async () => {
    const seen: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, message: "Sent to Alice." });
    }) as unknown as typeof fetch;
    expect(await memoryAnswer(7, "approve", "fact")).toEqual({ ok: true, message: "Sent to Alice." });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.endsWith("/v1/memory")).toBe(true);
    expect(seen[0]!.body).toEqual({ id: 7, action: "approve", label: "fact" });
  });
});
