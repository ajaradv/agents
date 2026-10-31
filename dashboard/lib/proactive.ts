import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalDb } from "./journal.ts";
import { aliceVault } from "./paths.ts";
import { readVaultTasks, vaultNextSteps } from "./vault-tasks.ts";

/**
 * The proactive sweep (vault plan alice-memory-and-tools, M5): Alice raises due,
 * closeable and stale things without being asked, as proposals. The node looks
 * (findings), remembers what it already raised (proactive_raised in journal.db),
 * and gives Alice one turn from the system sender `proactive`; she checks each
 * item with her tools and raises ONE notify_captain. She changes nothing on her
 * own: the captain's Go is still the gate.
 *
 * FLEET_PROACTIVE: `observe` (default) computes and logs the findings, no Alice
 * turn; `on` also gives Alice the turn; `off` does nothing. FLEET_PROACTIVE_REPEAT_DAYS
 * (default 7) is how long before a finding that is still true is raised again.
 *
 * A fingerprint is kind + key + the value that would change it (the due date,
 * the checked count, the note's last change, the fact's `since`, the observation's
 * expiry), so a finding is raised once until the thing itself moves.
 *
 * Why the due-tasks routine stays: it sends the captain a notice the day a task
 * comes due without waiting on an Alice turn. The sweep's `due` finding looks 2
 * days ahead and goes into Alice's one proposal; it does not replace that notice.
 */

export type FindingKind = "due" | "closeable" | "expiring-observation" | "stale-task" | "stale-fact";
export type Finding = { kind: FindingKind; key: string; summary: string; fingerprint: string; /** Lower is more urgent. */ rank: number };
export type Mode = "on" | "observe" | "off";
export type Send = (to: string, from: string, text: string) => Promise<unknown>;

const DAY_MS = 86_400_000;
const DUE_DAYS = 2;
const STALE_TASK_DAYS = 14;
const STALE_FACT_DAYS = 60;
const EXPIRING_DAYS = 2;
export const MAX_IN_LINE = 8;

export function proactiveMode(): Mode {
  const v = (process.env.FLEET_PROACTIVE ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "observe";
}
export const repeatDays = (): number => {
  const n = Number(process.env.FLEET_PROACTIVE_REPEAT_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

export type SweepInput = {
  now: Date;
  tasks: { id: string; title: string; status: string; due: string; modified: Date | null }[];
  /** vaultNextSteps rows: id, closeable, progress ("3/3"). */
  steps: { id: string; closeable?: boolean; progress: string }[];
  facts: { subject: string; key: string; since: string }[];
  observations: { id: number; text: string; expires: string }[];
};

const day = (d: Date) => d.toLocaleDateString("en-CA");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The findings for this moment, most urgent first. Pure: everything it reads comes in through `i`. */
export function computeFindings(i: SweepInput): Finding[] {
  const out: Finding[] = [];
  const today = day(i.now);
  const horizon = day(new Date(i.now.getTime() + DUE_DAYS * DAY_MS));
  const f = (kind: FindingKind, key: string, value: string, summary: string, rank: number) => out.push({ kind, key, summary, fingerprint: `${kind}:${key}:${value}`, rank });
  for (const t of i.tasks) {
    if ((t.status === "open" || t.status === "in-progress") && t.due && t.due <= horizon) {
      const when = t.due < today ? `overdue since ${t.due}` : t.due === today ? "due today" : `due ${t.due}`;
      // Overdue first, then what is due soon.
      f("due", t.id, t.due, `${t.id} is ${when}`, t.due < today ? 0 : 1);
    }
    if (t.status === "in-progress" && t.modified && i.now.getTime() - t.modified.getTime() > STALE_TASK_DAYS * DAY_MS) {
      const days = Math.floor((i.now.getTime() - t.modified.getTime()) / DAY_MS);
      f("stale-task", t.id, day(t.modified), `${t.id} is in progress but its note has not changed in ${days} days`, 5);
    }
  }
  for (const s of i.steps) if (s.closeable) f("closeable", s.id, s.progress, `${s.id} has every Done-when item checked (${s.progress})`, 2);
  for (const o of i.observations) {
    const left = new Date(o.expires).getTime() - i.now.getTime();
    if (left > 0 && left <= EXPIRING_DAYS * DAY_MS) f("expiring-observation", String(o.id), o.expires.slice(0, 10), `observation ${o.id} expires ${o.expires.slice(0, 10)}: "${cut(o.text, 80)}"`, 3);
  }
  for (const x of i.facts) {
    const age = i.now.getTime() - new Date(x.since).getTime();
    if (age > STALE_FACT_DAYS * DAY_MS) f("stale-fact", `${x.subject}.${x.key}`, x.since.slice(0, 10), `fact ${x.subject}.${x.key} was set ${Math.floor(age / DAY_MS)} days ago`, 6);
  }
  // Within a rank the order is only stable (by fingerprint).
  return out.sort((a, b) => a.rank - b.rank || a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * When a note last changed. Frontmatter `updated:` and the file's mtime, whichever
 * is later: on the hub vault-sync's git pull rewrites only the notes that changed
 * (so mtime is the pull time, never earlier than the real edit), and a fresh clone
 * makes every note look new, which hides a stale task but never invents one.
 */
function noteModified(vault: string, id: string): Date | null {
  const path = join(vault, "tasks", `${id}.md`);
  const times: number[] = [];
  try {
    times.push(statSync(path).mtimeMs);
    const m = /^updated:\s*["']?([0-9T:.\-Z+ ]+?)["']?\s*$/m.exec(/^---\n([\s\S]*?)\n---/.exec(readFileSync(path, "utf8"))?.[1] ?? "");
    const u = m ? Date.parse(m[1]!) : NaN;
    if (!Number.isNaN(u)) times.push(u);
  } catch {
    /* vanished: no age */
  }
  return times.length ? new Date(Math.max(...times)) : null;
}

/** Read the vault and journal.db into a sweep input. */
export function gatherInput(now = new Date(), vault = aliceVault()): SweepInput {
  const d = journalDb();
  return {
    now,
    tasks: readVaultTasks(vault).tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, due: t.due, modified: noteModified(vault, t.id) })),
    steps: vaultNextSteps(vault).tasks as SweepInput["steps"],
    facts: d.query("SELECT subject, key, since FROM facts WHERE superseded_by IS NULL AND retired = 0").all() as SweepInput["facts"],
    observations: d.query("SELECT id, text, expires FROM observations WHERE promoted_to IS NULL AND expires > ?").all(now.toISOString()) as SweepInput["observations"],
  };
}

type RaisedRow = { fingerprint: string; kind: string; key: string; first_raised: string; last_raised: string; times: number; status: string; snoozed_until: string | null };
export type Verdict = { finding: Finding; raise: boolean; why: string };

/** Whether each finding would be raised now, and why or why not. */
export function judge(findings: Finding[], now: Date): Verdict[] {
  const d = journalDb();
  return findings.map((finding) => {
    const row = d.query("SELECT * FROM proactive_raised WHERE fingerprint = ?").get(finding.fingerprint) as RaisedRow | null;
    if (!row) return { finding, raise: true, why: "new" };
    if (row.status === "done") return { finding, raise: false, why: "marked done" };
    if (row.snoozed_until && row.snoozed_until > now.toISOString()) return { finding, raise: false, why: `snoozed until ${row.snoozed_until.slice(0, 10)}` };
    if (row.snoozed_until) return { finding, raise: true, why: "snooze ended" };
    const ageDays = (now.getTime() - new Date(row.last_raised).getTime()) / DAY_MS;
    return ageDays >= repeatDays() ? { finding, raise: true, why: `raised ${Math.floor(ageDays)} days ago and still true` } : { finding, raise: false, why: `raised ${Math.max(0, Math.floor(ageDays))} days ago (repeats after ${repeatDays()})` };
  });
}

/** Record that these were raised now. */
export function markRaised(findings: Finding[], now: Date): void {
  const t = now.toISOString();
  const q = journalDb().query(
    `INSERT INTO proactive_raised (fingerprint, kind, key, first_raised, last_raised, times, status) VALUES (?, ?, ?, ?, ?, 1, 'raised')
     ON CONFLICT(fingerprint) DO UPDATE SET last_raised = excluded.last_raised, times = times + 1, status = 'raised', snoozed_until = NULL`,
  );
  for (const f of findings) q.run(f.fingerprint, f.kind, f.key, t, t);
}

/** The captain's feedback: hold findings (by fingerprint, or every current finding for a key) for `days`, or mark them done. Returns how many. */
export function giveFeedback(what: string, action: { snooze: number } | "done", now = new Date(), findings: Finding[] = computeFindings(gatherInput(now))): number {
  const hit = findings.filter((f) => f.fingerprint === what || f.key === what);
  const t = now.toISOString();
  const q = journalDb().query(
    `INSERT INTO proactive_raised (fingerprint, kind, key, first_raised, last_raised, times, status, snoozed_until) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET status = excluded.status, snoozed_until = excluded.snoozed_until`,
  );
  for (const f of hit) q.run(f.fingerprint, f.kind, f.key, t, t, action === "done" ? "done" : "snoozed", action === "done" ? null : new Date(now.getTime() + action.snooze * DAY_MS).toISOString());
  return hit.length;
}

/** The one line Alice gets: the items, most urgent first, and how to handle them. */
export function aliceLine(raise: Finding[]): string {
  const shown = raise.slice(0, MAX_IN_LINE);
  const items = shown.map((f, n) => `${n + 1}. [${f.kind}] ${f.summary}`).join("\n");
  return `The node's sweep found ${shown.length} thing${shown.length === 1 ? "" : "s"} the captain has not been told about:\n${items}\n\nCheck each one with your tools (vault_tasks, vault_note, fact_get) before you say anything. Drop any that turns out wrong. Then send ONE notify_captain (kind "decision") that proposes what to do for each: close the task, chase it, confirm or retire the fact, promote the observation or let it go. Change nothing yourself; the captain's Go decides.`;
}

/** One sweep: the routine job. `send` gives Alice her turn (the node passes acceptCrewLine). */
export async function runSweep(send: Send, now = new Date(), mode: Mode = proactiveMode()): Promise<string> {
  if (mode === "off") return "skipped: FLEET_PROACTIVE=off";
  const verdicts = judge(computeFindings(gatherInput(now)), now);
  const raise = verdicts.filter((v) => v.raise).map((v) => v.finding);
  const total = `${verdicts.length} finding${verdicts.length === 1 ? "" : "s"}`;
  if (mode === "observe") return `observe: ${total}, ${raise.length} would be raised${raise.length ? `: ${raise.slice(0, MAX_IN_LINE).map((f) => `${f.kind} ${f.key}`).join(", ")}` : ""}`;
  if (!raise.length) return `${total}, nothing new`;
  const sent = raise.slice(0, MAX_IN_LINE);
  await send("alice", "proactive", aliceLine(sent));
  markRaised(sent, now);
  return `${total}, ${sent.length} sent to alice${raise.length > sent.length ? ` (${raise.length - sent.length} more tomorrow)` : ""}`;
}
