import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { aliceVault } from "./paths.ts";

/**
 * The captain's vault tasks (`{vault}/tasks/*.md`, one note each, frontmatter
 * `type: Task`) as officers see them: what is ready to work on, what waits on
 * what, and what is in progress. Vault research note axi-evaluation, decision 4.
 *
 * A task waits on others with `blocked_by:` in its frontmatter: a list of
 * wikilinks or note names (`[[fleet-ui-daisyui-echarts]]`). It is ready when
 * its status is open and every task it names is done (a name with no note
 * counts as not done). Notes stay as they are
 * for Obsidian; this only reads them, and it names any note whose frontmatter
 * does not parse instead of skipping it silently.
 */

export type VaultTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  plan: string;
  blockedBy: string[];
  timestamp: string;
  description: string;
  /** YYYY-MM-DD, or "" when none. */
  due: string;
};

export type VaultTaskView = {
  tasks: VaultTask[];
  /** Notes in tasks/ whose frontmatter is not valid YAML. */
  unreadable: string[];
};

const PRIORITY: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** `[[name]]`, `[[name|label]]`, `name.md`, or `name` -> name. */
export function linkName(v: unknown): string {
  return String(v ?? "")
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]!
    .replace(/\.md$/, "")
    .split("/")
    .pop()!
    .trim();
}

function list(v: unknown): string[] {
  // An unquoted [[name]] in YAML is a list inside a list: flatten it.
  if (Array.isArray(v)) return v.flat(3).map(linkName).filter(Boolean);
  if (typeof v === "string" && v.trim()) return v.split(/,\s*/).map(linkName).filter(Boolean);
  return [];
}

/** Read every task note under `{vault}/tasks` (index.md and non-task notes left out). */
export function readVaultTasks(vault = aliceVault()): VaultTaskView {
  const dir = join(vault, "tasks");
  const tasks: VaultTask[] = [];
  const unreadable: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "index.md");
  } catch {
    return { tasks, unreadable };
  }
  for (const name of names) {
    const text = readFileSync(join(dir, name), "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) continue;
    let fm: Record<string, unknown>;
    try {
      const y = yamlParse(m[1]!);
      fm = y && typeof y === "object" ? (y as Record<string, unknown>) : {};
    } catch {
      unreadable.push(`tasks/${name}`);
      continue;
    }
    if (String(fm.type ?? "") !== "Task") continue;
    tasks.push({
      id: name.slice(0, -3),
      title: String(fm.title ?? name.slice(0, -3)),
      status: String(fm.status ?? "open"),
      priority: String(fm.priority ?? "medium"),
      plan: linkName(fm.plan),
      blockedBy: list(fm.blocked_by),
      timestamp: String(fm.timestamp ?? ""),
      description: String(fm.description ?? ""),
      due: /^\d{4}-\d{2}-\d{2}/.test(String(fm.due ?? "")) ? String(fm.due).slice(0, 10) : fm.due instanceof Date ? fm.due.toISOString().slice(0, 10) : "",
    });
  }
  return { tasks, unreadable };
}

/** Tasks `t` still waits on: named tasks not done; a name with no note is reported as missing. */
export function vaultWaits(t: VaultTask, all: VaultTask[]): { waiting: string[]; missing: string[] } {
  const waiting: string[] = [];
  const missing: string[] = [];
  for (const id of t.blockedBy) {
    const b = all.find((x) => x.id === id);
    if (!b) missing.push(id);
    else if (b.status !== "done") waiting.push(id);
  }
  return { waiting, missing };
}

const byPriorityThenAge = (a: VaultTask, b: VaultTask) => (PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1) || a.timestamp.localeCompare(b.timestamp);

export type VaultFilter = "ready" | "open" | "in-progress" | "blocked" | "done" | "all";
export const VAULT_FILTERS: VaultFilter[] = ["ready", "open", "in-progress", "blocked", "done", "all"];

/** The officers' view: counts, the filtered list, and one task's detail when `id` is given. */
export function vaultTasksReport(filter: VaultFilter = "ready", id = "", vault = aliceVault()): { ok: boolean; message: string; [k: string]: unknown } {
  const { tasks, unreadable } = readVaultTasks(vault);
  const waitsOf = (t: VaultTask) => vaultWaits(t, tasks);
  // A name with no note counts as waiting: a typo in blocked_by must not release a task early.
  const stuck = (t: VaultTask) => waitsOf(t).waiting.length + waitsOf(t).missing.length > 0;
  const ready = tasks.filter((t) => t.status === "open" && !stuck(t));
  const waitingOpen = tasks.filter((t) => t.status === "open" && stuck(t));
  const counts = {
    open: tasks.filter((t) => t.status === "open").length,
    ready: ready.length,
    waiting: waitingOpen.length,
    inProgress: tasks.filter((t) => t.status === "in-progress").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    done: tasks.filter((t) => t.status === "done").length,
  };
  const unreadableNote = unreadable.length ? { unreadable } : {};
  if (id) {
    const t = tasks.find((x) => x.id === linkName(id));
    if (!t) return { ok: false, message: `No vault task ${linkName(id)}${unreadable.length ? ` (or its frontmatter does not parse: ${unreadable.join(", ")})` : ""}.` };
    const w = waitsOf(t);
    const blocks = tasks.filter((x) => x.blockedBy.includes(t.id) && x.status !== "done").map((x) => x.id);
    return {
      ok: true,
      message: `${t.title} (${t.status}, ${t.priority})`,
      task: { id: t.id, path: `tasks/${t.id}.md`, description: t.description, plan: t.plan || null, blockedBy: t.blockedBy, waitingOn: w.waiting, missing: w.missing, blocks },
    };
  }
  const pick: Record<VaultFilter, VaultTask[]> = {
    ready,
    open: tasks.filter((t) => t.status === "open"),
    "in-progress": tasks.filter((t) => t.status === "in-progress"),
    blocked: [...waitingOpen, ...tasks.filter((t) => t.status === "blocked")],
    done: tasks.filter((t) => t.status === "done"),
    all: tasks,
  };
  const rows = [...pick[filter]].sort(byPriorityThenAge).map((t) => {
    const w = waitsOf(t);
    return { id: t.id, title: t.title, status: t.status, priority: t.priority, waitingOn: [...w.waiting, ...w.missing.map((m) => `${m} (no such note)`)] };
  });
  return {
    ok: true,
    message: `${counts.open} open (${counts.ready} ready, ${counts.waiting} waiting), ${counts.inProgress} in progress, ${counts.blocked} blocked, ${counts.done} done. Showing ${filter}.`,
    tasks: rows,
    ...unreadableNote,
  };
}

/** Tasks due on or before `today` (YYYY-MM-DD) that are not done: what the node reminds the captain about. */
export function dueTasks(today: string, vault = aliceVault()): VaultTask[] {
  return readVaultTasks(vault).tasks.filter((t) => t.due && t.due <= today && t.status !== "done");
}

const STEP_MAX = 160;

/** One checklist item as a short line: bold markers and wikilinks flattened, cut at STEP_MAX. */
function stepText(s: string): string {
  const t = s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > STEP_MAX ? `${t.slice(0, STEP_MAX - 1).trimEnd()}…` : t;
}

/**
 * The `Done when` checklist of a note body (a heading of level 1 to 3, any case),
 * up to the next heading of the same or higher level: the unchecked items, the
 * count of checked ones, and how many unchecked items sit under other headings
 * (counted, not listed: they are often stale).
 */
export function doneWhen(body: string): { open: string[]; done: number; otherOpen: number } {
  const open: string[] = [];
  let done = 0;
  let otherOpen = 0;
  let level = 0; // heading level of the Done-when section we are in, 0 when outside
  for (const line of body.split("\n")) {
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (h) {
      const n = h[1]!.length;
      if (n <= 3 && /^done when\b/i.test(h[2]!)) level = n;
      else if (level && n <= level) level = 0;
      continue;
    }
    const item = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!item) continue;
    if (!level) {
      if (item[1] === " ") otherOpen++;
    } else if (item[1] === " ") open.push(stepText(item[2]!));
    else done++;
  }
  return { open, done, otherOpen };
}

/** What is left on the active (open or in-progress) tasks, from each note's Done-when checklist. */
export function vaultNextSteps(vault = aliceVault()): { ok: boolean; message: string; tasks: Record<string, unknown>[]; unreadable?: string[] } {
  const { tasks, unreadable } = readVaultTasks(vault);
  const active = tasks.filter((t) => t.status === "open" || t.status === "in-progress").sort(byPriorityThenAge);
  const closeable: string[] = [];
  let steps = 0;
  const rows = active.map((t) => {
    let body = "";
    try {
      body = readFileSync(join(vault, "tasks", `${t.id}.md`), "utf8").replace(/^---\n[\s\S]*?\n---/, "");
    } catch {
      /* note vanished since the read: no steps */
    }
    const d = doneWhen(body);
    const w = vaultWaits(t, tasks);
    const waitingOn = [...w.waiting, ...w.missing.map((m) => `${m} (no such note)`)];
    const sealed = t.status === "in-progress" && d.open.length === 0 && d.done > 0;
    if (sealed) closeable.push(t.id);
    steps += d.open.length;
    return {
      id: t.id,
      status: t.status,
      priority: t.priority,
      ...(t.due ? { due: t.due } : {}),
      ...(waitingOn.length ? { waitingOn } : {}),
      progress: `${d.done}/${d.done + d.open.length}`,
      ...(sealed ? { closeable: true } : {}),
      next: d.open,
      ...(d.otherOpen ? { otherOpen: d.otherOpen } : {}),
    };
  });
  const tail = closeable.length ? `; ${closeable.length} looks closeable (all Done-when items checked): ${closeable.join(", ")}` : "";
  return {
    ok: true,
    message: `${active.length} active tasks, ${steps} open steps${tail}`,
    tasks: rows,
    ...(unreadable.length ? { unreadable } : {}),
  };
}

/** The `vault_tasks` tool's filters: the task lists above, plus `next` (what is left on the active ones). */
export const VAULT_TOOL_FILTERS = [...VAULT_FILTERS, "next"] as const;

const TOOL_STEPS = 3;

/** `next` as the tool shows it: one row per active task, its first open steps on one line, one task with `id`. */
export function vaultNextReport(id = "", vault = aliceVault()): { ok: boolean; message: string; [k: string]: unknown } {
  const r = vaultNextSteps(vault);
  const want = linkName(id);
  const tasks = (want ? r.tasks.filter((t) => t.id === want) : r.tasks) as (Record<string, unknown> & { next: string[] })[];
  if (want && !tasks.length) return { ok: false, message: `No active vault task ${want} (active: ${r.tasks.map((t) => t.id).join(", ") || "none"}).` };
  return {
    ok: true,
    message: want ? `${want}: ${tasks[0]!.progress} done` : r.message,
    tasks: tasks.map((t) => ({ ...t, next: t.next.slice(0, want ? undefined : TOOL_STEPS).map((s, i) => `${i + 1}. ${s}`).join(" | ") + (!want && t.next.length > TOOL_STEPS ? ` | (+${t.next.length - TOOL_STEPS} more)` : "") })),
    ...(r.unreadable ? { unreadable: r.unreadable } : {}),
  };
}
