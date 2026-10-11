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
