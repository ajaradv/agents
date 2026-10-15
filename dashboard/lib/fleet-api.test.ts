import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetCallerAllowed, fleetChat } from "./fleet-api.ts";
import { logShipEvent } from "./ship-log.ts";
import { officerBudgetRefusal } from "./shipyard.ts";

describe("fleet API caller", () => {
  test("only officers on the list, identified by token, may call", () => {
    expect(fleetCallerAllowed("alice")).toBe(true);
    expect(fleetCallerAllowed("kinwork-designer")).toBe(false);
    expect(fleetCallerAllowed(null)).toBe(false);
  });
  test("fleet_chat refuses empty text, itself, and agents not on the rail", async () => {
    expect((await fleetChat("alice", "kinwork-designer", "  ")).message).toBe("Empty message.");
    expect((await fleetChat("alice", "alice", "hi")).ok).toBe(false);
    expect((await fleetChat("alice", "nobody-here", "hi")).message).toContain("not on the rail");
  });
});

describe("officer daily budget", () => {
  test("refuses once today's spend in the fleet log reaches the budget", () => {
    const prev = process.env.FLEET_INBOX;
    process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "fleet-budget-"));
    try {
      expect(officerBudgetRefusal("alice", undefined)).toBeNull();
      logShipEvent("fleet", "alice", "turn-end", "Turn done in 4s", { ms: 4000, cost: 2.5, tokens: 100 });
      expect(officerBudgetRefusal("alice", 6)).toBeNull();
      logShipEvent("fleet", "alice", "turn-end", "Turn done in 9s", { ms: 9000, cost: 3.6, tokens: 100 });
      expect(officerBudgetRefusal("alice", 6)).toContain("has spent $6.10 of its $6.00 daily budget");
    } finally {
      if (prev === undefined) delete process.env.FLEET_INBOX;
      else process.env.FLEET_INBOX = prev;
    }
  });
});
