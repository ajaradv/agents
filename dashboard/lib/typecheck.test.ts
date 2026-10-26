import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

// The fleet tool standard (docs/tool-standards.md): the code passes a strict typecheck.
describe("typecheck", () => {
  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  const missing = !existsSync(tsc);
  // A checkout without node_modules skips. CI must fail when tsc was not installed.
  const skip = missing && !process.env.CI;
  test.skipIf(skip)(skip ? "tsconfig.json passes with no errors (just typecheck) — skipped: node_modules/.bin/tsc is not installed" : "tsconfig.json passes with no errors (just typecheck)", () => {
    const r = Bun.spawnSync([tsc, "-p", ROOT], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const out = `${r.stdout.toString()}${r.stderr.toString()}`;
    expect(out.split("\n").filter((l) => l.includes("error TS")).slice(0, 10).join("\n")).toBe("");
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
