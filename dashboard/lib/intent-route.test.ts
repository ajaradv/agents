import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "intent-"));
const ships = join(tmp, "ships");
mkdirSync(ships);
writeFileSync(join(ships, "kinwork.yaml"), "id: kinwork\ncrew:\n  - lead\n  - builder\n");
writeFileSync(join(ships, "solo.yaml"), "id: solo\ncrew: []\n");
const says = (choice: string, confidence: number, seen?: { state?: unknown }) =>
  (async (_use: string, state: unknown) => {
    if (seen) seen.state = state;
    return { ok: true, answers: { owner: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } }, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 };
  }) as never;

const saved = { inbox: process.env.FLEET_INBOX, ships: process.env.FLEET_SHIPS_DIR, overlay: process.env.FLEET_SHIP_OVERLAY_DIR };
const { intentOptions, intentReport, labelIntent, observeIntent, routeIntent } = await import("./intent-route.ts");
const { _closeJournal, journalDb } = await import("./journal.ts");

describe("intent routing", () => {
  // Set for this describe only: a top-level afterAll runs after the other files' tests, so the env would leak into them.
  beforeAll(() => {
    process.env.FLEET_INBOX = join(tmp, "inbox");
    process.env.FLEET_SHIPS_DIR = ships;
    process.env.FLEET_SHIP_OVERLAY_DIR = join(tmp, "overlay");
  });
  afterAll(() => {
    _closeJournal();
    for (const [k, v] of [["FLEET_INBOX", saved.inbox], ["FLEET_SHIPS_DIR", saved.ships], ["FLEET_SHIP_OVERLAY_DIR", saved.overlay]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("options come from the roles and the ships whose crew has a lead", () => {
    const names = intentOptions().map((o) => o.name);
    expect(names).toEqual(["alice", "architect", "designer", "kinwork-lead"]);
    expect(intentOptions().find((o) => o.name === "architect")?.criteria).toContain("Designs features");
  });
  test("a verdict is logged with a redacted, capped excerpt, and the state carries the message and ships", async () => {
    const seen: { state?: { message: string; ships: string[] } } = {};
    const text = `Plan the billing page. OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz ${"x".repeat(400)}`;
    const r = await routeIntent("alice", { ts: "2026-10-30T10:00:00Z", text }, says("architect", 0.92, seen as never));
    expect(r.verdict?.choice).toBe("architect");
    expect(seen.state?.message).not.toContain("abcdefghijklmnop");
    expect(seen.state?.ships).toEqual(["kinwork"]);
    const row = journalDb().query("SELECT * FROM intent_routes").get() as { excerpt: string; label: string | null; line_ts: string };
    expect(row.excerpt.length).toBeLessThanOrEqual(200);
    expect(row.excerpt).not.toContain("abcdefghijklmnop");
    expect(row.label).toBeNull();
    expect(row.line_ts).toBe("2026-10-30T10:00:00Z");
  });
  test("no Jev answer logs nothing", async () => {
    const before = (journalDb().query("SELECT COUNT(*) AS n FROM intent_routes").get() as { n: number }).n;
    const r = await routeIntent("alice", { ts: "t", text: "hi" }, (async () => ({ ok: false, error: "down" })) as never);
    expect(r.ok).toBe(false);
    expect((journalDb().query("SELECT COUNT(*) AS n FROM intent_routes").get() as { n: number }).n).toBe(before);
  });
  test("labels are checked against the options; accuracy is per confidence bucket", async () => {
    await routeIntent("alice", { ts: "a", text: "status?" }, says("alice", 0.95));
    await routeIntent("alice", { ts: "b", text: "fix kinwork search" }, says("kinwork-lead", 0.5));
    const rows = intentReport({ days: 1 }).rows;
    const id = (choice: string) => rows.find((r) => r.choice === choice)!.id;
    expect(labelIntent(id("alice"), "alice").ok).toBe(true);
    expect(labelIntent(id("architect"), "designer").ok).toBe(true);
    expect(labelIntent(id("kinwork-lead"), "nobody").ok).toBe(false);
    expect(labelIntent(9999, "alice").ok).toBe(false);
    const r = intentReport({ days: 1 });
    expect(r.perChoice).toEqual({ architect: 1, alice: 1, "kinwork-lead": 1 });
    expect(r.buckets.find((b) => b.bucket === ">=0.9")).toMatchObject({ count: 2, labelled: 2, right: 1, accuracy: 0.5 });
    expect(r.buckets.find((b) => b.bucket === "<0.6")).toMatchObject({ count: 1, labelled: 0, accuracy: null });
    expect(intentReport({ days: 1, unlabelledOnly: true }).rows.map((x) => x.choice)).toEqual(["kinwork-lead"]);
  });
  test("only the captain's chat lines to Alice are asked about, and off switches it off", async () => {
    const count = () => (journalDb().query("SELECT COUNT(*) AS n FROM intent_routes").get() as { n: number }).n;
    const before = count();
    const line = (over: object) => ({ ts: `${Math.random()}`, from: "captain", kind: "chat" as const, text: "hello", ...over });
    observeIntent("architect", line({}));
    observeIntent("alice", line({ from: "orders", kind: "crew" }));
    observeIntent("alice", line({ kind: "answer" }));
    process.env.FLEET_INTENT_ROUTE = "off";
    observeIntent("alice", line({}));
    delete process.env.FLEET_INTENT_ROUTE;
    await Bun.sleep(20);
    expect(count()).toBe(before);
  });
});
