import { describe, expect, test } from "bun:test";
import { toolText, VIEWS } from "./tool-out.ts";

describe("tool output for agents", () => {
  test("lists become tables of the chosen fields, timestamps short, missing as null", () => {
    const out = toolText(
      { ok: true, message: "2 event(s)", events: [
        { id: 2, ts: "2026-10-17T20:46:53.261Z", actor: "captain", kind: "shipyard", summary: "budget set", payload: { big: true } },
        { id: 1, ts: "2026-10-17T20:08:34.135Z", actor: "pochteca-helmsman", kind: "turn-end", summary: "Turn done", cost: 0.003 },
      ] },
      VIEWS.ship_log,
    );
    expect(out).toContain("result: 2 event(s)");
    expect(out).toContain("events[2]{id,ts,actor,kind,summary}:");
    expect(out).toContain('2,"10-17 20:46",captain,shipyard,budget set');
    expect(out).not.toContain("payload");
    expect(out).not.toContain("cost");
  });
  test("long text is cut with its size, and full shows all of it", () => {
    const long = "x".repeat(500);
    const res = { ok: true, message: "1 event(s)", events: [{ id: 1, ts: "t", actor: "a", kind: "k", summary: long }] };
    const cut = toolText(res, VIEWS.ship_log);
    expect(cut).toContain("… (500 chars)");
    expect(cut).toContain("full=true");
    const full = toolText(res, VIEWS.ship_log, { full: true });
    expect(full).toContain(long);
    expect(full).not.toContain("full=true");
  });
  test("empty lists say so", () => {
    expect(toolText({ ok: true, message: "pochteca is not under sail.", voyage: null, tasks: [] }, VIEWS.ship_tasks)).toContain("tasks: 0 tasks on this voyage");
    expect(toolText({ ok: true, message: "none", hits: [] }, VIEWS.recall)).toContain("hits: 0 matches");
  });
  test("errors come back as error with help", () => {
    const out = toolText({ ok: false, message: "No ship named nope." }, { help: () => ["fleet_status lists the ships"] });
    expect(out).toContain("error: No ship named nope.");
    expect(out).toContain("fleet_status lists the ships");
    expect(out).not.toContain("result:");
  });
  test("voyage status: waits as task numbers, a claim hint when something is free", () => {
    const out = toolText(
      { ok: true, message: "under sail", tasks: [{ id: 1, title: "Recon", assignee: "p-scout", status: "done", note: "" }, { id: 2, title: "Build", assignee: null, status: "open", waitingOn: [1], role: "designer", note: "" }], ready: [{ id: 3, title: "Docs", assignee: null }] },
      VIEWS.voyage_status,
    );
    expect(out).toContain("2,Build,null,open,#1,designer,null");
    expect(out).toContain("task_claim <id>");
  });
  test("counts appear on longer lists", () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ source: "chat:a", ts: "2026-10-17T00:00:00Z", snippet: `hit ${i}` }));
    expect(toolText({ ok: true, message: "5 match(es)", hits }, VIEWS.recall)).toContain("hits_count: 5");
  });
  test("a list of plain lines stays a list, not a table", () => {
    const out = toolText({ ok: true, message: "2 ships", ships: ["fleet: no voyage", "pochteca: no voyage"] }, VIEWS.fleet_status);
    expect(out).toContain('ships[2]: "fleet: no voyage","pochteca: no voyage"');
  });
});
