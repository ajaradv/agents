import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "budget-hold-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { heldLines, holdForBudget, releaseHeld } = await import("./budget-hold.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

describe("messages held over budget", () => {
  test("a refused line is held once; the captain hears once a day per agent", () => {
    const day1 = new Date("2026-10-19T16:21:00Z");
    expect(holdForBudget("fleet-builder", { ts: "t1", from: "fleet-lead" }, day1)).toEqual({ fresh: true, tellCaptain: true });
    expect(holdForBudget("fleet-builder", { ts: "t1", from: "fleet-lead" }, day1)).toEqual({ fresh: false, tellCaptain: false });
    expect(holdForBudget("fleet-builder", { ts: "t2", from: "fleet-lead" }, day1)).toEqual({ fresh: true, tellCaptain: false });
    expect(holdForBudget("fleet-designer", { ts: "t3", from: "fleet-lead" }, day1).tellCaptain).toBe(true);
    expect(holdForBudget("fleet-builder", { ts: "t4", from: "fleet-lead" }, new Date("2026-10-20T09:00:00Z")).tellCaptain).toBe(true);
    expect(heldLines().map((h) => h.ts)).toEqual(["t1", "t2", "t3", "t4"]);
  });
  test("only agents back under budget are delivered, and each line only once", async () => {
    const delivered: string[] = [];
    const deliver = async (h: { ts: string }) => void delivered.push(h.ts);
    const stillSpent = async (agent: string) => (agent === "fleet-designer" ? "spent" : null);
    expect((await releaseHeld(stillSpent, deliver)).map((h) => h.ts)).toEqual(["t1", "t2", "t4"]);
    expect(delivered).toEqual(["t1", "t2", "t4"]);
    expect(heldLines().map((h) => h.ts)).toEqual(["t3"]);
    expect(await releaseHeld(stillSpent, deliver)).toEqual([]);
    expect(delivered).toEqual(["t1", "t2", "t4"]);
  });
});
