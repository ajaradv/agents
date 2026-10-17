import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

describe("dashboard ui.css", () => {
  test("is built from the current markup (run `just css` after adding Tailwind or daisyUI classes)", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ui-css-")), "ui.css");
    const r = Bun.spawnSync([join(root, "node_modules", ".bin", "tailwindcss"), "-i", "dashboard/ui/ui.css", "-o", out, "--minify"], { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(out, "utf8") === readFileSync(join(root, "dashboard", "public", "ui.css"), "utf8")).toBe(true);
  });
});
