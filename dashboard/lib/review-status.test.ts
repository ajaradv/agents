import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { draftChange, RESOLVED, reviewStatus } from "./review-status.ts";

const fx = (name: string) => join(import.meta.dir, "fixtures", "reviews", name);

describe("reviewStatus", () => {
  test("the 2026-11-01 reviews are fully resolved", () => {
    const eng = reviewStatus(fx("fleet-engineer-1.md"))!;
    expect(eng.ids.length).toBe(28);
    expect(eng.resolved).toEqual(eng.ids);
    expect(eng.open).toEqual([]);
    const gold = reviewStatus(fx("goldfish-review-1.md"))!;
    expect(gold.ids.length).toBeGreaterThan(20);
    expect(gold.open).toEqual([]);
  });

  test("a finding without a resolution line stays open (a line that only starts like one does not count); an em dash and a plain hyphen both count", () => {
    expect(reviewStatus(fx("missing-line.md"))).toEqual({ ids: [1, 2, 3], resolved: [1, 3], open: [2] });
  });

  test("no Resolution section: every finding is open", () => {
    expect(reviewStatus(fx("no-resolution.md"))).toEqual({ ids: [1, 2], resolved: [], open: [1, 2] });
  });

  test("the verb is group 2 and group 1 is still the id", () => {
    expect(RESOLVED.exec("F12: decline - typed")?.slice(1)).toEqual(["12", "decline"]);
    expect(RESOLVED.exec("F3: fix")?.slice(1)).toEqual(["3", "fix"]);
    expect(RESOLVED.exec("F3: fixed it")).toBeNull();
  });

  test("a missing file is null", () => {
    expect(reviewStatus(fx("nope.md"))).toBeNull();
  });
});

describe("draftChange", () => {
  const note = (body: string, review = "", updated = "2026-11-01") => `---\ntitle: x\n${review ? `review: ${review}\n` : ""}updated: ${updated}\n---\n${body}`;
  const lines = (n: number, tag = "a") => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n");
  test("equal texts change nothing, and the total counts the non-empty lines before", () => {
    expect(draftChange(note(lines(10)), note(lines(10)))).toEqual({ changed: 0, total: 13 });
  });
  test("the review: and updated: lines do not count", () => {
    expect(draftChange(note(lines(10)), note(lines(10), "fleet/reviews/x/review-1.md", "2026-12-01")).changed).toBe(0);
  });
  test("ten lines replaced is twenty changed", () => {
    expect(draftChange(note(lines(30)), note(`${lines(20)}\n${lines(10, "b")}`)).changed).toBe(20);
  });
  test("duplicates are counted, blank lines and indentation are not", () => {
    expect(draftChange("same\nsame\nsame", "same").changed).toBe(2);
    expect(draftChange("x", "x\nx\nx").changed).toBe(2);
    expect(draftChange("a\n\n  b", "a\nb\n\n\n").changed).toBe(0);
  });
});
