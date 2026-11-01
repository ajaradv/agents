import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatter, readShips } from "./fleet-layers.ts";
import { aliceVault } from "./paths.ts";

/**
 * Ship roadmaps (vault plan ship-roadmaps, SR1): `{vault}/ships/<ship>/roadmap.md`,
 * one per ship, written by the Architect. This reads them for `ship_next`: Now,
 * the milestones, the Next up items (a fixed shape a tool can parse), recently
 * done, and the captain's open questions, plus whether the note has gone stale
 * (its `updated` date is old, or the ship's repo moved on past `sources.repo`).
 * Parsing is tolerant: a missing section or a loose Next up line gives less, never an error.
 */

export type Milestone = { id: string; milestone: string; status: string; doneWhen: string };

export type NextItem = {
  /** 1-based position in the list. */
  n: number;
  title: string;
  /** The milestone id in parentheses ("P3"), or "". */
  milestone: string;
  /** "S", "M" or "L", or "". */
  size: string;
  /** "ready to sail", "spec-session", "design-session", "needs the captain", or the raw words, or "". */
  ready: string;
  why: string;
  /** The line as written (continuation lines joined). */
  raw: string;
};

export type Roadmap = {
  ship: string;
  missing?: false;
  summary: string;
  /** YYYY-MM-DD, or "". */
  updated: string;
  updatedBy: string;
  sourcesRepo: string;
  now: string;
  milestones: Milestone[];
  nextUp: NextItem[];
  recentlyDone: string[];
  openQuestions: string[];
  /** Why the note may no longer be true; empty when it looks current. */
  stale: string[];
};

export type MissingRoadmap = { ship: string; missing: true };

/** Days after which `updated` makes a roadmap stale. */
export const STALE_DAYS = 8;

const DAY_MS = 86_400_000;

/** `## Heading` sections of a note body, by lowercased heading. */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "";
  let buf: string[] = [];
  const flush = () => {
    if (name) out.set(name, buf.join("\n").trim());
  };
  for (const line of body.split("\n")) {
    const h = /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      name = h[1]!.toLowerCase();
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}

/** The section whose heading starts with `prefix` ("open questions" matches "Open questions for the captain"). */
function section(all: Map<string, string>, prefix: string): string {
  for (const [k, v] of all) if (k.startsWith(prefix)) return v;
  return "";
}

const cleanCell = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`/g, "").trim();

function parseMilestones(text: string): Milestone[] {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\||\|$/g, "").split("|").map(cleanCell));
  if (!rows.length) return [];
  const head = rows[0]!.map((c) => c.toLowerCase());
  const col = (re: RegExp, fallback: number) => {
    const i = head.findIndex((c) => re.test(c));
    return i >= 0 ? i : fallback;
  };
  const [iId, iMs, iSt, iDw] = [col(/^id$/, 0), col(/^milestone/, 1), col(/^status/, 2), col(/done/, 3)];
  return rows
    .slice(1)
    .filter((r) => !r.every((c) => /^:?-{2,}:?$|^$/.test(c)))
    .map((r) => ({ id: r[iId] ?? "", milestone: r[iMs] ?? "", status: r[iSt] ?? "", doneWhen: r[iDw] ?? "" }))
    .filter((m) => m.id || m.milestone);
}

/** List items of a section (bullets or numbers), continuation lines folded in; "none" placeholders dropped. */
function listItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) items.push(m[1]!.trim());
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.filter((i) => i && !/^(none|n\/a|nothing)\.?$/i.test(i));
}

/** A readiness phrase as one of the four words the plan names, else the raw words. */
function readiness(s: string): string {
  const t = s.toLowerCase();
  if (/ready to sail|\bvoyage\b|\bsail\b/.test(t)) return "ready to sail";
  if (/spec/.test(t)) return "spec-session";
  if (/design/.test(t)) return "design-session";
  if (/captain/.test(t)) return "needs the captain";
  return s.trim();
}

const READINESS_ANYWHERE = /ready to sail|(?:needs? an? )?spec[- ]session|(?:needs? an? )?design[- ]session|needs? the captain/i;

/** One Next up line: `**Title** (P3), size M, ready: spec-session. Why: ... Links: ...`. */
export function parseNextItem(raw: string, n: number): NextItem {
  const bold = /\*\*(.+?)\*\*/.exec(raw);
  const afterTitle = bold ? raw.slice(bold.index + bold[0].length) : raw;
  let title = bold ? bold[1]!.trim() : (/^[^(,]+/.exec(raw)?.[0] ?? raw).trim();
  title = title.replace(/[.:\s]+$/, "");
  const ms = [...afterTitle.matchAll(/\(([^()]{1,20})\)/g)].map((m) => m[1]!.trim()).find((s) => /^[A-Za-z][A-Za-z0-9._-]*$/.test(s) && !/^(S|M|L)$/i.test(s));
  const size = /\bsize[:\s]*([SML])\b/i.exec(afterTitle)?.[1]?.toUpperCase() ?? "";
  const tagged = /\bready\s*:\s*([^.;,\n]+)/i.exec(afterTitle)?.[1];
  const ready = tagged ? readiness(tagged) : READINESS_ANYWHERE.exec(afterTitle) ? readiness(READINESS_ANYWHERE.exec(afterTitle)![0]) : "";
  const why = /\bwhy\s*:\s*(.*?)(?:\s+links\s*:|$)/i.exec(afterTitle)?.[1]?.trim() ?? "";
  return { n, title, milestone: ms ?? "", size, ready, why, raw: raw.trim() };
}

/** A frontmatter date (string or Date) as YYYY-MM-DD, or "". */
function day(v: unknown): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v ?? "").trim());
  return m ? m[0] : "";
}

/** Parse a roadmap note. `stale` is left empty: staleness needs the clock and the repo (roadmapStaleness). */
export function parseRoadmap(text: string, ship: string): Roadmap {
  const fm = frontmatter(text) ?? {};
  const sources = fm.sources && typeof fm.sources === "object" ? (fm.sources as Record<string, unknown>) : {};
  const all = sections(text.replace(/^---\r?\n[\s\S]*?\r?\n---/, ""));
  return {
    ship,
    summary: String(fm.summary ?? "").trim(),
    updated: day(fm.updated),
    updatedBy: String(fm.updated_by ?? ""),
    sourcesRepo: String(sources.repo ?? "").trim(),
    now: section(all, "now"),
    milestones: parseMilestones(section(all, "milestones")),
    nextUp: listItems(section(all, "next up")).map((raw, i) => parseNextItem(raw, i + 1)),
    recentlyDone: listItems(section(all, "recently done")),
    openQuestions: listItems(section(all, "open questions")),
    stale: [],
  };
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(["git", "--no-optional-locks", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** The repo's default branch: origin's HEAD when it has one, else main or master, else HEAD. */
function defaultBranch(repo: string): string {
  const head = git(repo, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out) return head.out;
  for (const b of ["main", "master"]) if (git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]).ok) return b;
  return "HEAD";
}

/** Why a roadmap may be out of date: an old `updated`, or commits on the default branch after `sources.repo`. Empty when current or unchecked. */
export function roadmapStaleness(r: Pick<Roadmap, "updated" | "sourcesRepo">, repo: string | undefined, now = new Date()): string[] {
  const why: string[] = [];
  if (!r.updated) why.push("no updated date");
  else {
    const age = Math.floor((now.getTime() - Date.parse(`${r.updated}T00:00:00Z`)) / DAY_MS);
    if (age > STALE_DAYS) why.push(`updated ${age} days ago (more than ${STALE_DAYS})`);
  }
  // No repo on disk (a hub without the checkout, a moved path): the commit check is skipped, not failed.
  if (!repo || !existsSync(repo) || !git(repo, ["rev-parse", "--git-dir"]).ok) return why;
  if (!/^[0-9a-f]{7,40}$/i.test(r.sourcesRepo)) {
    why.push("sources.repo is not a commit sha, so new commits cannot be checked");
    return why;
  }
  if (!git(repo, ["cat-file", "-e", `${r.sourcesRepo}^{commit}`]).ok) {
    why.push(`sources.repo ${r.sourcesRepo.slice(0, 8)} is not in the repo`);
    return why;
  }
  const branch = defaultBranch(repo);
  const n = git(repo, ["rev-list", "--count", `${r.sourcesRepo}..${branch}`]);
  if (n.ok && Number(n.out) > 0) why.push(`${n.out} commit${n.out === "1" ? "" : "s"} on ${branch} since sources.repo ${r.sourcesRepo.slice(0, 8)}`);
  return why;
}

/** One ship's roadmap from the vault, with staleness; `{ship, missing: true}` when it has no note. */
export function readRoadmap(ship: string, repo: string | undefined, opts: { vault?: string; now?: Date } = {}): Roadmap | MissingRoadmap {
  const file = join(opts.vault ?? aliceVault(), "ships", ship, "roadmap.md");
  if (!existsSync(file)) return { ship, missing: true };
  const r = parseRoadmap(readFileSync(file, "utf8"), ship);
  return { ...r, stale: roadmapStaleness(r, repo, opts.now) };
}

/** Roadmaps of every ship in the fleet config (or the one named). */
export async function readRoadmaps(only = "", opts: { vault?: string; now?: Date; ships?: { id: string; path: string }[] } = {}): Promise<(Roadmap | MissingRoadmap)[]> {
  const ships = opts.ships ?? (await readShips());
  return ships.filter((s) => !only || s.id === only).map((s) => readRoadmap(s.id, s.path, opts));
}

const TRIM_NOW = 400;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** `ship_next` as the tool shows it: one ship in detail, or every ship compactly. `full` adds milestones and recently done. */
export function shipNextReport(rows: (Roadmap | MissingRoadmap)[], one: string, full = false): { ok: boolean; message: string; [k: string]: unknown } {
  if (one) {
    const r = rows[0];
    if (!r) return { ok: false, message: `No ship ${one}.` };
    if (r.missing) return { ok: true, message: `${r.ship} has no roadmap (ships/${r.ship}/roadmap.md). Ask the Architect to write it.` };
    const now = oneLine(r.now);
    return {
      ok: true,
      message: `${r.ship}: ${r.summary || "(no summary)"}`,
      updated: r.updated || null,
      ...(r.stale.length ? { stale: r.stale } : {}),
      now: full || now.length <= TRIM_NOW ? r.now : `${now.slice(0, TRIM_NOW - 1)}…`,
      next_up: r.nextUp.map((i) => ({ n: i.n, title: i.title, milestone: i.milestone, size: i.size, ready: i.ready, ...(full ? { why: i.why } : {}) })),
      open_questions: r.openQuestions,
      ...(full ? { milestones: r.milestones, recently_done: r.recentlyDone } : {}),
    };
  }
  const present = rows.filter((r): r is Roadmap => !r.missing);
  const missing = rows.filter((r) => r.missing).map((r) => r.ship);
  return {
    ok: true,
    message: `${present.length} of ${rows.length} ships have a roadmap${present.some((r) => r.stale.length) ? `; stale: ${present.filter((r) => r.stale.length).map((r) => r.ship).join(", ")}` : ""}.`,
    ships: present.map((r) => ({
      ship: r.ship,
      updated: r.updated,
      stale: r.stale.join("; "),
      next: r.nextUp[0] ? `${r.nextUp[0].title}${r.nextUp[0].ready ? ` (${r.nextUp[0].ready})` : ""}` : "",
      questions: r.openQuestions.length,
    })),
    ...(missing.length ? { no_roadmap: missing } : {}),
  };
}

/** The node's and the CLI's entry: all ships, or the named one. */
export async function shipNext(ship = "", full = false, opts: { vault?: string; now?: Date; ships?: { id: string; path: string }[] } = {}) {
  const s = ship === "all" ? "" : ship;
  return shipNextReport(await readRoadmaps(s, opts), s, full);
}
