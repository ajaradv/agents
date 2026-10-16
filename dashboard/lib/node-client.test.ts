import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeToken, tokenMatches } from "./node-auth.ts";
import { parseSse } from "./node-client.ts";

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
