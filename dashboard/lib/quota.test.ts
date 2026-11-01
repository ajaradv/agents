import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQuotaFromJson } from "./quota-parse.ts";
import { writeQuotaLast, type QuotaCache } from "./quota.ts";

const raw = JSON.stringify({
  providers: [
    {
      provider: "cursor",
      windows: [
        { id: "included_usage", label: "included usage", percentRemaining: 8 },
        { id: "auto_usage", label: "auto usage", percentRemaining: 7 },
        { id: "api_usage", label: "API usage", percentRemaining: 0 },
        { id: "spend_limit", label: "spend limit", percentRemaining: 0 },
      ],
    },
  ],
});

const poll = (over: Partial<QuotaCache> = {}): QuotaCache => ({ at: "2026-11-01T10:00:00.000Z", ok: true, raw, parsed: parseQuotaFromJson(raw), loading: false, ...over });

let inbox = "";
const saved = process.env.FLEET_INBOX;
beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), "quota-last-"));
  process.env.FLEET_INBOX = inbox;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = saved;
  rmSync(inbox, { recursive: true, force: true });
});

const file = () => join(inbox, ".node", "quota-last.json");

describe("quota-last.json", () => {
  test("a good poll writes Cursor's windows, atomically", () => {
    writeQuotaLast(poll());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      at: "2026-11-01T10:00:00.000Z",
      cursor: { api_usage: 0, spend_limit: 0, included_usage: 8, auto_usage: 7 },
    });
    expect(readdirSync(join(inbox, ".node"))).toEqual(["quota-last.json"]);
  });

  test("a failed, stale, or Cursor-less poll leaves the last file", () => {
    writeQuotaLast(poll());
    const before = readFileSync(file(), "utf8");
    writeQuotaLast(poll({ ok: false, at: "2026-11-01T11:00:00.000Z" }));
    writeQuotaLast(poll({ stale: true, at: "2026-11-01T12:00:00.000Z" }));
    writeQuotaLast(poll({ parsed: parseQuotaFromJson(JSON.stringify({ providers: [] })), at: "2026-11-01T13:00:00.000Z" }));
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  test("no file before the first good poll", () => {
    writeQuotaLast(poll({ ok: false }));
    expect(existsSync(file())).toBe(false);
  });
});
