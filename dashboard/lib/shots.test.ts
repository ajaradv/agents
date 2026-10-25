import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearShots, shotsUsage, unstyledError } from "./shots.ts";

describe("screenshots on disk", () => {
  test("clearing deletes only fleet-shot's files, all or those older than N days", () => {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    try {
      const old = join(dir, "shot-20261001-1-desktop.png");
      const fresh = join(dir, "shot-20261023-2-mobile.png");
      const other = join(dir, "notes.png");
      for (const f of [old, fresh, other]) writeFileSync(f, "x".repeat(100));
      const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
      utimesSync(old, tenDaysAgo, tenDaysAgo);
      expect(shotsUsage(dir)).toEqual({ files: 2, bytes: 200 });
      expect(clearShots(7, dir)).toEqual({ files: 1, bytes: 100 });
      expect([existsSync(old), existsSync(fresh)]).toEqual([false, true]);
      expect(clearShots(0, dir)).toEqual({ files: 1, bytes: 100 });
      expect(existsSync(other)).toBe(true);
      expect(clearShots(0, join(dir, "missing"))).toEqual({ files: 0, bytes: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unstyled pages", () => {
  test("a failed stylesheet refuses the shot and names it; a styled page or a bad probe does not", () => {
    const why = unstyledError(JSON.stringify(["http://localhost:8000/static/css/project.css"]));
    expect(why).toContain("http://localhost:8000/static/css/project.css");
    expect(why).toContain("unstyled");
    expect(unstyledError(JSON.stringify(["a", "b", "c", "d", "e"]))).toContain("and 2 more");
    expect(unstyledError("[]")).toBeNull();
    expect(unstyledError(undefined)).toBeNull();
    expect(unstyledError("not json")).toBeNull();
  });
});
