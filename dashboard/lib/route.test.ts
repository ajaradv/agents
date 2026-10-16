import { describe, expect, test } from "bun:test";
import { parseRouteOutput } from "./route.ts";

describe("parseRouteOutput", () => {
  test("clear group answer resolves to the lead", () => {
    const r = parseRouteOutput(
      "route-resolve:\n  status: clear\n  choice: group_upkeep\n  target: group:upkeep\n  send_to: shipwright\n  confidence: 0.9\n  probabilities: group_upkeep=0.9 firstmate=0.1\n",
    );
    expect(r).toEqual({
      status: "clear",
      choice: "group_upkeep",
      target: "group:upkeep",
      sendTo: "shipwright",
      confidence: 0.9,
      probabilities: [{ key: "group_upkeep", p: 0.9 }, { key: "firstmate", p: 0.1 }],
      reason: undefined,
    });
  });

  test("off line on stderr", () => {
    const r = parseRouteOutput("", "route-resolve: off (TYPESAFE_API_KEY absent)\n");
    expect(r.status).toBe("off");
    expect(r.reason).toBe("TYPESAFE_API_KEY absent");
  });
});
