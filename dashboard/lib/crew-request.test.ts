import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "crew-request-"));
const base = join(root, "ships");
const overlay = join(root, "overlay");
const inbox = join(root, "inbox");
for (const d of [base, overlay, join(inbox, ".node")]) mkdirSync(d, { recursive: true });
writeFileSync(join(base, "demo.yaml"), `id: demo\npath: ${root}\norchestrator: lead\ncrew: [lead, designer]\nmode: local-only\n`);
const prev = { b: process.env.FLEET_SHIPS_DIR, o: process.env.FLEET_SHIP_OVERLAY_DIR, i: process.env.FLEET_INBOX };
process.env.FLEET_SHIPS_DIR = base;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
process.env.FLEET_INBOX = inbox;
const { crewRequestRole } = await import("./crew-api.ts");
afterAll(() => {
  for (const [k, v] of [["FLEET_SHIPS_DIR", prev.b], ["FLEET_SHIP_OVERLAY_DIR", prev.o], ["FLEET_INBOX", prev.i]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("the lead requests a missing role", () => {
  test("a builder request becomes the captain's Go with the lead's reason", async () => {
    const r = await crewRequestRole("demo", { from: "demo-lead", role: "builder", why: "The voyage needs voyage-progress.ts and its tests written." });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("Waiting for the captain's Go");
    expect(r.message).toContain("Bring builder aboard demo. Why: The voyage needs voyage-progress.ts");
  });
  test("only the lead asks, for a real role that is not aboard, and says why", async () => {
    expect((await crewRequestRole("demo", { from: "demo-designer", role: "builder", why: "I need help with code." })).message).toContain("Only the ship's lead");
    expect((await crewRequestRole("demo", { from: "demo-lead", role: "wizard", why: "Magic is needed here." })).message).toContain("not a crew role");
    expect((await crewRequestRole("demo", { from: "demo-lead", role: "designer", why: "Another designer please." })).message).toContain("already aboard");
    expect((await crewRequestRole("demo", { from: "demo-lead", role: "scout", why: "x" })).message).toContain("Say why");
  });
});
