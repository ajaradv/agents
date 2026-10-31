import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prev = process.env.FLEET_INBOX;
const j = await import("./journal.ts");
const f = await import("./facts.ts");
afterAll(() => {
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});
beforeEach(() => {
  j._closeJournal();
  process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "facts-"));
});

const set = (o: Partial<Parameters<typeof f.factSet>[0]> = {}) => f.factSet({ subject: "hub", key: "host", value: "laptop", source: "captain in chat 2026-10-20", by: "alice", ...o });

describe("fact_set", () => {
  test("a new value supersedes the old one and says what it replaced; nothing is deleted", () => {
    expect(set().message).toContain("new fact");
    const r = set({ value: "exe.dev fleet-hub-k1s7", now: new Date("2026-10-26T10:00:00Z") });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("hub.host: laptop → exe.dev fleet-hub-k1s7");
    const cur = f.factGet({ subject: "hub", key: "host" }).facts as { value: string }[];
    expect(cur.map((x) => x.value)).toEqual(["exe.dev fleet-hub-k1s7"]);
    const chain = f.factGet({ subject: "hub", key: "host", history: true }).facts as { value: string; superseded_by?: number; id: number }[];
    expect(chain.map((x) => x.value)).toEqual(["exe.dev fleet-hub-k1s7", "laptop"]);
    expect(chain[1]!.superseded_by).toBe(chain[0]!.id);
  });

  test("the same value and source is a no-op", () => {
    set();
    const r = set();
    expect(r.message).toContain("unchanged");
    expect((f.factGet({ subject: "hub", key: "host", history: true }).facts as unknown[]).length).toBe(1);
  });

  test("the same value with a new source corrects the source: a new row, the old one superseded", () => {
    set();
    const r = set({ source: "captain in chat 2026-10-21" });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('hub.host: source corrected ("captain in chat 2026-10-20" → "captain in chat 2026-10-21"); value unchanged.');
    const chain = f.factGet({ subject: "hub", key: "host", history: true }).facts as { value: string; source: string; superseded_by?: number; id: number }[];
    expect(chain.map((x) => [x.value, x.source])).toEqual([["laptop", "captain in chat 2026-10-21"], ["laptop", "captain in chat 2026-10-20"]]);
    expect(chain[1]!.superseded_by).toBe(chain[0]!.id);
    expect((f.factGet({ subject: "hub", key: "host" }).facts as unknown[]).length).toBe(1);
  });

  test("names are normalised; bad names, long values, and a missing source are refused", () => {
    expect(set({ subject: "  Hub ", key: "HOST" }).message).toContain("hub.host");
    expect(set({ subject: "my hub" }).ok).toBe(false);
    expect(set({ key: "x".repeat(65) }).ok).toBe(false);
    expect(set({ key: "" }).ok).toBe(false);
    expect(set({ value: "v".repeat(501) }).message).toContain("limit is 500");
    expect(set({ value: "v".repeat(500), key: "long" }).ok).toBe(true);
    expect(set({ source: "" }).message).toContain("source");
    expect(set({ source: "s".repeat(201) }).ok).toBe(false);
    expect(set({ value: "  " }).ok).toBe(false);
  });

  test("fact_get filters, orders newest first, and needs both names for history", () => {
    set();
    set({ subject: "alice", key: "model", value: "deepseek-v4-pro" });
    set({ subject: "alice", key: "owner", value: "captain" });
    const all = f.factGet().facts as { subject: string; key: string }[];
    expect(all.map((x) => `${x.subject}.${x.key}`)).toEqual(["alice.owner", "alice.model", "hub.host"]);
    expect((f.factGet({ subject: "alice" }).facts as unknown[]).length).toBe(2);
    expect(f.factGet({ key: "host" }).message).toBe("1 current fact(s) for host");
    expect(f.factGet({ subject: "zzz" }).message).toBe("0 facts for zzz");
    expect(f.factGet({ history: true, subject: "hub" }).ok).toBe(false);
    expect(f.factGet({ subject: "bad name" }).ok).toBe(false);
  });
});

describe("fact_set retire", () => {
  const retire = (o: Partial<Parameters<typeof f.factSet>[0]> = {}) => f.factSet({ subject: "hub", key: "host", source: "renamed to fleet-hub.host", retire: true, by: "alice", now: new Date("2026-10-28T10:00:00Z"), ...o });

  test("closes the current fact with no replacement; get and the brief stop listing it", () => {
    set({ key: "since", value: "2026-10-26" });
    set();
    const r = retire({ key: "since", source: "past event" });
    expect(r.message).toBe("hub.since retired (was 2026-10-26): past event");
    expect((f.factGet({ subject: "hub", key: "since" }).facts as unknown[]).length).toBe(0);
    expect((f.factGet().facts as { key: string }[]).map((x) => x.key)).toEqual(["host"]);
    expect(f.factsBrief(1200)).toBe("- hub.host = laptop\n");
  });
  test("history shows the retirement with its reason and when", () => {
    set();
    retire();
    const chain = f.factGet({ subject: "hub", key: "host", history: true }).facts as { value: string; source: string; since: string }[];
    expect(chain.map((x) => x.value)).toEqual(["(retired)", "laptop"]);
    expect(chain[0]!.source).toBe("renamed to fleet-hub.host");
    expect(chain[0]!.since).toBe("2026-10-28T10:00");
  });
  test("retiring what has no current row is an error naming it and the current keys", () => {
    set({ key: "since", value: "x" });
    const r = retire();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("hub.host");
    expect(r.message).toContain("since");
    expect(retire({ source: "" }).ok).toBe(false);
    set();
    retire();
    expect(retire().ok).toBe(false);
  });
  test("setting the same value and source as a retired fact starts a fresh fact", () => {
    set();
    retire();
    const r = set();
    expect(r.message).toContain("new fact");
    expect((f.factGet({ subject: "hub", key: "host" }).facts as unknown[]).length).toBe(1);
  });
  test("a later value starts a fresh current fact; the history keeps the retirement", () => {
    set();
    retire();
    expect(set({ value: "exe.dev" }).message).toContain("new fact");
    expect((f.factGet({ subject: "hub", key: "host" }).facts as { value: string }[]).map((x) => x.value)).toEqual(["exe.dev"]);
    const chain = f.factGet({ subject: "hub", key: "host", history: true }).facts as { value: string }[];
    expect(chain.map((x) => x.value)).toEqual(["exe.dev", "(retired)", "laptop"]);
  });
});

describe("facts brief", () => {
  test("lists current facts, most recently set first, and says how many were cut", () => {
    set();
    set({ subject: "alice", key: "model", value: "deepseek" });
    expect(f.factsBrief(1200)).toBe("- alice.model = deepseek\n- hub.host = laptop\n");
    for (let i = 0; i < 40; i++) set({ subject: "s", key: `k${i}`, value: "v".repeat(100) });
    const b = f.factsBrief(600);
    expect(Buffer.byteLength(b)).toBeLessThanOrEqual(600);
    expect(b).toMatch(/- \(\d+ more: fact_get\)\n$/);
    expect(b.startsWith("- s.k39")).toBe(true);
  });
  test("empty with no facts", () => {
    expect(f.factsBrief(1200)).toBe("");
  });
});

describe("observations", () => {
  const now = new Date("2026-10-30T00:00:00Z");
  test("show until they expire; ttl defaults to 14 days and is capped at 90", () => {
    const a = f.logObservation({ text: "Hub feels slow", subject: "hub", by: "alice", now });
    const b = f.logObservation({ text: "short", ttlDays: 1, by: "alice", now });
    const c = f.logObservation({ text: "long", ttlDays: 500, by: "alice", now });
    expect(a.message).toContain("14 days");
    expect(c.message).toContain("90 days");
    const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
    const ids = (d: Date) => (f.listObservations({ now: d }).observations as { id: number }[]).map((o) => o.id);
    expect(ids(day(0))).toEqual([c.id, b.id, a.id] as number[]);
    expect(ids(day(2))).toEqual([c.id, a.id] as number[]);
    expect(ids(day(15))).toEqual([c.id] as number[]);
    expect(ids(day(91))).toEqual([]);
    expect((f.listObservations({ subject: "hub", now }).observations as unknown[]).length).toBe(1);
  });
  test("limits and bad subjects", () => {
    expect(f.logObservation({ text: "x".repeat(301), by: "alice" }).ok).toBe(false);
    expect(f.logObservation({ text: "", by: "alice" }).ok).toBe(false);
    expect(f.logObservation({ text: "ok", subject: "bad subject", by: "alice" }).ok).toBe(false);
  });
  test("fact_set with an observation promotes it, and it stops showing; an unknown id writes nothing", () => {
    const o = f.logObservation({ text: "hub moved?", by: "alice" });
    expect(set({ observation: 999 }).ok).toBe(false);
    expect((f.factGet().facts as unknown[]).length).toBe(0);
    const r = set({ observation: o.id as number });
    expect(r.message).toContain(`Observation ${o.id} promoted`);
    expect((f.listObservations().observations as unknown[]).length).toBe(0);
  });
});
