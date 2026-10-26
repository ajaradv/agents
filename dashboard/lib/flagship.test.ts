import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "flagship-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const { OFFICER_SHIP } = await import("./ship-events.ts");
const view = await import("./ship-view.ts");
const { logShipEvent } = await import("./ship-log.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

describe("the Flagship", () => {
  test("officers log on the Flagship, not on the fleet ship (the agents repo)", () => {
    expect(OFFICER_SHIP).toBe("flagship");
  });

  test("its deck holds the officers, the decision queue, orders, and the officers' log; it has no voyage panel", async () => {
    logShipEvent(OFFICER_SHIP, "router", "router", "Woke alice: done");
    const html = (await view.shipDeckHtml(OFFICER_SHIP))!;
    expect(html).toContain("Flagship");
    expect(html).toContain("Officers");
    expect(html).toContain("Decision queue");
    expect(html).toContain("Flagship's log");
    expect(html).toContain("Woke alice: done");
    expect(html).not.toContain("Set a course");
  });

  test("officers are not crew of the fleet ship", () => {
    const fleet = { id: "fleet", crew: ["lead"] } as never;
    expect(view.crewCards(fleet, []).every((c) => c.target.ship === "fleet")).toBe(true);
  });
});
