import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "specs-inbox-"));
const vault = mkdtempSync(join(tmpdir(), "specs-vault-"));
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT };
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
const sp = await import("./specs.ts");
const q = await import("./decision-queue.ts");
const d = await import("./decisions.ts");
const j = await import("./journal.ts");
afterAll(() => {
  j._closeJournal();
  for (const [k, v] of [["FLEET_INBOX", prev.inbox], ["ALICE_VAULT", prev.vault]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(inbox, { recursive: true, force: true });
  rmSync(vault, { recursive: true, force: true });
});

const SPEC = `---\ntitle: "Search page redesign"\nship: kinwork\nstatus: draft\nsource: "fleet/voyages/kinwork/s.md"\nprototype: design/search-page\n---\n\n## Goal\n\nA calmer search.\n\n## Acceptance criteria\n\n- [ ] /search/ shows the faceted sidebar on desktop\n- [ ] Phone keeps filters behind one button\n* Lint and pytest pass\n\n## Design\n\nFrom the prototype.\n`;
const write = (rel: string, text: string) => {
  mkdirSync(join(vault, rel, ".."), { recursive: true });
  writeFileSync(join(vault, rel), text);
};

describe("specs", () => {
  test("acceptance criteria are the list under their heading, checkboxes or bullets", () => {
    expect(sp.acceptanceCriteria(SPEC)).toEqual(["/search/ shows the faceted sidebar on desktop", "Phone keeps filters behind one button", "Lint and pytest pass"]);
    expect(sp.acceptanceCriteria("## Goal\n\n- not a criterion")).toEqual([]);
  });

  test("a submitted spec must live in fleet/specs/<its ship>/ and have criteria", () => {
    write("fleet/specs/kinwork/search-page.md", SPEC);
    write("fleet/specs/kinwork/empty.md", SPEC.replace(/## Acceptance criteria[\s\S]*?## Design/, "## Design"));
    write("fleet/plans/x.md", SPEC);
    write("fleet/specs/pochteca/wrong.md", SPEC);
    expect(sp.checkSpec("fleet/specs/kinwork/search-page.md", "kinwork")).toMatchObject({ ok: true, spec: { title: "Search page redesign", prototype: "design/search-page", status: "draft" } });
    expect(sp.checkSpec("fleet/specs/kinwork/empty.md")).toMatchObject({ ok: false, message: expect.stringContaining("Acceptance criteria") });
    expect(sp.checkSpec("fleet/plans/x.md")).toMatchObject({ ok: false, message: expect.stringContaining("fleet/specs") });
    expect(sp.checkSpec("fleet/specs/pochteca/wrong.md")).toMatchObject({ ok: false, message: expect.stringContaining("matching its folder") });
    expect(sp.checkSpec("fleet/specs/kinwork/../../../etc/passwd")).toMatchObject({ ok: false });
    expect(sp.checkSpec("fleet/specs/kinwork/search-page.md", "pochteca")).toMatchObject({ ok: false });
  });

  test("status moves in the frontmatter; listing filters by it", () => {
    const file = join(vault, "fleet/specs/kinwork/search-page.md");
    expect(sp.setSpecStatus(file, "approved")).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("status: approved");
    expect(sp.listSpecs("kinwork", "approved").map((s) => s.title)).toEqual(["Search page redesign"]);
    sp.setSpecStatus(file, "draft");
  });
});

describe("the officers' decisions", () => {
  test("the architect submits a spec to its review; the captain asks for changes, then approves", async () => {
    const r = q.addQueueItem({ kind: "spec-review", ship: "kinwork", title: "Spec: Search page redesign", by: "helm", source: "fleet/voyages/kinwork/s.md" });
    if (!r.ok) throw new Error("add");
    const id = r.item.id;
    expect(d.specSubmit("designer", { queue: id, path: "fleet/specs/kinwork/search-page.md" }).ok).toBe(false);
    expect(d.specSubmit("architect", { queue: id, path: "fleet/specs/kinwork/empty.md" }).message).toContain("Acceptance criteria");
    // The review gate (lib/survey.ts reviewReady): a review-mode skip on the node's record, named in the spec.
    expect(d.specSubmit("architect", { queue: id, path: "fleet/specs/kinwork/search-page.md" }).message).toContain("no `review:`");
    write("fleet/specs/kinwork/search-page.md", SPEC.replace("---\n", "---\nreview: skipped\n"));
    j.upsertWorkflow("survey", "s-specs-skip", { by: "architect", mode: "review", target: "fleet/specs/kinwork/search-page.md", depth: "skip" }, { status: "done" });
    expect(d.specSubmit("architect", { queue: id, path: "fleet/specs/kinwork/search-page.md" })).toMatchObject({ ok: true, message: expect.stringContaining("3 acceptance criteria") });
    const told: string[] = [];
    const deps = { tellLead: async (to: string) => void told.push(to) };
    mkdirSync(join(inbox, "architect"), { recursive: true });
    expect((await d.reviewQueueItem(id, "changes", "Add a criterion for the empty state", deps)).ok).toBe(true);
    expect(readFileSync(join(inbox, "architect", "events.jsonl"), "utf8")).toContain("spec-changes");
    expect(q.readQueue().find((i) => i.id === id)).toMatchObject({ status: "queued", record: "", note: "Add a criterion for the empty state" });
    expect((await d.reviewQueueItem(id, "approve", "", deps)).message).toContain("not submitted");
    d.specSubmit("architect", { queue: id, path: "fleet/specs/kinwork/search-page.md" });
    expect((await d.reviewQueueItem(id, "approve", "", deps)).ok).toBe(true);
    expect(readFileSync(join(vault, "fleet/specs/kinwork/search-page.md"), "utf8")).toContain("status: approved");
    expect(q.readQueue().find((i) => i.id === id)!.status).toBe("done");
  });

  test("a design review reaches the queue only when the voyage differs; sending it back tells the ship's lead", async () => {
    expect(d.designReview("designer", { ship: "kinwork", verdict: "matches" }).message).toContain("Nothing goes");
    expect(d.designReview("architect", { ship: "kinwork", verdict: "differs", notes: "x" }).ok).toBe(false);
    expect(d.designReview("designer", { ship: "kinwork", verdict: "differs", notes: "short" }).ok).toBe(false);
    expect(d.designReview("designer", { ship: "kinwork", verdict: "differs", notes: "The sidebar swatches sit on the wrong labels on phone." }).ok).toBe(true);
    const item = q.readQueue().find((i) => i.kind === "design-review")!;
    const told: string[] = [];
    expect((await d.reviewQueueItem(item.id, "changes", "", { tellLead: async (to) => void told.push(to) })).ok).toBe(true);
    expect(told).toEqual(["kinwork-lead"]);
  });
});

describe("voyages build decided work (D3)", () => {
  const shipsDir = mkdtempSync(join(tmpdir(), "specs-ships-"));
  writeFileSync(join(shipsDir, "kinwork.yaml"), "id: kinwork\npath: /nonexistent\norchestrator: lead\ncrew:\n  - lead\nmode: m\n");
  process.env.FLEET_SHIPS_DIR = shipsDir;

  test("a lead-run voyage needs an approved spec or the chore mark", async () => {
    const { startVoyage } = await import("./shipyard.ts");
    expect((await startVoyage("kinwork", "Make search nicer", "kinwork-lead")).message).toContain("approved spec, or as a chore");
    sp.setSpecStatus(join(vault, "fleet/specs/kinwork/search-page.md"), "draft");
    expect((await startVoyage("kinwork", "", "kinwork-lead", undefined, { spec: "fleet/specs/kinwork/search-page.md" })).message).toContain("is draft");
    expect((await startVoyage("kinwork", "", "kinwork-lead", undefined, { spec: "fleet/plans/x.md" })).message).toContain("fleet/specs");
  });

  test("the lead's brief carries the spec, its prototype, and every criterion; a chore says it is one", async () => {
    const { voyageBrief } = await import("./shipyard.ts");
    const ship = { id: "kinwork", path: "/k", mode: "m", factory: null, declaredAdws: [], adws: [], orchestrator: "lead", crew: ["lead", "builder"], crewModels: {}, isolation: "host" as const, vmAllow: [], checks: {}, gates: { task: [], dock: [] }, maneuvers: [], rig: null };
    const v = { file: "/v/x.md", ship: "kinwork", status: "sailing" as const, goal: "Search page redesign", to: "kinwork-lead", started: "", spec: join(vault, "fleet/specs/kinwork/search-page.md") };
    const text = voyageBrief(ship, v);
    expect(text).toContain("Build the approved spec");
    expect(text).toContain("starts from the prototype design/search-page");
    expect(text).toContain("1. /search/ shows the faceted sidebar on desktop");
    expect(text).toContain("3. Lint and pytest pass");
    expect(voyageBrief(ship, { ...v, spec: undefined, chore: true })).toContain("This voyage is a chore");
  });

  test("Alice's voyage_start passes spec and chore through the Go gate", async () => {
    const gate = await import("./go-gate.ts");
    expect(gate.tier2ArgError("voyage_start", { ship: "kinwork", goal: "x", to: "kinwork-lead", spec: "fleet/specs/kinwork/a.md" })).toBeNull();
    expect(gate.describeAction("voyage_start", { ship: "kinwork", goal: "Fix typo", to: "kinwork-lead", chore: "true" })).toContain("as a chore");
    delete process.env.FLEET_SHIPS_DIR;
    rmSync(shipsDir, { recursive: true, force: true });
  });
});
