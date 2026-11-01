import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "eb-inbox-"));
const prevInbox = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const eb = await import("./engineer-brief.ts");
afterAll(() => {
  if (prevInbox === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prevInbox;
});

const NOW = new Date("2026-11-01T12:00:00Z");
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** A git double: answers by the arguments, keyed "<cwd> <args>"; anything unlisted fails like git would. */
function fakeGit(answers: Record<string, string>): import("./engineer-brief.ts").Git {
  return (cwd, args) => {
    const key = `${cwd} ${args.join(" ")}`;
    if (key in answers) return answers[key]!;
    throw new Error(`fatal: ${key}`);
  };
}

const P = "/repo";
const base = (over: Record<string, string> = {}) => ({
  [`${P} rev-parse --abbrev-ref HEAD`]: "main",
  [`${P} status --porcelain`]: "",
  [`${P} main..origin/main`.replace(" main..", " rev-list --count main..")]: "0",
  [`${P} rev-list --count origin/main..main`]: "0",
  [`${P} worktree list --porcelain`]: `worktree ${P}\nHEAD abc\nbranch refs/heads/main`,
  ...over,
});
const fetched = () => new Date("2026-11-01T09:30:00Z");

describe("repoSection", () => {
  test("a clean primary, even with origin/main, with the fetch time", () => {
    expect(eb.repoSection(P, fakeGit(base()), fetched)).toEqual(["- primary: main, clean, even with origin/main (as of the last fetch, 2026-11-01 09:30)"]);
  });

  test("a dirty primary, ahead and behind", () => {
    const g = fakeGit(base({ [`${P} status --porcelain`]: " M a\n?? b", [`${P} rev-list --count main..origin/main`]: "2", [`${P} rev-list --count origin/main..main`]: "1" }));
    expect(eb.repoSection(P, g, () => null)[0]).toBe("- primary: main, 2 changed files, 2 behind origin/main, 1 ahead of origin/main (as of the last fetch: never)");
  });

  test("a worktree without an upstream, and one with 2 unpushed commits; a pushed one is not listed", () => {
    const list = `worktree ${P}\nHEAD a\nbranch refs/heads/main\n\nworktree /wt/a\nHEAD b\nbranch refs/heads/no-upstream\n\nworktree /wt/b\nHEAD c\nbranch refs/heads/unpushed\n\nworktree /wt/c\nHEAD d\nbranch refs/heads/pushed\n\nworktree /wt/d\nHEAD e1234567890\ndetached`;
    const g = fakeGit(
      base({
        [`${P} worktree list --porcelain`]: list,
        "/wt/b rev-list --count @{upstream}..HEAD": "2",
        "/wt/c rev-list --count @{upstream}..HEAD": "0",
        "/wt/a rev-list --count origin/main..HEAD": "3",
      }),
    );
    const lines = eb.repoSection(P, g, fetched);
    expect(lines.slice(1)).toEqual(["- worktree /wt/a (no-upstream): 3 commits not on origin/main, no upstream", "- worktree /wt/b (unpushed): 2 commits not on its upstream", "- worktree /wt/d: detached at e123456"]);
  });
});

describe("prSection", () => {
  const pr = (checks: object[], extra: object = {}) => JSON.stringify([{ number: 99, title: "A change", isDraft: false, reviewDecision: "", statusCheckRollup: checks, ...extra }]);
  const line = async (checks: object[], extra?: object) => (await eb.prSection(async () => pr(checks, extra)))[0];

  test("the CI roll-up for each state", async () => {
    expect(await line([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }])).toBe("- #99 A change: CI green, review none");
    for (const bad of ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"]) expect(await line([{ conclusion: "SUCCESS" }, { conclusion: bad }])).toContain("CI red");
    for (const wait of ["PENDING", "QUEUED", "IN_PROGRESS"]) expect(await line([{ conclusion: "SUCCESS" }, { conclusion: "", status: wait }])).toContain("CI pending");
    expect(await line([{ state: "FAILURE" }, { status: "IN_PROGRESS" }])).toContain("CI red"); // red wins over pending
    expect(await line([])).toContain("CI no checks");
  });

  test("draft and review decision show; no open PRs says so", async () => {
    expect(await line([], { isDraft: true, reviewDecision: "CHANGES_REQUESTED" })).toBe("- #99 A change (draft): CI no checks, review changes requested");
    expect(await eb.prSection(async () => "[]")).toEqual(["- no open PRs"]);
  });

  test("gh missing or unauthenticated gives an unavailable line in the brief", async () => {
    const text = await eb.engineerBrief({ primary: P, vault: tmp("eb-v-"), now: NOW, git: fakeGit(base()), gh: async () => Promise.reject(new Error("gh: not logged in")), hub: async () => Promise.reject(new Error("off")) });
    expect(text).toContain("## PRs\n- unavailable: gh: not logged in");
  });
});

describe("hubPart", () => {
  const root = tmp("eb-hub-");
  const state = join(inbox, ".node");
  const unitsAll = "active\nactive\nactive\nactive";
  const run = (drift: string, units = unitsAll) => async (cmd: string[]) => (cmd[0]!.endsWith("fleet-services") ? drift : units);
  const fleet = async () => ["- 4 ships, 1 agent(s) working, 0 item(s) waiting on the captain.", "- nothing waiting on the captain", "- 3 open"];
  write(root, "fleet/inbox/.node/deploys.log", "2026-10-31T08:00:00Z 1111111aaaa 2222222bbbb deploy\n2026-11-01T09:00:00Z 2222222bbbb 3333333cccc deploy\n");
  const drill = (o: object) => write(inbox, ".node/routines.json", JSON.stringify({ "backup-drill": o }));

  test("the last deploy, current services, all units active, a drill that passed", async () => {
    drill({ lastRun: "2026-10-30T12:00:00Z", status: "ok", note: "drill passed" });
    const text = await eb.hubPart(root, { now: NOW, run: run(""), fleet });
    expect(text).toBe(
      "## Hub\n- last deploy 3h ago: 2222222→3333333 (deploy)\n- services: current\n- units: all active\n- backup drill: ok 2d ago\n\n## Fleet\n- 4 ships, 1 agent(s) working, 0 item(s) waiting on the captain.\n- nothing waiting on the captain\n- 3 open",
    );
  });

  test("drift lines are shown and an inactive unit is named", async () => {
    const text = await eb.hubPart(root, { now: NOW, run: run("fleet-node.service differs from the template", "active\nactive\ninactive\nfailed"), fleet });
    expect(text).toContain("- services: fleet-node.service differs from the template");
    expect(text).toContain("- units: fleet-litestream inactive, fleet-heartbeat.timer failed");
  });

  test("a drill older than 8 days is overdue; a failed one shows its note", async () => {
    drill({ lastRun: "2026-10-20T12:00:00Z", status: "ok" });
    expect(await eb.hubPart(root, { now: NOW, run: run(""), fleet })).toContain("- backup drill: ok 12d ago **overdue**");
    drill({ lastRun: "2026-10-31T12:00:00Z", status: "error", note: "FAIL journal.db: integrity" });
    expect(await eb.hubPart(root, { now: NOW, run: run(""), fleet })).toContain("- backup drill: **failed: FAIL journal.db: integrity** 1d ago");
  });

  test("a fact that cannot be read says so and the rest still shows", async () => {
    const text = await eb.hubPart(tmp("eb-empty-"), { now: NOW, run: run(""), fleet });
    expect(text).toMatch(/- unavailable: .*\n- services: current/);
  });
});

describe("spawnHubPart", () => {
  function rootWithHub(script: string): string {
    const root = tmp("eb-spawn-");
    write(root, "bin/hub", `#!/bin/bash\n${script}\n`);
    chmodSync(join(root, "bin", "hub"), 0o755);
    return root;
  }

  test("runs bin/hub fleet-axi --brief --hub-part with the ssh options", async () => {
    const root = rootWithHub('echo "$@"; echo "$FLEET_HUB_SSH_OPTS"');
    expect(await eb.spawnHubPart(root)).toBe("fleet-axi --brief --hub-part\n-o ConnectTimeout=5 -o BatchMode=yes\n");
  });

  test("a failing ssh gives its message; a hub that does not answer is killed and gives a timeout", async () => {
    await expect(eb.spawnHubPart(rootWithHub("echo 'Permission denied' >&2; exit 255"))).rejects.toThrow("Permission denied");
    const t0 = Date.now();
    // ignores SIGTERM, so only the SIGKILL ends it
    await expect(eb.spawnHubPart(rootWithHub("trap '' TERM; while true; do sleep 0.05; done"), { termMs: 150, killMs: 150 })).rejects.toThrow("no answer in 0.15 s");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a timeout collapses Hub and Fleet into one line, and leaves Not deployed out", async () => {
    const text = await eb.engineerBrief({ primary: P, vault: tmp("eb-v-"), now: NOW, git: fakeGit(base()), gh: async () => "[]", hub: () => eb.spawnHubPart(rootWithHub("exec sleep 5"), { termMs: 100, killMs: 100 }) });
    expect(text).toContain("## Hub\n- hub unreachable (no answer in 0.1 s)\n");
    expect(text).not.toContain("## Fleet");
    expect(text).not.toContain("## Not deployed");
  });
});

describe("notDeployedSection", () => {
  test("shown only when the count is above 0", () => {
    expect(eb.notDeployedSection(P, "abc1234", fakeGit({ [`${P} rev-list --count abc1234..origin/main`]: "2" }))).toEqual(["- 2 commits on main not deployed"]);
    expect(eb.notDeployedSection(P, "abc1234", fakeGit({ [`${P} rev-list --count abc1234..origin/main`]: "1" }))).toEqual(["- 1 commit on main not deployed"]);
    expect(eb.notDeployedSection(P, "abc1234", fakeGit({ [`${P} rev-list --count abc1234..origin/main`]: "0" }))).toEqual([]);
  });
});

function plan(vault: string, name: string, fm: string): void {
  write(vault, `fleet/plans/${name}.md`, `---\n${fm}\n---\n\nBody\n`);
}

describe("planSection", () => {
  const vault = tmp("eb-plans-");
  plan(vault, "feature/draft-one", "status: draft\nupdated: 2026-10-30\ncreated: 2026-10-01");
  plan(vault, "feature/old-update", "status: draft\nupdated: 2026-09-01\ncreated: 2026-10-30"); // updated wins over created
  plan(vault, "feature/created-only", "status: accepted\ncreated: 2026-10-20");
  plan(vault, "feature/too-old", "status: accepted\ncreated: 2026-09-20");
  plan(vault, "feature/done", "status: done\nupdated: 2026-10-31");
  plan(vault, "research/in-play", "status: in-progress\nupdated: 2026-10-31");
  for (const s of ["decided", "active", "queued"]) plan(vault, `ops/${s}`, `status: ${s}\nupdated: 2026-10-31`);
  plan(vault, "feature/reviewed", "status: accepted\nupdated: 2026-10-31\nreview: fleet/reviews/r.md");
  write(vault, "fleet/reviews/r.md", "## Findings\n- **F1** a\n- **F2** b\n- **F3** c\n\n## Resolution\n\nF1: fix — x\nF2: decline - y\n");
  write(vault, "fleet/plans/feature/no-frontmatter.md", "# Plain\n");
  const all = eb.planSection(vault, "2026-11-01");
  const lines = all;

  test("the status set and the 30-day window, with created as the fallback", () => {
    expect(lines).toContain("- `feature/draft-one` draft, no review");
    expect(lines).toContain("- `feature/created-only` accepted, no review");
    for (const s of ["decided", "active", "queued"]) expect(lines).toContain(`- \`ops/${s}\` ${s}, no review`);
    expect(lines).toContain("- `research/in-play` in-progress, no review");
    expect(lines.join("\n")).not.toMatch(/old-update|too-old|feature\/done|no-frontmatter/);
  });

  test("review counts come from the review file", () => {
    expect(lines).toContain("- `feature/reviewed` accepted, review 1 open of 3");
  });

  test("newest first, at most 8, then a line saying how many more", () => {
    const v = tmp("eb-many-");
    for (let i = 1; i <= 11; i++) plan(v, `feature/p${String(i).padStart(2, "0")}`, `status: draft\nupdated: 2026-10-${String(10 + i)}`);
    const out = eb.planSection(v, "2026-11-01");
    expect(out).toHaveLength(9);
    expect(out[0]).toBe("- `feature/p11` draft, no review");
    expect(out[7]).toBe("- `feature/p04` draft, no review");
    expect(out[8]).toBe("- (+3 more: bin/fleet-axi search --path fleet/plans)");
    expect(eb.planSection(vault, "2026-11-01").at(-1)).not.toContain("more");
  });

  test("a vault without plans says so", () => {
    expect(eb.planSection(tmp("eb-none-"), "2026-11-01")).toEqual(["- no fleet/plans folder in the vault"]);
  });
});

describe("roadmapSection", () => {
  test("a missing roadmap gives the no-roadmap line", () => {
    expect(eb.roadmapSection(tmp("eb-r-"))).toEqual(["- no ships/fleet/roadmap.md yet"]);
  });

  test("Now, the first three Next up items, and a stale flag", () => {
    const vault = tmp("eb-r-");
    write(vault, "ships/fleet/roadmap.md", `---\ntype: roadmap\nupdated: 2026-10-01\nsources:\n  repo: abc1234\n---\n\n## Now\n\nBuilding E1.\n\n## Next up\n\n1. First (P1, S) — ready to sail: why one\n2. Second (P2, M) — spec-session: why two\n3. Third\n4. Fourth\n`);
    const lines = eb.roadmapSection(vault, undefined, NOW);
    expect(lines[0]).toBe("- now: Building E1.");
    expect(lines.filter((l) => l.startsWith("- next "))).toHaveLength(3);
    expect(lines.some((l) => l.includes("Fourth"))).toBe(false);
    expect(lines.at(-1)).toMatch(/^- stale: updated 31 days ago/);
  });
});

describe("handoffSection", () => {
  test("the note's lines with its updated date; a missing note says so", () => {
    const vault = tmp("eb-h-");
    expect(eb.handoffSection(vault)).toEqual(["- no fleet/engineer/handoff.md yet"]);
    write(vault, "fleet/engineer/handoff.md", "---\ntype: handoff\nupdated: 2026-11-01\n---\n## Offers not answered\n- 2026-11-01 One thing.\n");
    expect(eb.handoffSection(vault)).toEqual(["- updated 2026-11-01", "**Offers not answered**", "- 2026-11-01 One thing."]);
  });

  test("capped at 2,000 characters before anything else", () => {
    const vault = tmp("eb-h-");
    const many = Array.from({ length: 100 }, (_, i) => `- 2026-11-01 item ${i} ${"y".repeat(20)}`).join("\n");
    write(vault, "fleet/engineer/handoff.md", `---\nupdated: 2026-11-01\n---\n${many}\n`);
    const lines = eb.handoffSection(vault);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2000 + "- updated 2026-11-01".length + 1);
    expect(lines.join("\n")).not.toContain("item 99");
  });
});

describe("engineerBrief", () => {
  const hubText = "## Hub\n- last deploy 3h ago: 2222222→3333333 (deploy)\n- services: current\n\n## Fleet\n- 4 ships";
  const vault = tmp("eb-whole-");
  plan(vault, "feature/p", "status: draft\nupdated: 2026-10-31");
  const deps = (over: object = {}) => ({
    primary: P,
    vault,
    now: NOW,
    git: fakeGit(base({ [`${P} rev-list --count 3333333..origin/main`]: "2" })),
    gh: async () => "[]",
    hub: async () => hubText,
    fetchedAt: fetched,
    ...over,
  });

  test("sections in order, with the hub's inserted and Not deployed using its sha", async () => {
    const text = await eb.engineerBrief(deps());
    const titles = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(titles).toEqual(["Repo", "PRs", "Hub", "Not deployed", "Fleet", "Plans", "Roadmap", "Handoff"]);
    expect(text).toMatch(/^# Engineer brief 2026-11-01/);
    expect(text).toContain("## Not deployed\n- 2 commits on main not deployed");
    expect(text).not.toContain("- cut:");
  });

  test("a section that throws gives an unavailable line and the others still print", async () => {
    const text = await eb.engineerBrief(deps({ git: fakeGit({}) }));
    expect(text).toContain("## Repo\n- unavailable: fatal:");
    expect(text).toContain("## Plans");
  });

  test("oversized sections stay under 8,000 bytes and the cut sections are listed", async () => {
    const big = tmp("eb-big-");
    for (let i = 0; i < 400; i++) plan(big, `feature/plan-${i}`, "status: draft\nupdated: 2026-10-31");
    const text = await eb.engineerBrief(deps({ vault: big, hub: async () => `## Hub\n${Array.from({ length: 300 }, (_, i) => `- line ${i} ${"z".repeat(60)}`).join("\n")}\n\n## Fleet\n- f` }));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8000);
    expect(text).toMatch(/\(\+\d+ more\)/);
    expect(text).toMatch(/\n- cut: .*Plans/);
    const cutLine = text.split("\n").find((l) => l.startsWith("- cut: "))!;
    for (const title of ["Roadmap", "Handoff"]) expect(cutLine).toContain(title);
  });
});
