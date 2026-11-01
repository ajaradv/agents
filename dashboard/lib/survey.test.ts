import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { JevResult } from "./jev.ts";
import type { ModelsConfig } from "./models-config.ts";

const root = mkdtempSync(join(tmpdir(), "survey-test-"));
const vault = join(root, "vault");
const inbox = join(root, "inbox");
const prev = { inbox: process.env.FLEET_INBOX, vault: process.env.ALICE_VAULT, budget: process.env.FLEET_SURVEY_BUDGET_USD, op: process.env.FLEET_OP_ENV_FILE };
// A service-account file that exists keeps agentKeyEnv off the fleet/home/.env mount; under NODE_ENV=test the account itself yields no keys.
mkdirSync(root, { recursive: true });
writeFileSync(join(root, ".env.op"), "");
process.env.FLEET_OP_ENV_FILE = join(root, ".env.op");
process.env.FLEET_INBOX = inbox;
process.env.ALICE_VAULT = vault;
process.env.FLEET_SURVEY_BUDGET_USD = "100";
mkdirSync(join(vault, "fleet/plans/feature"), { recursive: true });
mkdirSync(join(vault, "career"), { recursive: true });

const j = await import("./journal.ts");
const s = await import("./survey.ts");

afterAll(() => {
  j._closeJournal();
  for (const [k, v] of [["FLEET_INBOX", prev.inbox], ["ALICE_VAULT", prev.vault], ["FLEET_SURVEY_BUDGET_USD", prev.budget], ["FLEET_OP_ENV_FILE", prev.op]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const SOL = "openrouter/openai/gpt-6.1-sol";
const roster: ModelsConfig = {
  cursor: "off",
  aliases: { sol: SOL, opus: "openrouter/anthropic/claude-opus-5.5", sonnet: "openrouter/anthropic/claude-sonnet-5.5", grok: "cursor/grok-4.7@256k", luna: "openrouter/openai/gpt-6-luna" },
  surveyors: {
    "zoom-out": ["sol", "opus", "sonnet"],
    "design-critic": ["sonnet", "sol", "opus"],
    readiness: ["grok", "sonnet", "luna"],
    codebase: ["luna", "sonnet"],
    brainstorm: ["luna", "sonnet", "opus"],
  },
};

describe("assignModels", () => {
  test("never the writer, including across provider prefixes; no duplicates", () => {
    // The writer is named without the openrouter/ prefix the roster uses.
    const a = s.assignModels(["zoom-out", "design-critic", "readiness", "codebase"], "openai/gpt-6.1-sol", roster, []);
    expect(a.map((x) => x.model)).toEqual(["openrouter/anthropic/claude-opus-5.5", "openrouter/anthropic/claude-sonnet-5.5", "openrouter/openai/gpt-6-luna", null]);
    const sols = s.assignModels(["zoom-out"], "openrouter/openai/gpt-6.1-sol", roster, []);
    expect(sols[0]!.model).toBe("openrouter/anthropic/claude-opus-5.5");
    const taken = s.assignModels(["design-critic", "zoom-out", "readiness"], "x/y", roster, []).map((x) => x.model);
    expect(new Set(taken.filter(Boolean)).size).toBe(taken.filter(Boolean).length);
  });
  test("Cursor off skips cursor/* models; Cursor on keeps them", () => {
    expect(s.assignModels(["readiness"], "x/y", roster, [])[0]!.model).toBe("openrouter/anthropic/claude-sonnet-5.5");
    expect(s.assignModels(["readiness"], "x/y", { ...roster, cursor: "on" }, [])[0]!.model).toBe("cursor/grok-4.7@256k");
  });
  test("a model that failed today is skipped, and its prefix does not matter", () => {
    expect(s.assignModels(["design-critic"], "x/y", roster, ["anthropic/claude-sonnet-5.5"])[0]!.model).toBe(SOL);
  });
  test("a lens with no candidate left is not run", () => {
    expect(s.assignModels(["codebase"], "x/y", roster, ["openai/gpt-6-luna", "anthropic/claude-sonnet-5.5"])).toEqual([{ lens: "codebase", model: null }]);
    expect(s.assignModels(["design-critic", "codebase"], "x/y", { ...roster, surveyors: { "design-critic": ["sonnet"], codebase: ["sonnet"] } }, [])).toEqual([{ lens: "design-critic", model: "openrouter/anthropic/claude-sonnet-5.5" }, { lens: "codebase", model: null }]);
  });
  test("brainstorm lenses draw from the brainstorm list in order", () => {
    expect(s.assignModels(["contrarian", "cost", "operations"], "x/y", roster, []).map((x) => x.model)).toEqual(["openrouter/openai/gpt-6-luna", "openrouter/anthropic/claude-sonnet-5.5", "openrouter/anthropic/claude-opus-5.5"]);
  });
});

describe("lensesFor", () => {
  test("light and full for each mode; comprehension on request in review mode", () => {
    expect(s.lensesFor("review", "light")).toEqual(["readiness", "codebase"]);
    expect(s.lensesFor("review", "full")).toEqual(["zoom-out", "design-critic", "readiness", "codebase"]);
    expect(s.lensesFor("review", "full", ["comprehension"])).toEqual(["zoom-out", "design-critic", "readiness", "codebase", "comprehension"]);
    expect(s.lensesFor("brainstorm", "light")).toEqual(["contrarian", "cost", "operations"]);
    expect(s.lensesFor("brainstorm", "full")).toHaveLength(6);
    expect(s.lensesFor("review", "skip")).toEqual([]);
  });
});

const choice = (c: string, probabilities: Record<string, number>, confidence = 0.5): JevResult => ({ ok: true, answers: { depth: { type: "choice", choice: c, probabilities, confidence } }, route: "cache", inputTokens: 0, cost: 0, ms: 0 });

describe("surveyDepth", () => {
  test("skip at 0.7 or more is skip; below 0.7 it is light", async () => {
    expect((await s.surveyDepth("note", async () => choice("skip", { skip: 0.7 }))).depth).toBe("skip");
    expect((await s.surveyDepth("note", async () => choice("skip", { skip: 0.69 }))).depth).toBe("light");
    expect((await s.surveyDepth("note", async () => choice("skip", {}, 0.9))).depth).toBe("skip"); // falls back to confidence
  });
  test("light, full and other", async () => {
    expect((await s.surveyDepth("note", async () => choice("light", { light: 0.9 }))).depth).toBe("light");
    expect((await s.surveyDepth("note", async () => choice("full", { full: 0.4 }))).depth).toBe("full");
    expect((await s.surveyDepth("note", async () => choice("other", { other: 0.9 }))).depth).toBe("light");
  });
  test("a Jev failure, or a throw, is light", async () => {
    expect(await s.surveyDepth("note", async () => ({ ok: false, error: "down" }))).toEqual({ depth: "light", jev: "failed" });
    expect((await s.surveyDepth("note", async () => { throw new Error("x"); })).depth).toBe("light");
  });
  test("sends the first 4,000 characters, redacted", async () => {
    let sent = "";
    await s.surveyDepth(`${"a".repeat(3990)} OPENROUTER_API_KEY=sk-abcdefghijklmnop12345 ${"b".repeat(500)}`, async (_u, state) => {
      sent = JSON.stringify(state);
      return choice("light", { light: 1 });
    });
    expect(sent).not.toContain("sk-abcdefghijklmnop");
    expect(sent.length).toBeLessThan(4200);
  });
});

describe("parseFindings", () => {
  test("headings, bodies, severities and the closing count", () => {
    const r = s.parseFindings("### Blocker: Section A\nIt breaks.\nSee x.ts:4.\n\n### major: Section B\nUnclear.\n\n### 🔴 Nit: line 3\nTypo.\n\nFindings: 3\n");
    expect(r.unparsed).toBe(false);
    expect(r.findings).toEqual([
      { severity: "Blocker", scope: "Section A", body: "It breaks.\nSee x.ts:4." },
      { severity: "Major", scope: "Section B", body: "Unclear." },
      { severity: "Nit", scope: "line 3", body: "Typo." },
    ]);
  });
  test("text with no heading is one Unparsed finding, never zero", () => {
    const r = s.parseFindings("The plan looks fine but section 3 is vague.");
    expect(r.unparsed).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("Unparsed");
    expect(r.findings[0]!.body).toContain("section 3 is vague");
  });
  test("Findings: 0 is no findings", () => {
    expect(s.parseFindings("Findings: 0")).toEqual({ findings: [], unparsed: false });
  });
});

describe("renderPrompt", () => {
  test("every lens renders with its standard, the parameters and the output format", () => {
    const params = { mode: "review" as const, target: "/v/x.md", code: "/c", vault: "/v" };
    for (const lens of ["zoom-out", "design-critic", "readiness", "codebase", "comprehension"]) {
      const p = s.renderPrompt(lens, params);
      expect(p).toContain(`Target: /v/x.md`);
      expect(p).toContain("career/");
      expect(p).toContain("Findings: <n>");
      expect(p).not.toContain("{{lens}}");
      expect(p.startsWith("---")).toBe(false);
    }
    expect(s.renderPrompt("readiness", params)).toContain("## Detailed implementation plan");
    expect(s.renderPrompt("readiness", params)).toContain("Implementation Readiness Standard");
    expect(s.renderPrompt("comprehension", params)).not.toContain("# Target Standard");
  });
  test("a brainstorm lens fills the template with its own definition only", () => {
    const p = s.renderPrompt("cost", { mode: "brainstorm", target: "/v/x.md", code: null, vault: "/v" });
    expect(p).toContain("Cost, quota and token economics");
    expect(p).not.toContain("Contrarian / YAGNI");
    expect(p).not.toContain("<!-- lenses -->");
  });
});

describe("reviewResolved", () => {
  const review = (resolution: string) => {
    const f = join(root, `r-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(f, `---\ntype: survey\n---\n## Findings\n### F1 — Blocker: a\nx\n### F2 — Major: b\ny\n### F3 — Nit: c\nz\n${resolution}`, "utf8");
    return f;
  };
  test("passes only with every id resolved", () => {
    expect(s.reviewResolved(review("")).ok).toBe(false);
    const r = s.reviewResolved(review("\n## Resolution\nF1: fix — changed\nF2: escalate — only the captain knows\n"));
    expect(r.ok).toBe(false);
    expect(r.open).toEqual([3]);
    expect(r.message).toContain("F3");
    expect(s.reviewResolved(review("\n## Resolution\nF1: fix — a\nF2: contest — x.ts:3\nF3: decline — not worth it\n")).ok).toBe(true);
  });
  test("decline is refused on a Blocker or a Major, accepted on a Nit", () => {
    const r = s.reviewResolved(review("\n## Resolution\nF1: decline — nah\nF2: fix — a\nF3: decline — fine\n"));
    expect(r.ok).toBe(false);
    expect(r.badDecline).toEqual([1]);
    expect(r.open).toEqual([]);
  });
  test("a missing file is not resolved", () => {
    expect(s.reviewResolved(join(root, "nope.md")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- running reviews with a fake pi

function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const msg = (text: string, cost = 0.01, stopReason = "stop", errorMessage = "") => `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage: { cost: { total: cost } }, stopReason, errorMessage } })}\n`;

type Run = { model: string; lens: string; cmd: string[]; env: Record<string, string | undefined>; cwd: string; release: () => void };
let runs: Run[] = [];
let hold = false;
let behave: (model: string, lens: string) => string = (_m, lens) => msg(`### Major: ${lens} scope\nA ${lens} problem.\n\nFindings: 1`);

const fakeSpawn = (cmd: string[], o: { cwd: string; env: Record<string, string | undefined>; out: number }) => {
  const model = cmd[cmd.indexOf("--model") + 1]!;
  const system = cmd[cmd.indexOf("--append-system-prompt") + 1]!;
  const lens = basename(dirname(system)).replace(/-\d+$/, "");
  let release = () => {};
  const exited = new Promise<void>((res) => (release = res));
  writeSync(o.out, behave(model, lens));
  if (!hold) release();
  runs.push({ model, lens, cmd, env: o.env, cwd: o.cwd, release });
  return { pid: 2_000_000_000, exited };
};

const noCode = async () => ({ path: null, repo: null, sha: "abc1234567890", branch: "main", note: "" });
const jevSays = (depth: string) => {
  s.surveyHooks.ask = async () => choice(depth, { [depth]: 0.9 }, 0.9);
};
const wf = (id: string) => j.getWorkflow<Record<string, unknown>>(id)!;

beforeAll(() => {
  s.surveyHooks.spawn = fakeSpawn;
  s.surveyHooks.prepareCode = noCode;
  s.surveyHooks.repos = async () => [];
  jevSays("full");
});

afterEach(() => {
  jevSays("full");
  runs = [];
  hold = false;
  behave = (_m, lens) => msg(`### Major: ${lens} scope\nA ${lens} problem.\n\nFindings: 1`);
  for (const k of ["survey", "survey-lens"] as const) for (const w of j.listWorkflows(k)) if (w.status === "running" || w.status === "waiting") j.updateWorkflow(w.id, { status: "cancelled" });
  process.env.FLEET_SURVEY_BUDGET_USD = "100";
  try {
    for (const f of ["failed-" + new Date().toLocaleDateString("sv") + ".json"]) writeFileSync(join(inbox, ".surveys", f), "[]");
  } catch {
    /* no surveys folder yet */
  }
});

function note(name: string, body = "# A plan\nship: fleet\n"): string {
  const rel = `fleet/plans/feature/${name}.md`;
  writeFileSync(join(vault, rel), `---\ntitle: ${name}\nship: fleet\n---\n${body}`, "utf8");
  return rel;
}

describe("startReview", () => {
  test("a full review runs one reviewer per lens on distinct models, never the writer's, then merges and wakes the Architect", async () => {
    const rel = note("full-one");
    const r = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    expect(r.ok).toBe(true);
    expect(r.depth).toBe("full");
    const id = String(r.id);
    await until(() => wf(id).status === "done");

    expect(runs).toHaveLength(4);
    expect(runs.map((x) => x.lens).sort()).toEqual(["codebase", "design-critic", "readiness", "zoom-out"]);
    expect(new Set(runs.map((x) => x.model)).size).toBe(4);
    expect(runs.some((x) => x.model.endsWith("gpt-6.1-sol"))).toBe(false);
    for (const x of runs) {
      expect(x.env.FLEET_AGENT_ID).toBe("surveyor");
      expect(x.cwd).toBe(vault);
      expect(x.cmd.slice(0, 9)).toEqual(["pi", "--mode", "json", "-p", "--no-session", "--no-skills", "--model", x.model, "--tools"]);
      expect(x.cmd[9]).toBe("read,grep,find,ls");
      expect(x.cmd.filter((c) => c === "-e")).toHaveLength(2);
      expect(x.cmd.some((c) => c.endsWith("extensions/tool-gate.ts"))).toBe(true);
      expect(x.cmd.some((c) => c.endsWith("extensions/cache-watch.ts"))).toBe(true);
      expect(x.env.ALICE_VAULT).toBe(vault);
    }

    const file = String(wf(id).data ? (wf(id).data as { review: string }).review : "");
    expect(file).toBe("fleet/reviews/full-one/review-1.md");
    const text = readFileSync(join(vault, file), "utf8");
    expect(text).toContain("type: survey");
    expect(text).toContain(`writer: ${SOL}`);
    expect(text).toContain("depth: full");
    expect(text).toContain("### F1 — Major:");
    expect(text).toContain("### F4 — Major:");
    expect(readFileSync(join(vault, "fleet/reviews/full-one/triage.md"), "utf8")).toContain("depth: full");
    const bus = readFileSync(join(inbox, "architect", "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(bus.at(-1)).toMatchObject({ kind: "survey-done", ref: file });
    expect(bus.at(-1).summary).toContain("0 blockers, 4 majors, 0 nits");
    expect(s.surveySpentToday()).toBeCloseTo(0.04);
  });

  test("findings merge in severity order and number F1..Fn", async () => {
    behave = (_m, lens) => msg(lens === "readiness" ? "### Nit: n1\nsmall\n\nFindings: 1" : lens === "codebase" ? "### Blocker: b1\nbig\n\n### Nit: n2\nsmall\n\nFindings: 2" : lens === "zoom-out" ? "plain text, no headings" : "Findings: 0");
    const r = await s.startReview("architect", { mode: "review", path: note("merge"), writer: SOL });
    const id = String(r.id);
    await until(() => wf(id).status === "done");
    const text = readFileSync(join(vault, "fleet/reviews/merge/review-1.md"), "utf8");
    const heads = [...text.matchAll(/^### (F\d+ — [A-Za-z]+): (.*)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["F1 — Blocker", "F2 — Nit", "F3 — Nit", "F4 — Unparsed"]);
    expect(text).toContain("status: unparsed");
    expect(text).toContain("Lens: codebase");
  });

  test("a failed reviewer is retried once on the next free candidate; its model is remembered as failing today", async () => {
    jevSays("light");
    let failedModel = "";
    behave = (model, lens) => {
      if (lens === "readiness" && !failedModel) {
        failedModel = model;
        return msg("", 0, "error", "provider 500");
      }
      return msg(`### Nit: ${lens}\nok\n\nFindings: 1`);
    };
    const r = await s.startReview("architect", { mode: "review", path: note("retry"), writer: SOL });
    const id = String(r.id);
    await until(() => wf(id).status === "done");
    const ready = runs.filter((x) => x.lens === "readiness");
    expect(ready).toHaveLength(2);
    expect(ready[1]!.model).not.toBe(failedModel);
    expect(JSON.parse(readFileSync(join(inbox, ".surveys", `failed-${new Date().toLocaleDateString("sv")}.json`), "utf8"))).toContain(failedModel);
    expect(readFileSync(join(vault, "fleet/reviews/retry/review-1.md"), "utf8")).toContain("### F2 — Nit");
  });

  test("a reviewer that fails twice is not run, and the header says so", async () => {
    jevSays("light");
    behave = (_m, lens) => (lens === "codebase" ? msg("", 0, "error", "boom") : msg(`### Nit: ${lens}\nok\n\nFindings: 1`));
    const r = await s.startReview("architect", { mode: "review", path: note("twice"), writer: SOL });
    const id = String(r.id);
    await until(() => wf(id).status === "done");
    const text = readFileSync(join(vault, "fleet/reviews/twice/review-1.md"), "utf8");
    expect(text).toContain("status: not run");
    expect(text).toMatch(/Not run: codebase/);
    expect(readFileSync(join(inbox, "architect", "events.jsonl"), "utf8")).toContain("not run: codebase");
  });

  test("the Architect cannot ask for less depth than Jev picked, but can ask for more; the captain sets any depth", async () => {
    jevSays("full");
    const lower = await s.startReview("architect", { mode: "review", path: note("floor"), writer: SOL, depth: "light" });
    expect(lower.depth).toBe("full");
    await until(() => wf(String(lower.id)).status === "done");
    jevSays("light");
    const higher = await s.startReview("architect", { mode: "review", path: note("raise"), writer: SOL, depth: "full" });
    expect(higher.depth).toBe("full");
    expect(readFileSync(join(vault, "fleet/reviews/raise/triage.md"), "utf8")).toContain("by: architect");
    await until(() => wf(String(higher.id)).status === "done");
    const captain = await s.startReview("captain", { mode: "review", path: note("cap"), writer: SOL, depth: "light" });
    expect(captain.depth).toBe("light");
    expect(readFileSync(join(vault, "fleet/reviews/cap/triage.md"), "utf8")).toContain("by: captain");
    await until(() => wf(String(captain.id)).status === "done");
  });

  test("skip runs nothing and is on record in triage.md", async () => {
    s.surveyHooks.ask = async () => choice("skip", { skip: 0.95 }, 0.95);
    const r = await s.startReview("architect", { mode: "brainstorm", path: note("small"), writer: SOL });
    expect(r.ok).toBe(true);
    expect(r.depth).toBe("skip");
    expect(r.id).toBeUndefined();
    expect(runs).toHaveLength(0);
    const triage = readFileSync(join(vault, "fleet/reviews/small/triage.md"), "utf8");
    expect(triage).toContain("depth: skip");
    expect(triage).toContain("jev: skip 0.95");
    expect(triage).toContain("by: jev");
    expect(triage).toContain("mode: brainstorm");
  });

  test("Jev down means a light review", async () => {
    s.surveyHooks.ask = async () => ({ ok: false, error: "down" });
    const r = await s.startReview("architect", { mode: "brainstorm", path: note("jevdown"), writer: SOL });
    expect(r.depth).toBe("light");
    await until(() => wf(String(r.id)).status === "done");
    expect(runs.map((x) => x.lens).sort()).toEqual(["contrarian", "cost", "operations"]);
    expect(existsSync(join(vault, "fleet/reviews/jevdown/brainstorm-1.md"))).toBe(true);
    expect(readFileSync(join(vault, "fleet/reviews/jevdown/triage.md"), "utf8")).toContain("jev: failed");
  });

  test("the review number counts runs of that mode for that note", async () => {
    const rel = note("again");
    for (const n of [1, 2]) {
      const r = await s.startReview("architect", { mode: "review", path: rel, writer: SOL, depth: "full" });
      await until(() => wf(String(r.id)).status === "done");
      expect(existsSync(join(vault, `fleet/reviews/again/review-${n}.md`))).toBe(true);
    }
  });

  test("a spent budget refuses a review and names the spend", async () => {
    const rel = note("budget");
    const first = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    await until(() => wf(String(first.id)).status === "done");
    process.env.FLEET_SURVEY_BUDGET_USD = "0.03";
    const r = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("$0.");
    expect(r.message).toContain("FLEET_SURVEY_BUDGET_USD");
  });

  test("a second review waits for the first, then starts", async () => {
    jevSays("light");
    hold = true;
    const a = await s.startReview("architect", { mode: "review", path: note("first"), writer: SOL });
    const b = await s.startReview("architect", { mode: "review", path: note("second"), writer: SOL });
    expect(wf(String(a.id)).status).toBe("running");
    expect(wf(String(b.id)).status).toBe("waiting");
    expect(b.message).toContain("waits");
    await until(() => runs.length === 2);
    expect(runs).toHaveLength(2);
    hold = false;
    for (const x of runs) x.release();
    await until(() => wf(String(a.id)).status === "done");
    await until(() => wf(String(b.id)).status === "done");
    expect(runs).toHaveLength(4);
    expect(existsSync(join(vault, "fleet/reviews/second/review-1.md"))).toBe(true);
  });

  test("at most four reviewers run at once; a six-lens brainstorm runs in waves", async () => {
    hold = true;
    const r = await s.startReview("architect", { mode: "brainstorm", path: note("six"), writer: SOL, depth: "full" });
    await until(() => runs.length === 4);
    await Bun.sleep(50);
    expect(runs).toHaveLength(4);
    expect(j.listWorkflows("survey-lens", "running")).toHaveLength(4);
    runs[0]!.release(); // one ends: the next lens starts, and the cap holds
    await until(() => runs.length === 5);
    expect(j.listWorkflows("survey-lens", "running")).toHaveLength(4);
    hold = false; // the rest exit as soon as they start
    for (const x of runs) x.release();
    await until(() => wf(String(r.id)).status === "done");
    expect(runs).toHaveLength(6);
  });

  test("refusals: bad mode, bad depth, a note outside the vault, career/, no writer, comprehension in brainstorm", async () => {
    const rel = note("refuse");
    expect((await s.startReview("captain", { mode: "plan", path: rel, writer: SOL })).ok).toBe(false);
    expect((await s.startReview("captain", { mode: "review", path: rel, writer: SOL, depth: "huge" })).ok).toBe(false);
    expect((await s.startReview("captain", { mode: "review", path: "../etc/passwd.md", writer: SOL })).ok).toBe(false);
    writeFileSync(join(vault, "career/cv.md"), "private");
    expect((await s.startReview("captain", { mode: "review", path: "career/cv.md", writer: SOL })).message).toContain("career/");
    expect((await s.startReview("captain", { mode: "review", path: "fleet/plans/feature/nope.md", writer: SOL })).message).toContain("does not exist");
    expect((await s.startReview("captain", { mode: "review", path: rel, writer: "" })).message).toContain("--writer");
    expect((await s.startReview("captain", { mode: "brainstorm", path: rel, writer: SOL, lenses: "+comprehension" })).ok).toBe(false);
    expect(runs).toHaveLength(0);
  });

  test("the Architect's writer comes from model-running.json", async () => {
    mkdirSync(join(inbox, "architect"), { recursive: true });
    writeFileSync(join(inbox, "architect", "model-running.json"), JSON.stringify({ model: SOL }));
    expect(s.architectWriter()).toBe(SOL);
    const r = await s.startReview("architect", { mode: "review", path: note("writer"), depth: "full" });
    await until(() => wf(String(r.id)).status === "done");
    expect(readFileSync(join(vault, "fleet/reviews/writer/review-1.md"), "utf8")).toContain(`writer: ${SOL}`);
    expect(runs.some((x) => x.model.endsWith("gpt-6.1-sol"))).toBe(false);
  });
});

describe("recoverSurveys", () => {
  test("a reviewer that ended while the node was down is finished, and the review merges", async () => {
    jevSays("light");
    hold = true;
    const r = await s.startReview("architect", { mode: "review", path: note("recover"), writer: SOL });
    const id = String(r.id);
    await until(() => runs.length === 2);
    // The node "restarts": the processes ended, and no exit handler is there to say so.
    const kids = j.listWorkflows<{ parent: string }>("survey-lens").filter((c) => c.data.parent === id);
    expect(kids.every((c) => c.status === "running")).toBe(true);
    hold = false;
    await s.recoverSurveys();
    await until(() => wf(id).status === "done");
    expect(existsSync(join(vault, "fleet/reviews/recover/review-1.md"))).toBe(true);
  });

  test("a reviewer still alive is re-attached, not finished", async () => {
    jevSays("light");
    hold = true;
    const r = await s.startReview("architect", { mode: "review", path: note("alive"), writer: SOL });
    const id = String(r.id);
    await until(() => runs.length === 2);
    for (const c of j.listWorkflows<{ parent: string }>("survey-lens")) if (c.data.parent === id) j.updateWorkflow(c.id, { data: { pid: process.pid } });
    await s.recoverSurveys();
    expect(wf(id).status).toBe("running");
    expect(j.listWorkflows<{ parent: string }>("survey-lens", "running").filter((c) => c.data.parent === id)).toHaveLength(2);
  });

  test("a waiting review starts at recovery when none is running", async () => {
    const rel = note("queued");
    j.upsertWorkflow("survey", "s-queued", { by: "architect", mode: "review", target: rel, slug: "queued", ship: "fleet", writer: SOL, depth: "light", lenses: ["readiness", "codebase"], jev: "light 0.9", depthBy: "jev", rows: [], dir: join(inbox, ".surveys", "s-queued"), code: null, repo: null, sha: "", codeNote: "", started: new Date().toISOString() }, { status: "waiting" });
    await s.recoverSurveys();
    await until(() => wf("s-queued").status === "done");
    expect(existsSync(join(vault, "fleet/reviews/queued/review-1.md"))).toBe(true);
  });
});

describe("prepareCode", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  let tip = "";

  test("fetches, finds the default branch, and adds a detached worktree at its tip", async () => {
    mkdirSync(origin);
    sh(origin, "init", "-q", "-b", "trunk");
    writeFileSync(join(origin, "a.txt"), "a");
    sh(origin, "add", ".");
    sh(origin, "commit", "-qm", "one");
    sh(root, "clone", "-q", origin, clone);
    writeFileSync(join(origin, "b.txt"), "b"); // after the clone: only a fetch brings it
    sh(origin, "add", ".");
    sh(origin, "commit", "-qm", "two");
    tip = sh(origin, "rev-parse", "HEAD");

    const c = await s.prepareCode("x", "s-code1", { repoOf: async () => clone });
    expect(c.branch).toBe("trunk");
    expect(c.sha).toBe(tip);
    expect(c.note).toBe("");
    expect(c.path).toBe(join(inbox, ".surveys", "s-code1", "code"));
    expect(readFileSync(join(c.path!, "b.txt"), "utf8")).toBe("b");
    expect(sh(c.path!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // detached
    expect(sh(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("trunk"); // the ship's own branch did not move
  });

  test("a failed fetch runs on the local origin branch and says the code may be stale", async () => {
    renameSync(origin, `${origin}-gone`);
    const c = await s.prepareCode("x", "s-code2", { repoOf: async () => clone });
    expect(c.path).not.toBeNull();
    expect(c.note).toContain("code may be stale: fetch failed");
    expect(existsSync(join(c.path!, "a.txt"))).toBe(true);
    expect(c.sha).toBe(tip); // origin/trunk as the clone last fetched it
  });

  test("a ship with no checkout gets no code and a note", async () => {
    const c = await s.prepareCode("ghost", "s-code3", { repoOf: async () => null });
    expect(c.path).toBeNull();
    expect(c.note).toContain("no code");
  });
});

describe("reviewReady", () => {
  const withReview = (rel: string, review: string): string => {
    const text = readFileSync(join(vault, rel), "utf8");
    writeFileSync(join(vault, rel), text.replace(/^---\n/, `---\n${review ? `review: ${review}\n` : ""}`), "utf8");
    return rel;
  };
  const resolve = (file: string, resolution: string) => writeFileSync(join(vault, file), `${readFileSync(join(vault, file), "utf8")}\n## Resolution\n${resolution}`, "utf8");
  const reviewed = async (name: string) => {
    jevSays("light");
    const rel = note(name);
    const r = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    await until(() => wf(String(r.id)).status === "done");
    return { rel, file: (wf(String(r.id)).data as { review: string }).review, id: String(r.id) };
  };

  test("refuses a note with no review:, and a missing note", async () => {
    const rel = note("ready-none");
    const r = s.reviewReady(rel);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no `review:`");
    expect(s.reviewReady("fleet/plans/feature/ghost.md").ok).toBe(false);
  });

  test("refuses a review file the node has no record of, one for another target, and one for brainstorm mode", async () => {
    const rel = note("ready-forged");
    mkdirSync(join(vault, "fleet/reviews/ready-forged"), { recursive: true });
    writeFileSync(join(vault, "fleet/reviews/ready-forged/review-9.md"), "### F1 — Nit: a\n\n## Resolution\nF1: fix — x\n");
    withReview(rel, "fleet/reviews/ready-forged/review-9.md");
    expect(s.reviewReady(rel).message).toContain("not a review the node wrote");
    // A record for another target does not count.
    j.upsertWorkflow("survey", "s-ready-other", { mode: "review", target: "fleet/plans/feature/other.md", review: "fleet/reviews/ready-forged/review-9.md", ids: [1] }, { status: "done" });
    expect(s.reviewReady(rel).ok).toBe(false);
    // Nor does one in brainstorm mode.
    j.upsertWorkflow("survey", "s-ready-brain", { mode: "brainstorm", target: rel, review: "fleet/reviews/ready-forged/review-9.md", ids: [1] }, { status: "done" });
    expect(s.reviewReady(rel).ok).toBe(false);
    j.upsertWorkflow("survey", "s-ready-mine", { mode: "review", target: rel, review: "fleet/reviews/ready-forged/review-9.md", ids: [1], depth: "light", counts: {} }, { status: "done" });
    expect(s.reviewReady(rel).ok).toBe(true);
  });

  test("accepts a resolved review (absolute or vault-relative note path), refuses an open finding and a deleted one", async () => {
    const { rel, file } = await reviewed("ready-ok");
    withReview(rel, file);
    const open = s.reviewReady(rel);
    expect(open.ok).toBe(false);
    expect(open.message).toContain("no resolution for F1, F2");
    resolve(file, "F1: fix — changed\nF2: escalate — only the captain knows\n");
    const ok = s.reviewReady(join(vault, rel));
    expect(ok.ok).toBe(true);
    expect(ok.review).toMatchObject({ depth: "light", rel: file, escalations: ["F2: only the captain knows"] });
    expect(ok.review!.counts.Major).toBe(2);
    // A finding deleted from the file is caught by the ids the node counted.
    const text = readFileSync(join(vault, file), "utf8");
    writeFileSync(join(vault, file), text.replace(/### F2 — [\s\S]*?(?=\n## Resolution)/, "").replace(/^F2: .*$/m, ""), "utf8");
    const gone = s.reviewReady(rel);
    expect(gone.ok).toBe(false);
    expect(gone.message).toContain("F2");
    expect(gone.message).toContain("no longer has");
  });

  test("skipped needs a review-mode skip on record, not a brainstorm skip", async () => {
    const rel = withReview(note("ready-skip"), "skipped");
    s.surveyHooks.ask = async () => choice("skip", { skip: 0.95 }, 0.95);
    const b = await s.startReview("architect", { mode: "brainstorm", path: rel, writer: SOL });
    expect(b.depth).toBe("skip");
    expect(s.reviewReady(rel).ok).toBe(false);
    await Bun.sleep(5);
    const r = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    expect(r.depth).toBe("skip");
    expect(runs).toHaveLength(0);
    expect(s.reviewReady(rel)).toMatchObject({ ok: true, review: null });
  });

  test("unavailable needs a failed review-mode record, from a budget refusal here", async () => {
    const rel = withReview(note("ready-unavail"), "unavailable");
    expect(s.reviewReady(rel).ok).toBe(false);
    process.env.FLEET_SURVEY_BUDGET_USD = "0.001";
    const spent = s.surveySpentToday();
    expect(spent).toBeGreaterThan(0.001);
    const refused = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    expect(refused.ok).toBe(false);
    const r = s.reviewReady(rel);
    expect(r.ok).toBe(true);
    expect(r.unavailable).toContain("FLEET_SURVEY_BUDGET_USD");
    await Bun.sleep(5); // the latest record is the one created last
    // A review that then succeeds replaces the failure as the latest record.
    process.env.FLEET_SURVEY_BUDGET_USD = "100";
    jevSays("light");
    const again = await s.startReview("architect", { mode: "review", path: rel, writer: SOL });
    await until(() => wf(String(again.id)).status === "done");
    expect(s.reviewReady(rel).ok).toBe(false);
  });
});
