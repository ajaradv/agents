import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "decisions-test-"));
const vault = join(root, "vault");
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = join(root, "inbox");
process.env.ALICE_VAULT = vault;
mkdirSync(join(vault, "fleet/specs/kinwork"), { recursive: true });
mkdirSync(join(vault, "fleet/reviews/search"), { recursive: true });

const { specSubmit } = await import("./decisions.ts");
const { addQueueItem, readQueue } = await import("./decision-queue.ts");
const j = await import("./journal.ts");

afterAll(() => {
  j._closeJournal();
  for (const [k, v] of [["FLEET_INBOX", prev.inbox], ["ALICE_VAULT", prev.vault]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const REL = "fleet/specs/kinwork/search.md";
const REVIEW = "fleet/reviews/search/review-1.md";
const spec = (review: string) => writeFileSync(join(vault, REL), `---\ntitle: Search page\nship: kinwork\nstatus: draft\n${review}---\n## Goal\nx\n## Acceptance criteria\n- [ ] The page lists results\n`);
const queued = () => {
  const r = addQueueItem({ kind: "spec-review", ship: "kinwork", title: "Search page spec", by: "captain" });
  if (!r.ok) throw new Error(r.message);
  return r.item.id;
};

describe("specSubmit and the review gate", () => {
  test("refuses a spec with no review, or whose review the node has no record of", () => {
    const id = queued();
    spec("");
    expect(specSubmit("architect", { queue: id, path: REL })).toMatchObject({ ok: false });
    expect(specSubmit("architect", { queue: id, path: REL }).message).toContain("no `review:`");
    writeFileSync(join(vault, REVIEW), "### F1 — Major: a\nx\n\n## Resolution\nF1: fix — done\n");
    spec(`review: ${REVIEW}\n`);
    expect(specSubmit("architect", { queue: id, path: REL }).message).toContain("not a review the node wrote");
    expect(readQueue().find((i) => i.id === id)?.record).toBeUndefined();
  });

  test("with a ready review it submits and stores the summary on the queue item", () => {
    const id = queued();
    j.upsertWorkflow("survey", "s-dec1", { by: "architect", mode: "review", target: REL, review: REVIEW, ids: [1], depth: "full", counts: { Blocker: 0, Major: 1, Nit: 0 } }, { status: "done" });
    writeFileSync(join(vault, REVIEW), "### F1 — Major: a\nx\n\n## Resolution\nF1: escalate — the captain decides the storage\n");
    spec(`review: ${REVIEW}\n`);
    const r = specSubmit("architect", { queue: id, path: REL });
    expect(r.ok).toBe(true);
    const item = readQueue().find((i) => i.id === id)!;
    expect(item.record).toContain(REL);
    expect(item.review).toEqual({ depth: "full", counts: { Blocker: 0, Major: 1, Nit: 0 }, escalations: ["F1: the captain decides the storage"], contested: [], rel: REVIEW });
  });

  test("an unavailable review is submitted with the reason, and a skip with none", async () => {
    j.upsertWorkflow("survey", "s-dec2", { by: "architect", mode: "review", target: REL, error: "no surveyor ran" }, { status: "failed" });
    spec("review: unavailable\n");
    const id = queued();
    expect(specSubmit("architect", { queue: id, path: REL }).ok).toBe(true);
    await Bun.sleep(5); // queue ids are timestamps
    expect(readQueue().find((i) => i.id === id)?.review?.unavailable).toBe("no surveyor ran");
    await Bun.sleep(5); // the latest record is the one created last
    j.upsertWorkflow("survey", "s-dec3", { by: "architect", mode: "review", target: REL, depth: "skip" }, { status: "done" });
    spec("review: skipped\n");
    const id2 = queued();
    expect(specSubmit("architect", { queue: id2, path: REL }).ok).toBe(true);
    expect(readQueue().find((i) => i.id === id2)?.review).toMatchObject({ depth: "skip", rel: "" });
  });

  test("only the architect submits", () => {
    expect(specSubmit("alice", { queue: "x", path: REL }).ok).toBe(false);
  });
});
