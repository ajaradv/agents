import { describe, expect, test } from "bun:test";
import { missCandidates, type SearchRow } from "./search-candidates.ts";

let id = 0;
const base = Date.parse("2026-11-01T10:00:00Z");
/** A log row `sec` seconds after 10:00. */
const row = (sec: number, tool: string, query: string, refs: string[], agent = "alice"): SearchRow => ({ id: ++id, ts: new Date(base + sec * 1000).toISOString(), agent, tool, query, args: "{}", refs: JSON.stringify(refs) });

describe("missCandidates", () => {
  test("a reformulation inside 3 minutes with no shared top-3 ref marks the first search", () => {
    const a = row(0, "recall", "palette", ["x"]);
    const b = row(179, "recall", "colours", ["y"]);
    expect(missCandidates([a, b])).toMatchObject([{ id: a.id, reason: "reformulation", next: "colours", query: "palette", refs: ["x"] }]);
    const c = row(1000, "recall", "tone", ["x"]);
    const d = row(1181, "recall", "hues", ["y"]); // 3:01
    expect(missCandidates([c, d])).toEqual([]);
  });

  test("a shared ref in the top 3 is not a candidate; the fourth place does not count", () => {
    expect(missCandidates([row(0, "vault_search", "a", ["p", "q"]), row(30, "vault_search", "b", ["z", "q"])])).toEqual([]);
    expect(missCandidates([row(0, "vault_search", "a", ["p", "q", "r", "s"]), row(30, "vault_search", "b", ["s"])])).toHaveLength(1);
  });

  test("a different tool or agent is not a reformulation", () => {
    expect(missCandidates([row(0, "recall", "a", ["x"]), row(30, "vault_search", "b", ["y"])])).toEqual([]);
    expect(missCandidates([row(0, "recall", "a", ["x"]), row(30, "recall", "b", ["y"], "architect")])).toEqual([]);
  });

  test("a chain of three marks the first two, never the last for its own sake", () => {
    const q1 = row(0, "vault_search", "q1", ["a"]);
    const q2 = row(100, "vault_search", "q2", ["b"]);
    const q3 = row(200, "vault_search", "q3", ["c"]);
    expect(missCandidates([q1, q2, q3]).map((c) => c.id)).toEqual([q2.id, q1.id]);
    // compared only with the one before: q3 shares with q2, so q2 is not marked
    const r1 = row(0, "vault_search", "r1", ["a"]);
    const r2 = row(100, "vault_search", "r2", ["b"]);
    const r3 = row(200, "vault_search", "r3", ["b"]);
    expect(missCandidates([r1, r2, r3]).map((c) => c.id)).toEqual([r1.id]);
  });

  test("follow-through: a note read inside 5 minutes that the search did not return", () => {
    const s = row(0, "vault_search", "gate rules", ["a.md"]);
    expect(missCandidates([s, row(299, "vault_note", "b.md", ["b.md"])])).toMatchObject([{ id: s.id, reason: "follow-through", next: "b.md" }]);
    expect(missCandidates([row(0, "vault_search", "gate rules", ["a.md"]), row(301, "vault_note", "b.md", ["b.md"])])).toEqual([]);
    expect(missCandidates([row(0, "vault_search", "gate rules", ["a.md"]), row(60, "vault_note", "a.md", ["a.md"])])).toEqual([]);
  });

  test("follow-through reads against the latest vault_search only", () => {
    const first = row(0, "vault_search", "one", ["a.md", "b.md"]);
    const second = row(10, "vault_search", "two", ["a.md"]); // shares a.md with first: no reformulation
    const out = missCandidates([first, second, row(20, "vault_note", "b.md", ["b.md"])]);
    expect(out.map((c) => [c.id, c.reason])).toEqual([[second.id, "follow-through"]]); // b.md was in the first's refs, but only the second counts
  });

  test("paths are compared normalized (vault/x.md, ./x.md)", () => {
    const s = row(0, "vault_search", "x", ["x.md"]);
    expect(missCandidates([s, row(30, "vault_note", "vault/x.md", ["vault/x.md"])])).toEqual([]);
    expect(missCandidates([s, row(30, "vault_note", "./x.md", [])])).toEqual([]);
  });

  test("a search marked for both reasons appears once, as a reformulation; newest first", () => {
    const s1 = row(0, "vault_search", "first", ["a.md"]);
    const note = row(20, "vault_note", "z.md", ["z.md"]);
    const s2 = row(60, "vault_search", "second", ["b.md"]);
    const later = row(5000, "recall", "later", ["l"]);
    const later2 = row(5030, "recall", "later2", ["m"]);
    const out = missCandidates([s1, note, s2, later, later2]);
    expect(out.map((c) => [c.id, c.reason])).toEqual([[later.id, "reformulation"], [s1.id, "reformulation"]]);
  });
});
