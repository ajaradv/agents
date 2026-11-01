import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { aliceVault, nodeStateDir, ROOT } from "./paths.ts";
import { reviewStatus } from "./review-status.ts";
import { readRoadmap } from "./roadmap.ts";
import { fitSections } from "./session-brief.ts";
import { splitNote } from "./vault-note.ts";
import { vaultTasksReport } from "./vault-tasks.ts";

/**
 * The engineer's session brief (vault plan fleet-engineer, E1): `bin/fleet-axi --brief --engineer`,
 * printed by the Claude Code SessionStart hook. Markdown in the shape of Alice's brief: a head
 * line, then `## title` sections of `- ` lines, built from live sources and capped. The laptop
 * builds the repo, PR, plan, roadmap and handoff sections and asks the hub for the Hub and Fleet
 * sections in one call (`bin/hub fleet-axi --brief --hub-part`). Each section fails on its own
 * as "- unavailable: <reason>"; nothing here makes the command fail.
 */

export const ENGINEER_BRIEF_CAP = 8000;
const REPO = "ajaradv/agents";
const HUB_TERM_MS = 8000;
const HUB_KILL_MS = 1000;
const GH_TIMEOUT_MS = 5000;
const DRILL_OVERDUE_DAYS = 8;
const PLAN_DAYS = 30;
const PLAN_STATUSES = ["draft", "accepted", "decided", "in-progress", "active", "queued"];
const PLANS_SHOWN = 8;
const HANDOFF_CAP = 2000;
const NOW_CAP = 300;
const NEXT_SHOWN = 3;
const UNITS = ["fleet-node", "fleet-dashboard", "fleet-litestream", "fleet-heartbeat.timer"];
const DAY_MS = 86_400_000;

/** Runs `git <args>` in `cwd` and returns trimmed stdout; throws when git fails. */
export type Git = (cwd: string, args: string[]) => string;
/** Runs `gh <args>` and returns stdout; throws when gh is missing, unauthenticated or too slow. */
export type Gh = (args: string[]) => Promise<string>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cutAt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const realGit: Git = (cwd, args) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || `git ${args[0]} exited ${r.exitCode}`);
  return r.stdout.toString().trim();
};

export const realGh: Gh = async (args) => {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), GH_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(code === null || code === 137 ? `gh timed out after ${GH_TIMEOUT_MS / 1000} s` : oneLine(err) || `gh exited ${code}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
};

/** "5m ago", "3h ago", "2d ago". */
export function ago(then: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - then.getTime());
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < DAY_MS) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

// --- Repo -------------------------------------------------------------------

/** The primary checkout against its last-fetched origin/main (no fetch here), and worktrees with work not on a remote. */
export function repoSection(primary: string, git: Git, fetchedAt: () => Date | null = () => fetchHeadTime(primary, git)): string[] {
  const num = (cwd: string, range: string) => Number(git(cwd, ["rev-list", "--count", range]));
  const branch = git(primary, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const changed = git(primary, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const behind = num(primary, `${branch}..origin/main`);
  const ahead = num(primary, `origin/main..${branch}`);
  const fetched = fetchedAt();
  const where = !behind && !ahead ? "even with origin/main" : [behind ? `${behind} behind origin/main` : "", ahead ? `${ahead} ahead of origin/main` : ""].filter(Boolean).join(", ");
  const lines = [`- primary: ${branch}, ${changed ? `${changed} changed file${changed === 1 ? "" : "s"}` : "clean"}, ${where} (as of the last fetch${fetched ? `, ${stamp(fetched)}` : ": never"})`];

  const found: { path: string; branch: string; head: string; detached: boolean }[] = [];
  let cur: (typeof found)[number] | null = null;
  for (const l of git(primary, ["worktree", "list", "--porcelain"]).split("\n")) {
    if (l.startsWith("worktree ")) found.push((cur = { path: l.slice(9), branch: "", head: "", detached: false }));
    else if (l.startsWith("HEAD ") && cur) cur.head = l.slice(5);
    else if (l === "detached" && cur) cur.detached = true;
    else if (l.startsWith("branch ") && cur) cur.branch = l.slice(7).replace(/^refs\/heads\//, "");
  }
  // The first entry is the primary itself.
  for (const w of found.slice(1)) {
    const shown = w.path.replace(process.env.HOME ?? "\0", "~");
    if (w.detached) {
      lines.push(`- worktree ${shown}: detached at ${w.head.slice(0, 7)}`);
      continue;
    }
    if (!w.branch) continue;
    let n: number;
    let upstream = true;
    try {
      n = num(w.path, "@{upstream}..HEAD");
    } catch {
      upstream = false;
      n = num(w.path, "origin/main..HEAD");
    }
    if (n === 0 && upstream) continue;
    lines.push(`- worktree ${shown} (${w.branch}): ${n} commit${n === 1 ? "" : "s"} not on ${upstream ? "its upstream" : "origin/main"}${upstream ? "" : ", no upstream"}`);
  }
  return lines;
}

function fetchHeadTime(primary: string, git: Git): Date | null {
  try {
    return statSync(resolve(primary, git(primary, ["rev-parse", "--git-path", "FETCH_HEAD"]))).mtime;
  } catch {
    return null;
  }
}

// --- PRs --------------------------------------------------------------------

type PrCheck = { conclusion?: string; state?: string; status?: string };
type Pr = { number: number; title: string; isDraft?: boolean; reviewDecision?: string; statusCheckRollup?: PrCheck[] };

/** red if any check failed, pending if any is still running, green if all passed, "no checks" when there are none. */
export function ciRollup(checks: PrCheck[]): "red" | "pending" | "green" | "no checks" {
  if (!checks.length) return "no checks";
  const states = checks.map((c) => (c.conclusion || c.state || c.status || "").toUpperCase());
  if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(s))) return "red";
  if (states.every((s) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s))) return "green";
  return "pending";
}

export async function prSection(gh: Gh): Promise<string[]> {
  const out = await gh(["pr", "list", "--repo", REPO, "--state", "open", "--limit", "10", "--json", "number,title,isDraft,reviewDecision,statusCheckRollup"]);
  const prs = JSON.parse(out) as Pr[];
  if (!prs.length) return ["- no open PRs"];
  return prs.map((p) => {
    const review = p.reviewDecision ? p.reviewDecision.toLowerCase().replace(/_/g, " ") : "none";
    return `- #${p.number} ${cutAt(oneLine(p.title), 90)}${p.isDraft ? " (draft)" : ""}: CI ${ciRollup(p.statusCheckRollup ?? [])}, review ${review}`;
  });
}

// --- Hub and Fleet (computed on the hub) ------------------------------------

export type HubRun = (cmd: string[]) => Promise<string>;
export type HubDeps = {
  now?: Date;
  /** Command stdout whatever its exit code (is-active exits 1 for an inactive unit). */
  run?: HubRun;
  fleet?: () => Promise<string[]>;
};

const defaultRun = (root: string): HubRun => async (cmd) => {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  // Each hub check gets 5 s, so a hung systemctl or drift check doesn't outlive the laptop's ssh.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  try {
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
};

/** The Hub and Fleet sections as markdown, for the laptop to insert as they are. Runs on the hub. */
export async function hubPart(root: string = ROOT, deps: HubDeps = {}): Promise<string> {
  const now = deps.now ?? new Date();
  const run = deps.run ?? defaultRun(root);
  const each = async (fn: () => Promise<string[]> | string[]): Promise<string[]> => {
    try {
      return await fn();
    } catch (e) {
      return [`- unavailable: ${errText(e)}`];
    }
  };
  const hub = [
    ...(await each(() => {
      const log = join(root, "fleet", "inbox", ".node", "deploys.log");
      const last = readFileSync(log, "utf8").trim().split("\n").pop() ?? "";
      const [time, from, to, kind] = last.split(/\s+/);
      if (!time || !to) return ["- no deploy recorded"];
      return [`- last deploy ${ago(new Date(time), now)}: ${from!.slice(0, 7)}→${to.slice(0, 7)} (${kind})`];
    })),
    ...(await each(async () => {
      const drift = await run([join(root, "bin", "fleet-services"), "drift"]);
      return drift ? drift.split("\n").map((l) => `- services: ${l.trim()}`) : ["- services: current"];
    })),
    ...(await each(async () => {
      const states = (await run(["systemctl", "is-active", ...UNITS])).split("\n").map((l) => l.trim());
      if (states.length !== UNITS.length) throw new Error(`systemctl gave ${states.length} lines for ${UNITS.length} units`);
      const bad = UNITS.map((u, i) => (states[i] === "active" ? "" : `${u} ${states[i] || "unknown"}`)).filter(Boolean);
      return [bad.length ? `- units: ${bad.join(", ")}` : "- units: all active"];
    })),
    ...(await each(() => [drillLine(now)])),
  ];
  const fleet = await each(deps.fleet ?? fleetFacts);
  return ["## Hub", ...hub, "", "## Fleet", ...fleet].join("\n");
}

function drillLine(now: Date): string {
  const state = JSON.parse(readFileSync(join(nodeStateDir(), "routines.json"), "utf8")) as Record<string, { lastRun?: string; status?: string; note?: string }>;
  const d = state["backup-drill"];
  if (!d?.lastRun) return "- backup drill: never run";
  const when = ago(new Date(d.lastRun), now);
  const overdue = now.getTime() - Date.parse(d.lastRun) > DRILL_OVERDUE_DAYS * DAY_MS;
  if (d.status === "error") return `- backup drill: **failed: ${cutAt(oneLine(d.note ?? "no note"), 160)}** ${when}${overdue ? " **overdue**" : ""}`;
  return `- backup drill: ${d.status ?? "unknown"} ${when}${overdue ? " **overdue**" : ""}`;
}

/** The three facts `fleet-axi --brief` prints (home() in bin/fleet-axi): who works, what waits on the captain, ready vault tasks. */
async function fleetFacts(): Promise<string[]> {
  // Loaded here: fleet-api opens the fleet's databases, which the laptop's sections do not need.
  const { fleetStatus } = await import("./fleet-api.ts");
  const s = (await fleetStatus(false)) as { message: string; needsCaptain?: Record<string, unknown>[] };
  const ready = vaultTasksReport("ready") as { tasks?: { id: string; title: string; priority: string }[]; message: string };
  const waiting = s.needsCaptain?.length ? `waiting on the captain: ${s.needsCaptain.slice(0, 3).map((n) => cutAt(oneLine(String(n.summary ?? n.id ?? "")), 80)).join("; ")}` : "nothing waiting on the captain";
  return [`- ${s.message}`, `- ${waiting}`, `- ${ready.message}${ready.tasks?.length ? ` ${ready.tasks.slice(0, 5).map((t) => t.id).join(", ")}` : ""}`];
}

/** Titles and lines of a `## title` markdown text, as `hubPart` writes it. */
export function parseSections(text: string): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const l of text.split("\n")) {
    if (l.startsWith("## ")) out.push([l.slice(3).trim(), []]);
    else if (l.trim() && out.length) out.at(-1)![1].push(l);
  }
  return out;
}

/** Asks the hub for its part: `bin/hub fleet-axi --brief --hub-part`, SIGTERM after 8 s, SIGKILL 1 s later. Throws with the reason on failure. */
export async function spawnHubPart(root: string = ROOT, opts: { termMs?: number; killMs?: number } = {}): Promise<string> {
  const proc = Bun.spawn([join(root, "bin", "hub"), "fleet-axi", "--brief", "--hub-part"], {
    cwd: root,
    env: { ...process.env, FLEET_HUB_SSH_OPTS: "-o ConnectTimeout=5 -o BatchMode=yes" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    killer = setTimeout(() => proc.kill("SIGKILL"), opts.killMs ?? HUB_KILL_MS);
  }, opts.termMs ?? HUB_TERM_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) throw new Error(`no answer in ${(opts.termMs ?? HUB_TERM_MS) / 1000} s`);
    if (code !== 0) throw new Error(oneLine(err).slice(0, 160) || `exit ${code}`);
    return out;
  } finally {
    clearTimeout(term);
    clearTimeout(killer);
  }
}

// --- Not deployed -----------------------------------------------------------

export function notDeployedSection(primary: string, sha: string, git: Git): string[] {
  const n = Number(git(primary, ["rev-list", "--count", `${sha}..origin/main`]));
  return n > 0 ? [`- ${n} commit${n === 1 ? "" : "s"} on main not deployed`] : [];
}

// --- Plans ------------------------------------------------------------------

function* markdownFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) yield* markdownFiles(join(dir, e.name));
    else if (e.name.endsWith(".md")) yield join(dir, e.name);
  }
}

const dayOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v.slice(0, 10) : "");

/** Plans in the vault still in play: a live status and `updated` (else `created`) within 30 days. */
export function planSection(vault: string, today: string): string[] {
  const dir = join(vault, "fleet", "plans");
  if (!existsSync(dir)) return ["- no fleet/plans folder in the vault"];
  const found: { day: string; line: string }[] = [];
  for (const file of markdownFiles(dir)) {
    const fm = splitNote(readFileSync(file, "utf8")).fm;
    const status = String(fm?.status ?? "");
    const day = dayOf(fm?.updated) || dayOf(fm?.created);
    if (!fm || !PLAN_STATUSES.includes(status) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS;
    if (age > PLAN_DAYS) continue;
    const name = relative(dir, file).replace(/\.md$/, "");
    const review = typeof fm.review === "string" ? reviewStatus(join(vault, fm.review)) : null;
    found.push({ day, line: `- \`${name}\` ${status}, ${review ? `review ${review.open.length} open of ${review.ids.length}` : "no review"}` });
  }
  if (!found.length) return ["- no plans in play"];
  // Newest first; the sort is stable, so equal days keep their path order.
  found.sort((a, b) => b.day.localeCompare(a.day));
  const lines = found.slice(0, PLANS_SHOWN).map((f) => f.line);
  if (found.length > PLANS_SHOWN) lines.push(`- (+${found.length - PLANS_SHOWN} more: bin/fleet-axi search --path fleet/plans)`);
  return lines;
}

// --- Roadmap ----------------------------------------------------------------

export function roadmapSection(vault: string, repo?: string, now?: Date): string[] {
  const r = readRoadmap("fleet", repo, { vault, now });
  if (r.missing) return ["- no ships/fleet/roadmap.md yet"];
  const lines = [`- now: ${cutAt(oneLine(r.now), NOW_CAP) || "(empty)"}`];
  for (const n of r.nextUp.slice(0, NEXT_SHOWN)) lines.push(`- next ${n.n}: ${cutAt(oneLine(n.raw), 160)}`);
  if (r.stale.length) lines.push(`- stale: ${r.stale.join("; ")}`);
  return lines;
}

// --- Handoff ----------------------------------------------------------------

export function handoffSection(vault: string): string[] {
  const file = join(vault, "fleet", "engineer", "handoff.md");
  if (!existsSync(file)) return ["- no fleet/engineer/handoff.md yet"];
  const { fm, body } = splitNote(readFileSync(file, "utf8"));
  const lines = body.trim().slice(0, HANDOFF_CAP).split("\n").filter((l) => l.trim());
  // The note's own headings would split the brief's sections; show them as bold lines.
  const flat = lines.map((l) => l.replace(/^#{1,6}\s+(.*)$/, "**$1**"));
  const updated = dayOf(fm?.updated);
  return [`- updated ${updated || "(no date)"}`, ...flat];
}

// --- The brief --------------------------------------------------------------

export type EngineerDeps = {
  primary?: string;
  vault?: string;
  now?: Date;
  git?: Git;
  gh?: Gh;
  /** The hub's Hub and Fleet sections as markdown; throws when the hub does not answer. */
  hub?: () => Promise<string>;
  fetchedAt?: () => Date | null;
};

/** Markdown for the start of an engineer session, never longer than ENGINEER_BRIEF_CAP bytes. */
export async function engineerBrief(deps: EngineerDeps = {}): Promise<string> {
  const primary = deps.primary ?? ROOT;
  const vault = deps.vault ?? aliceVault();
  const now = deps.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const git = deps.git ?? realGit;
  const gh = deps.gh ?? realGh;
  const hub = deps.hub ?? (process.platform === "linux" ? () => hubPart(primary) : () => spawnHubPart(primary));

  const guard = async (fn: () => Promise<string[]> | string[]): Promise<string[]> => {
    try {
      return await fn();
    } catch (e) {
      return [`- unavailable: ${errText(e)}`];
    }
  };
  const [repo, prs, hubText] = await Promise.all([
    guard(() => repoSection(primary, git, deps.fetchedAt)),
    guard(() => prSection(gh)),
    hub().then(
      (text) => ({ text }),
      (e) => ({ error: errText(e) }),
    ),
  ]);

  let hubLines: string[];
  let fleetLines: string[] = [];
  let notDeployed: string[] = [];
  if ("error" in hubText) hubLines = [`- hub unreachable (${hubText.error})`];
  else {
    const parts = parseSections(hubText.text);
    hubLines = parts.find(([t]) => t === "Hub")?.[1] ?? ["- unavailable: the hub sent no Hub section"];
    fleetLines = parts.find(([t]) => t === "Fleet")?.[1] ?? ["- unavailable: the hub sent no Fleet section"];
    const sha = hubLines.join("\n").match(/→([0-9a-f]{7,40})/)?.[1];
    if (sha) notDeployed = await guard(() => notDeployedSection(primary, sha, git));
  }

  const sections: [string, string[]][] = [
    ["Repo", repo],
    ["PRs", prs],
    ["Hub", hubLines],
    ["Not deployed", notDeployed],
    ["Fleet", fleetLines],
    ["Plans", await guard(() => planSection(vault, today))],
    ["Roadmap", await guard(() => roadmapSection(vault, primary, now))],
    ["Handoff", await guard(() => handoffSection(vault))],
  ];
  const head = `# Engineer brief ${today} (built from live sources; nothing here is a model's memory)`;
  // The "cut:" line is added after fitting, so leave it room.
  const { text, cut } = fitSections(head, sections, ENGINEER_BRIEF_CAP - 20);
  return `${text}${cut.length ? `\n- cut: ${cut.join(", ")}` : ""}\n`;
}
