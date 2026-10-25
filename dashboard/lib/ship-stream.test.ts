import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logShipEvent } from "./ship-log.ts";
import { cursorAtEnd, decodeCursor, encodeCursor, eventsAfter, sseFrame } from "./ship-stream.ts";

const root = mkdtempSync(join(tmpdir(), "ship-stream-"));
const log = (ship: string, kind: string, ts: string) => logShipEvent(ship, "captain", kind, `${ship} ${kind}`, { n: 1 }, { root, ts });

describe("one stream over every ship's log (S3c)", () => {
  test("the cursor round-trips and ignores junk", () => {
    expect(encodeCursor({ pochteca: 617, fleet: 1720, kinwork: 0 })).toBe("fleet:1720,pochteca:617");
    expect(decodeCursor("fleet:1720,pochteca:617, bad, x:y, ../a:1")).toEqual({ fleet: 1720, pochteca: 617 });
  });

  test("a client follows a voyage across ships, and resumes from its last id without loss", () => {
    log("alpha", "voyage-start", "2026-10-25T01:00:00.000Z");
    log("beta", "voyage-start", "2026-10-25T01:00:01.000Z");
    log("alpha", "task", "2026-10-25T01:00:02.000Z");
    const first = eventsAfter({}, ["alpha", "beta"], 2, root);
    expect(first.events.map((e) => `${e.ship}:${e.kind}`)).toEqual(["alpha:voyage-start", "beta:voyage-start"]);
    expect(first.events[0]!.payload).toEqual({ n: 1 });
    // The SSE id after the second event is where a reconnect resumes.
    const frame = sseFrame(first.events[1]!, first.cursor);
    const lastId = frame.match(/^id: (.*)$/m)![1]!;
    log("beta", "voyage-end", "2026-10-25T01:00:03.000Z");
    const rest = eventsAfter(decodeCursor(lastId), ["alpha", "beta"], 200, root);
    expect(rest.events.map((e) => `${e.ship}:${e.kind}`)).toEqual(["alpha:task", "beta:voyage-end"]);
    expect(eventsAfter(rest.cursor, ["alpha", "beta"], 200, root).events).toEqual([]);
  });

  test("starting at the end skips the backlog; a ship with no log is left out", () => {
    const end = cursorAtEnd(["alpha", "beta", "nolog"], root);
    expect(end).toEqual({ alpha: 2, beta: 2 });
    expect(eventsAfter(end, ["alpha", "beta", "nolog"], 200, root).events).toEqual([]);
    log("alpha", "turn-end", "2026-10-25T01:00:04.000Z");
    expect(eventsAfter(end, ["alpha"], 200, root).events.map((e) => e.kind)).toEqual(["turn-end"]);
  });
});
