import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNextItem, parseRoadmap, readRoadmap, readRoadmaps, roadmapStaleness, shipNext, shipNextReport } from "./roadmap.ts";
import { toolText, VIEWS } from "./tool-out.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "roadmap-pochteca.md"), "utf8");
const SHA = "0123456789abcdef0123456789abcdef01234567";

function vaultWith(ship: string, text: string): string {
  const root = mkdtempSync(join(tmpdir(), "roadmap-vault-"));
  mkdirSync(join(root, "ships", ship), { recursive: true });
  writeFileSync(join(root, "ships", ship, "roadmap.md"), text);
  return root;
}

function repo(): { dir: string; sha: string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "roadmap-repo-"));
  const run = (...a: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  run("init", "-q", "-b", "main");
  const commit = (msg: string) => {
    run("commit", "-q", "--allow-empty", "-m", msg);
    return run("rev-parse", "HEAD");
  };
  return { dir, sha: commit("first"), commit };
}

describe("parseRoadmap", () => {
  const r = parseRoadmap(FIXTURE, "pochteca");

  test("frontmatter", () => {
    expect(r.updated).toBe("2026-11-02");
    expect(r.updatedBy).toBe("architect");
    expect(r.sourcesRepo).toBe(SHA);
    expect(r.summary).toContain("Execution engine");
  });

  test("now, recently done and open questions", () => {
    expect(r.now).toStartWith("P3, the Ehecatl");
    expect(r.recentlyDone).toEqual(["Signal store migration (PR #41)", "Feed reconnect backoff (voyage 2026-10-28)"]);
    expect(r.openQuestions).toHaveLength(2);
    expect(r.openQuestions[0]).toContain("Rust");
  });

  test("milestones table", () => {
    expect(r.milestones).toEqual([
      { id: "P2", milestone: "Signal pipeline", status: "done", doneWhen: "signals flow from the feed to the store" },
      { id: "P3", milestone: "Ehecatl execution engine (skeleton)", status: "in progress", doneWhen: "a devnet trade goes through the pipeline end to end" },
      { id: "P4", milestone: "Risk limits", status: "planned", doneWhen: "the engine refuses a trade over the daily limit" },
    ]);
  });

  test("next up items, in order, with milestone, size and readiness", () => {
    expect(r.nextUp.map((i) => [i.n, i.title, i.milestone, i.size, i.ready])).toEqual([
      [1, "Spec Ehecatl's protobuf contracts", "P3", "M", "spec-session"],
      [2, "Wire the devnet feed into the engine", "P3", "L", "ready to sail"],
      [3, "Design the risk-limit config", "P4", "S", "design-session"],
      [4, "Pick the production RPC provider", "P4", "S", "needs the captain"],
    ]);
    expect(r.nextUp[0]!.why).toBe("everything downstream reads them.");
    expect(r.nextUp[0]!.raw).toStartWith("**Spec Ehecatl");
  });

  test("a note with no sections gives empty parts, not an error", () => {
    const e = parseRoadmap("---\ntype: roadmap\nupdated: 2026-11-02\n---\n\nJust prose.\n", "x");
    expect(e).toMatchObject({ now: "", milestones: [], nextUp: [], recentlyDone: [], openQuestions: [], summary: "" });
  });

  test("no frontmatter at all", () => {
    const e = parseRoadmap("## Now\nSomething.\n", "x");
    expect(e.now).toBe("Something.");
    expect(e.updated).toBe("");
  });

  test("a section missing among others, and a 'none' placeholder", () => {
    const e = parseRoadmap("---\nupdated: 2026-11-02\n---\n## Next up\n1. **Only** (A1), size S, ready: ready to sail.\n\n## Open questions for the captain\n- None\n", "x");
    expect(e.nextUp).toHaveLength(1);
    expect(e.openQuestions).toEqual([]);
    expect(e.milestones).toEqual([]);
  });

  test("an unquoted date is read whether yaml gives a string or a Date", () => {
    expect(parseRoadmap("---\nupdated: 2026-11-02T08:00:00Z\n---\n", "x").updated).toBe("2026-11-02");
  });

  test("a milestones table without a header row of known names falls back to column order", () => {
    const e = parseRoadmap("## Milestones\n| a | b | c | d |\n|---|---|---|---|\n| P1 | One | done | it works |\n", "x");
    expect(e.milestones).toEqual([{ id: "P1", milestone: "One", status: "done", doneWhen: "it works" }]);
  });
});

describe("parseNextItem", () => {
  test("odd punctuation and bare readiness words", () => {
    const a = parseNextItem("**Fix the _thing_** — (SR2) size: L; ready: Needs a spec session! Why: it blocks", 1);
    expect(a).toMatchObject({ title: "Fix the _thing_", milestone: "SR2", size: "L", ready: "spec-session" });
    const b = parseNextItem("**Ship it**, size m, ready to sail", 2);
    expect(b).toMatchObject({ title: "Ship it", milestone: "", size: "M", ready: "ready to sail" });
  });

  test("no bold title, no parts", () => {
    const a = parseNextItem("Write the docs, size S", 1);
    expect(a).toMatchObject({ title: "Write the docs", milestone: "", size: "S", ready: "" });
    expect(a.raw).toBe("Write the docs, size S");
  });

  test("an unknown readiness stays as written", () => {
    expect(parseNextItem("**X** (P1), size S, ready: after the audit. Why: y", 1).ready).toBe("after the audit");
  });

  test("a size in parentheses is not taken for the milestone", () => {
    expect(parseNextItem("**X** (M), size M, ready: ready to sail", 1).milestone).toBe("");
  });

  test("continuation lines are folded into the item", () => {
    const e = parseRoadmap("## Next up\n1. **First** (A1), size S,\n   ready: spec-session.\n2. **Second**\n", "x");
    expect(e.nextUp).toHaveLength(2);
    expect(e.nextUp[0]!.ready).toBe("spec-session");
  });
});

describe("staleness", () => {
  const now = new Date("2026-11-05T12:00:00Z");

  test("by date: over 8 days is stale, 8 is not", () => {
    expect(roadmapStaleness({ updated: "2026-11-02", sourcesRepo: SHA }, undefined, now)).toEqual([]);
    expect(roadmapStaleness({ updated: "2026-10-28", sourcesRepo: SHA }, undefined, now)).toEqual([]);
    expect(roadmapStaleness({ updated: "2026-10-27", sourcesRepo: SHA }, undefined, now)[0]).toContain("9 days ago");
  });

  test("no updated date is a reason", () => {
    expect(roadmapStaleness({ updated: "", sourcesRepo: "" }, undefined, now)).toEqual(["no updated date"]);
  });

  test("by commits: the default branch moved past sources.repo", () => {
    const g = repo();
    const fresh = { updated: "2026-11-05", sourcesRepo: g.sha };
    expect(roadmapStaleness(fresh, g.dir, now)).toEqual([]);
    g.commit("second");
    g.commit("third");
    const why = roadmapStaleness(fresh, g.dir, now);
    expect(why).toHaveLength(1);
    expect(why[0]).toContain("2 commits on main since sources.repo");
  });

  test("an unknown sha is a reason", () => {
    const g = repo();
    const why = roadmapStaleness({ updated: "2026-11-05", sourcesRepo: SHA }, g.dir, now);
    expect(why[0]).toContain("is not in the repo");
  });

  test("a placeholder instead of a sha is a reason", () => {
    const g = repo();
    expect(roadmapStaleness({ updated: "2026-11-05", sourcesRepo: "<full sha>" }, g.dir, now)[0]).toContain("not a commit sha");
  });

  test("no repo found: the commit check is skipped", () => {
    expect(roadmapStaleness({ updated: "2026-11-05", sourcesRepo: SHA }, join(tmpdir(), "no-such-repo-dir"), now)).toEqual([]);
    const notRepo = mkdtempSync(join(tmpdir(), "roadmap-plain-"));
    expect(roadmapStaleness({ updated: "2026-11-05", sourcesRepo: SHA }, notRepo, now)).toEqual([]);
  });
});

describe("reading from the vault", () => {
  test("a ship with no note is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "roadmap-empty-"));
    expect(readRoadmap("kinwork", undefined, { vault: root })).toEqual({ ship: "kinwork", missing: true });
  });

  test("a note is parsed and its staleness set", () => {
    const g = repo();
    const text = FIXTURE.replace(SHA, g.sha);
    g.commit("more");
    const root = vaultWith("pochteca", text);
    const r = readRoadmap("pochteca", g.dir, { vault: root, now: new Date("2026-11-04T00:00:00Z") });
    if (r.missing) throw new Error("should exist");
    expect(r.nextUp).toHaveLength(4);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toContain("1 commit on main");
  });

  test("all ships: those with a note and those without", async () => {
    const root = vaultWith("pochteca", FIXTURE);
    const rows = await readRoadmaps("", { vault: root, now: new Date("2026-11-03T00:00:00Z"), ships: [{ id: "kinwork", path: "/nonexistent" }, { id: "pochteca", path: "/nonexistent" }] });
    expect(rows.map((r) => [r.ship, r.missing ?? false])).toEqual([["kinwork", true], ["pochteca", false]]);
  });
});

describe("ship_next report", () => {
  const root = vaultWith("pochteca", FIXTURE);
  const opts = { vault: root, now: new Date("2026-11-03T00:00:00Z"), ships: [{ id: "kinwork", path: "/nonexistent" }, { id: "pochteca", path: "/nonexistent" }] };

  test("one ship: now, next up, questions; full adds milestones and recently done", async () => {
    const short = await shipNext("pochteca", false, opts);
    expect(short.next_up).toHaveLength(4);
    expect(short.open_questions).toHaveLength(2);
    expect(short.milestones).toBeUndefined();
    expect(short.recently_done).toBeUndefined();
    const full = await shipNext("pochteca", true, opts);
    expect(full.milestones).toHaveLength(3);
    expect(full.recently_done).toHaveLength(2);
    const text = toolText(short, VIEWS.ship_next!);
    expect(text).toContain("Spec Ehecatl's protobuf contracts");
    expect(text).not.toContain("Signal pipeline");
  });

  test("the default view trims a long Now", () => {
    const long = parseRoadmap(`---\nupdated: 2026-11-02\n---\n## Now\n${"word ".repeat(200)}\n`, "x");
    const r = shipNextReport([long], "x") as unknown as { now: string };
    expect(r.now.length).toBeLessThan(450);
    expect((shipNextReport([long], "x", true) as unknown as { now: string }).now.length).toBeGreaterThan(900);
  });

  test("all ships are compact, and ships without a note are named", async () => {
    const r = await shipNext("", false, opts);
    expect(r.message).toContain("1 of 2");
    expect(r.no_roadmap).toEqual(["kinwork"]);
    expect((r.ships as { ship: string; next: string }[])[0]).toMatchObject({ ship: "pochteca", next: "Spec Ehecatl's protobuf contracts (spec-session)", questions: 2 });
    expect((await shipNext("all", false, opts)).ships).toHaveLength(1);
  });

  test("a ship with no note, and an unknown ship", async () => {
    expect((await shipNext("kinwork", false, opts)).message).toContain("has no roadmap");
    const bad = await shipNext("nowhere", false, opts);
    expect(bad.ok).toBe(false);
  });
});
