import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RESOLVED, reviewStatus } from "./review-status.ts";

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
