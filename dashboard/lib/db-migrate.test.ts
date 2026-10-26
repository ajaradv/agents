import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, type Migration } from "./db-migrate.ts";
import { ulid } from "./ulid.ts";

const version = (d: Database) => (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const list: Migration[] = [
  { version: 1, note: "a", up: "CREATE TABLE a (x INTEGER)" },
  { version: 2, note: "b", up: (d) => d.exec("CREATE TABLE b (x INTEGER)") },
];

describe("migrate", () => {
  test("two processes on one file: the second finds the work done (node and dashboard start together)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mig-")), "x.db");
    const a = new Database(file, { create: true });
    const b = new Database(file, { create: true });
    // b read version 0 before a migrated: simulate by migrating a, then running b's stale plan.
    const nonIdempotent: Migration[] = [{ version: 1, note: "add col", up: "CREATE TABLE t (x INTEGER); ALTER TABLE t ADD COLUMN y TEXT" }];
    expect(migrate(a, nonIdempotent, "x.db").applied).toEqual([1]);
    expect(migrate(b, nonIdempotent, "x.db").applied).toEqual([]);
    expect(version(b)).toBe(1);
  });

  test("a fresh database applies all; a re-run applies none", () => {
    const d = new Database(":memory:");
    expect(migrate(d, list, "t")).toEqual({ from: 0, to: 2, applied: [1, 2] });
    expect(version(d)).toBe(2);
    expect(migrate(d, list, "t")).toEqual({ from: 2, to: 2, applied: [] });
  });
  test("a failing migration rolls back only itself", () => {
    const d = new Database(":memory:");
    const bad: Migration[] = [...list, { version: 3, note: "boom", up: (db) => { db.exec("CREATE TABLE c (x INTEGER)"); throw new Error("nope"); } }];
    expect(() => migrate(d, bad, "t.db")).toThrow(/t\.db: migration 3 \(boom\) failed.*version 2.*nope/);
    expect(version(d)).toBe(2);
    expect(d.query("SELECT name FROM sqlite_master WHERE name = 'c'").get()).toBeNull();
    expect(d.query("SELECT name FROM sqlite_master WHERE name = 'b'").get()).not.toBeNull();
  });
  test("versions that are not 1..n in order throw", () => {
    const d = new Database(":memory:");
    expect(() => migrate(d, [list[1]!], "t")).toThrow(/numbered 1\.\.n/);
    expect(() => migrate(d, [list[0]!, { version: 3, note: "gap", up: "" }], "t")).toThrow(/numbered 1\.\.n/);
    expect(() => migrate(d, [list[1]!, list[0]!], "t")).toThrow(/numbered 1\.\.n/);
  });
});

describe("ulid", () => {
  test("26 Crockford characters that sort by time", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(1_000) < ulid(2_000)).toBe(true);
    expect(ulid(Date.now()) < ulid(Date.now() + 86_400_000)).toBe(true);
    expect(ulid(5)).not.toBe(ulid(5));
  });
});
