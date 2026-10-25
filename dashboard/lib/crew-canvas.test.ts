import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "crew-canvas-"));
const base = join(root, "ships");
const overlay = join(root, "overlay");
const inbox = join(root, "inbox");
for (const d of [base, overlay, join(inbox, ".node")]) mkdirSync(d, { recursive: true });
writeFileSync(join(base, "demo.yaml"), `id: demo\npath: ${root}\norchestrator: lead\ncrew: [lead, designer]\nmode: local-only\n`);
const prev = { b: process.env.FLEET_SHIPS_DIR, o: process.env.FLEET_SHIP_OVERLAY_DIR, i: process.env.FLEET_INBOX };
process.env.FLEET_SHIPS_DIR = base;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
process.env.FLEET_INBOX = inbox;
const { crewCanvas } = await import("./crew-api.ts");
afterAll(() => {
  for (const [k, v] of [["FLEET_SHIPS_DIR", prev.b], ["FLEET_SHIP_OVERLAY_DIR", prev.o], ["FLEET_INBOX", prev.i]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const item = b64(JSON.stringify({ id: "comps", title: "Comps", kind: "image", images: [{ file: "01-a.png", label: "a" }] }));

describe("canvas items from another ship host (S3a)", () => {
  test("an item lands in the crewmate's canvas on the hub, and clears", async () => {
    const r = await crewCanvas("demo", { from: "demo-designer", id: "comps", files: { "item.json": item, "01-a.png": b64("png") } });
    expect(r.ok).toBe(true);
    const dir = join(inbox, "demo-designer", "canvas", "comps");
    expect(JSON.parse(readFileSync(join(dir, "item.json"), "utf8")).title).toBe("Comps");
    expect(readFileSync(join(dir, "01-a.png"), "utf8")).toBe("png");
    expect((await crewCanvas("demo", { from: "demo-designer", id: "comps", clear: true })).ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
  test("paths stay inside the item; only crew aboard; item.json required", async () => {
    for (const rel of ["../escape.png", "/etc/x", "site/../../x", ".hidden"]) {
      expect((await crewCanvas("demo", { from: "demo-designer", id: "x", files: { "item.json": item, [rel]: b64("x") } })).message).toContain("Not a path inside the item");
    }
    expect(existsSync(join(inbox, "escape.png"))).toBe(false);
    expect((await crewCanvas("demo", { from: "demo-builder", id: "x", files: { "item.json": item } })).ok).toBe(false);
    expect((await crewCanvas("demo", { from: "demo-designer", id: "x", files: { "a.png": b64("x") } })).message).toContain("no item.json");
    expect((await crewCanvas("demo", { from: "demo-designer", id: "../x", files: { "item.json": item } })).message).toContain("canvas item id");
  });
});
