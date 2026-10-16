import { describe, expect, test } from "bun:test";
import { roleDescription } from "./agents.ts";

describe("roleDescription", () => {
  test("reads description from the frontmatter", () => {
    expect(roleDescription("---\nname: x\ndescription: Keeps the repo in shape.\ntools: read\n---\nbody")).toBe("Keeps the repo in shape.");
  });
  test("strips quotes and ignores body lines", () => {
    expect(roleDescription('---\ndescription: "Quoted: yes"\n---\n')).toBe("Quoted: yes");
    expect(roleDescription("no frontmatter\ndescription: nope\n")).toBe("");
  });
});

import { pickPoolArt, poolArt, poolFor } from "./agent-art.ts";
import { heartsMeterHtml } from "./quota.ts";

describe("pool portraits", () => {
  const pool = ["/art/crew/a.png", "/art/crew/b.png", "/art/crew/c.png"];
  test("same id, same pick", () => {
    expect(pickPoolArt("task-1", pool, new Set())).toBe(pickPoolArt("task-1", pool, new Set()));
  });
  test("skips portraits other live tasks wear, then shares", () => {
    const first = pickPoolArt("task-1", pool, new Set())!;
    const second = pickPoolArt("task-1", pool, new Set([first]))!;
    expect(second).not.toBe(first);
    expect(pickPoolArt("task-1", pool, new Set(pool))).toBe(first);
    expect(pickPoolArt("task-1", [], new Set())).toBeNull();
  });
  test("secondmate tasks use their own pool; shipped pools are present", () => {
    expect(poolFor("secondmate")).toBe("secondmate");
    expect(poolFor("ship")).toBe("crew");
    expect(poolArt("crew").length).toBeGreaterThan(0);
    expect(poolArt("secondmate").length).toBeGreaterThan(0);
  });
});

describe("heartsMeterHtml", () => {
  test("shows the percentage next to the hearts", () => {
    const html = heartsMeterHtml(47.6);
    expect(html).toContain(">48%</span>");
    expect(html.match(/heart-full/g)?.length).toBe(4);
    expect(html).toContain("--fill:80%");
  });
});
