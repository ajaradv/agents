import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSessions } from "./session-archive.ts";

describe("old sessions are archived", () => {
  test("the newest two stay; older sessions untouched for 14 days are gzipped, not deleted", () => {
    const root = mkdtempSync(join(tmpdir(), "sessions-"));
    const dir = join(root, "kinwork-designer", "sessions");
    mkdirSync(dir, { recursive: true });
    const now = Date.parse("2026-10-22T12:00:00Z");
    const day = 86_400_000;
    const make = (name: string, ageDays: number) => {
      const p = join(dir, name);
      writeFileSync(p, `{"type":"message"}\n`.repeat(2000));
      utimesSync(p, (now - ageDays * day) / 1000, (now - ageDays * day) / 1000);
    };
    make("a.jsonl", 40); make("b.jsonl", 30); make("c.jsonl", 20); make("d.jsonl", 3);
    // Even the two newest are old: they stay because they are the newest.
    const r = archiveSessions(root, now);
    expect(r.files).toBe(2);
    expect(r.agents).toEqual(["kinwork-designer"]);
    expect(existsSync(join(dir, "d.jsonl")) && existsSync(join(dir, "c.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "a.jsonl")) || existsSync(join(dir, "b.jsonl"))).toBe(false);
    expect(Bun.gunzipSync(readFileSync(join(dir, "archive", "a.jsonl.gz"))).length).toBe(`{"type":"message"}\n`.length * 2000);
    expect(archiveSessions(root, now).files).toBe(0);
  });
});
