import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "extract-"));
const inbox = join(tmp, "inbox");
const vault = join(tmp, "vault");
const saved = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
const { candidates, extract, extractNew, isCandidate, labelProposal, proposalReport, profileSections } = await import("./memory-extract.ts");
const { _closeJournal, journalDb } = await import("./journal.ts");
const { factSet } = await import("./facts.ts");

type Q = { type: string; instructions: string; criteria?: Record<string, string> };
type Script = { labels?: Record<string, [string, number]>; section?: string; replace?: Record<string, number> };
/** A fake Jev: classification by message text, a section pick, and noul answers by a word of the question. */
function fake(script: Script, log: { questions: [string, Record<string, Q>][] } = { questions: [] }) {
  const ask = (async (_use: string, state: { messages?: Record<string, string> }, questions: Record<string, Q>) => {
    log.questions.push([_use, questions]);
    const answers: Record<string, unknown> = {};
    for (const [k, q] of Object.entries(questions)) {
      if (q.type === "choice" && state.messages) {
        const [choice, confidence] = Object.entries(script.labels ?? {}).find(([w]) => state.messages![k]!.includes(w))?.[1] ?? ["none", 0.9];
        answers[k] = { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
      } else if (q.type === "choice") {
        const choice = script.section ?? Object.keys(q.criteria!)[0]!;
        answers[k] = { type: "choice", choice, confidence: 0.8, probabilities: { [choice]: 0.8 } };
      } else {
        const hit = Object.entries(script.replace ?? {}).find(([w]) => q.instructions.includes(w));
        answers[k] = { type: "noul", noul: hit ? hit[1] : 0.05 };
      }
    }
    return { ok: true, answers, route: "typesafe", inputTokens: 1, cost: 0, ms: 1 };
  }) as never;
  return ask;
}

const chat = (agent: string, lines: object[]) => {
  mkdirSync(join(inbox, agent), { recursive: true });
  writeFileSync(join(inbox, agent, "captain-chat.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const cap = (ts: string, text: string) => ({ ts, from: "captain", kind: "chat", text });

describe("memory extraction", () => {
  beforeAll(() => {
    process.env.FLEET_INBOX = inbox;
    process.env.ALICE_VAULT = vault;
    mkdirSync(join(vault, "fleet"), { recursive: true });
    writeFileSync(join(vault, "fleet", "captain.md"), "---\ntitle: Captain\n---\n\nIntro.\n\n## Voice\n\n- Address the captain as Captain.\n- Keep replies short.\n\n## Interruptions\n\n- Interrupt only for blocked work.\n");
    chat("alice", [
      cap("2026-10-30T09:00:00Z", "yes"),
      cap("2026-10-30T09:01:00Z", "(From Claude Code, to Alice: please do this thing now)"),
      cap("2026-10-30T09:02:00Z", "What is the hub status right now?"),
      cap("2026-10-30T09:03:00Z", "From now on keep replies to two sentences."),
      cap("2026-10-30T09:04:00Z", "The hub moved to host fleet-hub-new."),
      { ts: "2026-10-30T09:05:00Z", from: "alice", kind: "chat", text: "I will do that, Captain, right away." },
      cap("2026-10-30T09:06:00Z", "Build the billing page. OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"),
    ]);
    chat("architect", [cap("2026-10-30T08:00:00Z", "Use bun, not node, for every script.")]);
  });
  afterAll(() => {
    _closeJournal();
    for (const [k, v] of [["FLEET_INBOX", saved.inbox], ["ALICE_VAULT", saved.vault]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("only the captain's own statements are candidates", () => {
    expect(isCandidate({ from: "captain", kind: "chat", text: "ok" })).toBe(false);
    expect(isCandidate({ from: "captain", kind: "chat", text: "Is the hub up and running?" })).toBe(false);
    expect(isCandidate({ from: "captain", kind: "chat", text: "Fine. Is the hub up?" })).toBe(true);
    expect(isCandidate({ from: "alice", kind: "chat", text: "I changed the host to a new one" })).toBe(false);
    expect(isCandidate({ from: "captain", kind: "answer", text: "I changed the host to a new one" })).toBe(false);
    const list = candidates();
    expect(list.map((c) => `${c.agent}:${c.line_ts.slice(11, 16)}`)).toEqual(["architect:08:00", "alice:09:03", "alice:09:04", "alice:09:06"]);
    expect(list.at(-1)!.text).not.toContain("abcdefghijklmnop");
    expect(candidates({ agent: "architect" })).toHaveLength(1);
    expect(candidates({ since: "2026-10-30T09:04:00Z" })).toHaveLength(2);
  });

  test("the profile is read as sections of bullets", () => {
    expect(profileSections(vault)).toEqual([
      { name: "Voice", bullets: ["Address the captain as Captain.", "Keep replies short."] },
      { name: "Interruptions", bullets: ["Interrupt only for blocked work."] },
    ]);
  });

  test("labels map to proposals; a preference finds the section and the bullet it replaces; a fact finds its fact", async () => {
    factSet({ subject: "hub", key: "host", value: "fleet-hub-old", source: "test", by: "alice" });
    factSet({ subject: "hub", key: "region", value: "eu", source: "test", by: "alice" });
    const log = { questions: [] as [string, Record<string, Q>][] };
    const ask = fake({ labels: { "two sentences": ["preference", 0.9], "fleet-hub-new": ["fact", 0.85], "bun, not node": ["preference", 0.3], billing: ["task", 0.7] }, section: "Voice", replace: { "Keep replies short": 0.93, "hub.host": 0.88 } }, log);
    const run = await extract(candidates(), ask);
    expect(run).toMatchObject({ candidates: 4, proposed: 4, matched: 2, failed: 0 });
    // One classify call (4 messages), a section choice + noul per bullet for the preference, noul per matching fact.
    expect(run.calls).toBe(4);
    expect(log.questions.every(([use]) => use === "memory-extract")).toBe(true);
    const rows = journalDb().query("SELECT * FROM memory_proposals ORDER BY id").all() as Record<string, unknown>[];
    const by = (s: string) => rows.find((r) => String(r.quote).includes(s))!;
    expect(by("two sentences")).toMatchObject({ label: "preference", target: "captain.md#Voice", replaces: "Keep replies short.", status: "observed", captain_label: null });
    expect(by("two sentences").replace_p).toBeCloseTo(0.93);
    expect(by("fleet-hub-new")).toMatchObject({ label: "fact", target: "fact:hub.host", replaces: "1" });
    // Below the floor: classified and stored, but not matched against memory.
    expect(by("bun, not node")).toMatchObject({ label: "preference", target: null, replaces: null, replace_p: null });
    expect(by("billing")).toMatchObject({ label: "task", target: null });
    expect(by("billing").quote).not.toContain("abcdefghijklmnop");
    // The fact question only offered the facts that share a word with the message (hub.host and hub.region, not an unrelated one).
    const factQs = log.questions.filter(([, q]) => Object.values(q).some((x) => x.instructions.includes("recorded fact")));
    expect(Object.keys(factQs[0]![1])).toEqual(["r0", "r1"]);
  });

  test("a rerun proposes nothing new and calls nothing", async () => {
    expect(candidates()).toEqual([]);
    const log = { questions: [] as [string, Record<string, Q>][] };
    const run = await extract(candidates(), fake({}, log));
    expect(run).toMatchObject({ candidates: 0, proposed: 0, calls: 0 });
    expect(log.questions).toEqual([]);
    // Storing the same line twice is ignored too.
    const before = (journalDb().query("SELECT COUNT(*) AS n FROM memory_proposals").get() as { n: number }).n;
    await extract([{ agent: "alice", line_ts: "2026-10-30T09:03:00Z", text: "From now on keep replies to two sentences." }], fake({}));
    expect((journalDb().query("SELECT COUNT(*) AS n FROM memory_proposals").get() as { n: number }).n).toBe(before);
  });

  test("a failed Jev call stores nothing and the lines stay candidates", async () => {
    chat("designer", [cap("2026-10-30T11:00:00Z", "Always show the logo at the top of the page.")]);
    const run = await extract(candidates({ agent: "designer" }), (async () => ({ ok: false, error: "down" })) as never);
    expect(run).toMatchObject({ proposed: 0, failed: 1 });
    expect(candidates({ agent: "designer" })).toHaveLength(1);
  });

  test("the ongoing pass takes lines newer than the last proposal, and off turns it off", async () => {
    chat("alice", [cap("2026-10-30T09:03:00Z", "From now on keep replies to two sentences."), cap("2026-10-30T12:00:00Z", "Decision: we drop the old dashboard next week.")]);
    process.env.FLEET_MEMORY_EXTRACT = "off";
    expect(await extractNew(fake({}))).toBeNull();
    delete process.env.FLEET_MEMORY_EXTRACT;
    const run = await extractNew(fake({ labels: { Decision: ["decision", 0.9] } }));
    expect(run).toMatchObject({ candidates: 2, proposed: 2, byLabel: { decision: 1, none: 1 } });
    // The designer line that failed earlier is newer than the cursor, so this pass took it too.
  });

  test("labels are checked; accuracy is per confidence bucket over labelled rows", () => {
    const rows = proposalReport({ days: 1 }).rows;
    const id = (s: string) => rows.find((r) => r.quote.includes(s))!.id;
    expect(labelProposal(id("two sentences"), "preference").ok).toBe(true);
    expect(labelProposal(id("fleet-hub-new"), "decision", "fact:hub.host").ok).toBe(true);
    expect(labelProposal(id("billing"), "chores").ok).toBe(false);
    expect(labelProposal(9999, "none").ok).toBe(false);
    const r = proposalReport({ days: 1 });
    expect(r.perLabel).toMatchObject({ preference: 2, fact: 1, task: 1, decision: 1 });
    expect(r.buckets.find((b) => b.bucket === "0.8-0.9")).toMatchObject({ labelled: 1, right: 0, accuracy: 0 });
    expect(r.buckets.find((b) => b.bucket === ">=0.9")).toMatchObject({ labelled: 1, right: 1, accuracy: 1 });
    expect(r.buckets.find((b) => b.bucket === "<0.6")).toMatchObject({ labelled: 0, accuracy: null });
    expect(proposalReport({ days: 1, unlabelledOnly: true }).rows.every((x) => x.captain_label === null)).toBe(true);
    expect(rows.find((x) => x.id === id("fleet-hub-new"))).toBeDefined();
    const target = journalDb().query("SELECT captain_target FROM memory_proposals WHERE id = ?").get(id("fleet-hub-new")) as { captain_target: string };
    expect(target.captain_target).toBe("fact:hub.host");
  });
});
