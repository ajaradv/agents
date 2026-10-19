import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every endpoint extensions/crew.ts calls must be accepted by the node's /api/crew route:
// the look, crew_request, and voyage_dock tools first shipped "not found" because the
// route's list of names was not updated.
describe("crew tool routes", () => {
  test("each crew tool endpoint is served by the node", () => {
    const ext = readFileSync(join(import.meta.dir, "..", "..", "extensions", "crew.ts"), "utf8");
    const node = readFileSync(join(import.meta.dir, "..", "node.ts"), "utf8");
    const route = node.match(/\/\^\\\/api\\\/crew\\\/\(\[a-z\]\[a-z0-9_-\]\{0,40\}\)\\\/\(([^)]+)\)/);
    expect(route).not.toBeNull();
    const served = new Set(route![1]!.split("|"));
    const called = [...ext.matchAll(/call\("(?:GET|POST)", [`"]([a-z-]+)/g)].map((m) => m[1]!);
    expect(called.length).toBeGreaterThan(5);
    for (const what of called) expect([what, served.has(what)]).toEqual([what, true]);
  });
});
