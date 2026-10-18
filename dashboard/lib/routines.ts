import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { escapeHtml } from "./quota.ts";
import { nodeStateDir, ROOT } from "./paths.ts";

/**
 * Routines (vault task fleet-routines): recurring work the fleet runs on its
 * own, declared in fleet/config/routines.yaml. The node checks every minute.
 * A routine either gives an agent a turn (agent + prompt; the agent reports
 * with notify_captain) or runs a built-in node job (job). Results: the Health
 * > Diagnostics card and the journal; agents' reports land in Needs you or the
 * digest like any notice.
 *
 * Schedules, in local time: "every 30m" / "every 6h" / "every 2d",
 * "daily 08:30", "weekly mon 09:00".
 */

export type Routine = { id: string; title: string; every: string; agent?: string; prompt?: string; job?: string; ship?: string; enabled: boolean };
export type Schedule = { kind: "interval"; ms: number } | { kind: "daily"; h: number; m: number } | { kind: "weekly"; dow: number; h: number; m: number };
type RunState = { lastRun?: string; status?: "ok" | "error" | "sent"; note?: string; next?: string };
export type RoutineDeps = {
  jobs: Record<string, (r: Routine) => Promise<string> | string>;
  runAgent: (agentId: string, text: string) => Promise<void>;
  agentExists: (agentId: string) => boolean;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function routinesPath(): string {
  return process.env.FLEET_ROUTINES_FILE || join(ROOT, "fleet", "config", "routines.yaml");
}
const statePath = () => join(nodeStateDir(), "routines.json");

export function parseSchedule(every: string): Schedule | null {
  const s = every.trim().toLowerCase();
  let m = s.match(/^every\s+(\d+)\s*(m|h|d)$/);
  if (m) {
    const ms = Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    return ms >= 5 * 60_000 ? { kind: "interval", ms } : null;
  }
  m = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return { kind: "daily", h: Number(m[1]), m: Number(m[2]) };
  m = s.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/);
  if (m && Number(m[2]) < 24 && Number(m[3]) < 60) return { kind: "weekly", dow: DAYS.indexOf(m[1]!), h: Number(m[2]), m: Number(m[3]) };
  return null;
}

/** The first run time strictly after `after`. Intervals count from `after` (the last run). */
export function nextRun(s: Schedule, after: Date): Date {
  if (s.kind === "interval") return new Date(after.getTime() + s.ms);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(s.h, s.m);
  if (s.kind === "daily") {
    if (d <= after) d.setDate(d.getDate() + 1);
    return d;
  }
  d.setDate(d.getDate() + ((s.dow - d.getDay() + 7) % 7));
  if (d <= after) d.setDate(d.getDate() + 7);
  return d;
}

/** The declared routines and any problems with the file (bad ones are skipped, not fatal). */
export function loadRoutines(path = routinesPath()): { routines: Routine[]; problems: string[] } {
  if (!existsSync(path)) return { routines: [], problems: [`${path} not found`] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { routines: [], problems: [`routines.yaml does not parse: ${String(e).slice(0, 200)}`] };
  }
  const list = (raw as { routines?: unknown })?.routines;
  if (!Array.isArray(list)) return { routines: [], problems: ["routines.yaml needs a `routines:` list"] };
  const routines: Routine[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of list as Record<string, unknown>[]) {
    const id = String(item?.id ?? "");
    const str = (k: string) => (typeof item[k] === "string" ? (item[k] as string).trim() : undefined);
    const r: Routine = { id, title: str("title") ?? id, every: str("every") ?? "", agent: str("agent"), prompt: str("prompt"), job: str("job"), ship: str("ship"), enabled: item.enabled !== false };
    const bad = !/^[a-z][a-z0-9-]{1,60}$/.test(id) ? "needs an id (lowercase, dashes)" : seen.has(id) ? "repeats an id" : !parseSchedule(r.every) ? `has a schedule the node does not read: "${r.every}"` : !!r.agent === !!r.job ? "needs exactly one of agent or job" : r.agent && !r.prompt ? "gives an agent no prompt" : null;
    if (bad) problems.push(`${id || "(no id)"} ${bad}`);
    else {
      seen.add(id);
      routines.push(r);
    }
  }
  return { routines, problems };
}

function readState(): Record<string, RunState> {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, RunState>;
  } catch {
    return {};
  }
}
function writeState(s: Record<string, RunState>): void {
  try {
    writeFileSync(statePath(), JSON.stringify(s, null, 1), "utf8");
  } catch {
    /* state dir missing: next tick */
  }
}

/** What an agent receives: the prompt, framed so its report comes back as a notice. */
export function agentText(r: Routine, now: Date): string {
  return `Routine "${r.title}" (${r.every}, ${now.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}).\n\n${r.prompt}\n\nWhen it is done, report with notify_captain: kind "info" when nothing needs the captain, "decision" or "blocked" when something does. Keep it short; put detail in the notice's detail.`;
}

const running = new Set<string>();

/**
 * Run whatever is due. A routine with no state yet is scheduled from now
 * (intervals run soon after the node starts, as the old timers did); one that
 * was due while the node was down runs once, then continues on schedule.
 */
export async function tickRoutines(now: Date, deps: RoutineDeps, path = routinesPath()): Promise<string[]> {
  const { routines } = loadRoutines(path);
  const state = readState();
  const ran: string[] = [];
  for (const r of routines) {
    if (!r.enabled || running.has(r.id)) continue;
    const sched = parseSchedule(r.every)!;
    const st = (state[r.id] ??= {});
    if (!st.next) st.next = (sched.kind === "interval" && !st.lastRun ? new Date(now.getTime() + 3 * 60_000) : nextRun(sched, st.lastRun ? new Date(st.lastRun) : now)).toISOString();
    if (now < new Date(st.next)) continue;
    running.add(r.id);
    st.lastRun = now.toISOString();
    st.next = nextRun(sched, now).toISOString();
    try {
      if (r.job) {
        const job = deps.jobs[r.job];
        if (!job) throw new Error(`no node job named ${r.job}`);
        st.note = String((await job(r)) || "done").slice(0, 300);
        st.status = "ok";
      } else {
        if (!deps.agentExists(r.agent!)) throw new Error(`no agent named ${r.agent}`);
        await deps.runAgent(r.agent!, agentText(r, now));
        st.note = `sent to ${r.agent}; the report comes back as a notice`;
        st.status = "sent";
      }
    } catch (e) {
      st.status = "error";
      st.note = String((e as Error)?.message ?? e).slice(0, 300);
    } finally {
      running.delete(r.id);
    }
    ran.push(r.id);
  }
  writeState(state);
  return ran;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRoutines(deps: RoutineDeps, log: (msg: string) => void = console.error): void {
  if (timer) return;
  const { problems } = loadRoutines();
  for (const p of problems) log(`[node] routines: ${p}`);
  const tick = () =>
    void tickRoutines(new Date(), deps)
      .then((ran) => ran.length && log(`[node] routines ran: ${ran.join(", ")}`))
      .catch((e) => log(`[node] routines: ${String(e)}`));
  setTimeout(tick, 30_000);
  timer = setInterval(tick, 60_000);
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

/** Health > Diagnostics: every routine, its schedule, last run, result, and next run. */
export function routinesHtml(): string {
  const { routines, problems } = loadRoutines();
  const state = readState();
  const rows = routines
    .map((r) => {
      const st = state[r.id] ?? {};
      const result = st.status === "error" ? `<span class="warn">${escapeHtml(st.note ?? "failed")}</span>` : escapeHtml(st.note ?? "not run yet");
      return `<tr><td>${escapeHtml(r.title)}${r.enabled ? "" : ' <span class="d-badge d-badge-sm d-badge-outline">off</span>'}</td><td>${escapeHtml(r.every)}</td><td>${escapeHtml(r.agent ?? `node: ${r.job}${r.ship ? ` (${r.ship})` : ""}`)}</td><td>${when(st.lastRun)}</td><td>${result}</td><td>${r.enabled ? when(st.next) : "—"}</td></tr>`;
    })
    .join("");
  const errors = routines.filter((r) => state[r.id]?.status === "error").length;
  const summary = `Routines · ${routines.filter((r) => r.enabled).length} on${errors ? `, ${errors} failed last run` : ""}${problems.length ? `, ${problems.length} problem${problems.length > 1 ? "s" : ""} in the file` : ""}`;
  return `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"${errors || problems.length ? " open" : ""}><summary class="d-collapse-title">${summary}</summary><div class="d-collapse-content">
    ${problems.length ? `<p class="warn">${problems.map(escapeHtml).join("<br>")}</p>` : ""}
    <div class="table-wrap"><table class="d-table d-table-zebra d-table-sm spend-table"><thead><tr><th>Routine</th><th>Schedule</th><th>Runs on</th><th>Last run</th><th>Result</th><th>Next</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">Declared in fleet/config/routines.yaml; the node checks every minute. Agent routines report back as notices.</p>
  </div></details>`;
}
