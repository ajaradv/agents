import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalDb } from "./journal.ts";
import { aliceVault } from "./paths.ts";
import { acceptCrewLine } from "./chat-bridge.ts";
import { readVaultTasks, vaultNextSteps } from "./vault-tasks.ts";

/**
 * The proactive sweep (vault plan alice-memory-and-tools, M5): Alice raises due,
 * closeable and stale things without being asked, as proposals. The node looks
 * (findings), remembers what it already raised (proactive_raised in journal.db),
 * and gives Alice one turn from the system sender `proactive`; she checks each
 * item with her tools and reports her proposals with proactive_report, which
 * shows one Needs-you card per item (Go, Snooze 7d, Done). She changes nothing
 * on her own: the captain's Go is still the gate, and every answer is stored
 * (proactive_items) so the go rate per kind says whether this work is wanted.
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
const STALE_FACT_DAYS = 60;
const EXPIRING_DAYS = 2;
export const MAX_IN_LINE = 8;

export function proactiveMode(): Mode {
  const v = (process.env.FLEET_PROACTIVE ?? "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : "observe";
}
/** Days a task's note may sit unchanged before it is stale (FLEET_PROACTIVE_STALE_DAYS, default 21). */
export const staleTaskDays = (): number => {
  const n = Number(process.env.FLEET_PROACTIVE_STALE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 21;
};
export const repeatDays = (): number => {
  const n = Number(process.env.FLEET_PROACTIVE_REPEAT_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

export type SweepInput = {
  now: Date;
  tasks: { id: string; title: string; status: string; due: string; modified: Date | null }[];
  /** vaultNextSteps rows: id, closeable, progress ("3/3"), and what the task waits on. */
  steps: { id: string; closeable?: boolean; progress: string; waitingOn?: string[] }[];
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
    // A task waiting on an open blocker is not stale, it is parked.
    const waiting = i.steps.some((s) => s.id === t.id && s.waitingOn?.length);
    if (t.status === "in-progress" && !waiting && t.modified && i.now.getTime() - t.modified.getTime() > staleTaskDays() * DAY_MS) {
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

/** The short id Alice sees for the n-th item of a sweep line (p1, p2, ...). */
export const shortId = (n: number): string => `p${n + 1}`;

/** Record that these were raised now, and keep each as an item she will propose for under its short id. */
export function markRaised(findings: Finding[], now: Date): void {
  const t = now.toISOString();
  const item = journalDb().query("INSERT INTO proactive_items (fingerprint, kind, key, summary, short_id, raised_at) VALUES (?, ?, ?, ?, ?, ?)");
  findings.forEach((f, n) => item.run(f.fingerprint, f.kind, f.key, f.summary, shortId(n), t));
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
  const items = shown.map((f, n) => `${shortId(n)}. [${f.kind}] ${f.summary}`).join("\n");
  return `The node's sweep found ${shown.length} thing${shown.length === 1 ? "" : "s"} the captain has not been told about:\n${items}\n\nCheck each one with your tools (vault_tasks, vault_note, fact_get) before you say anything. Then call proactive_report ONCE: items [{id, proposal}] with one sentence per item on what you propose (close the task, chase it, confirm or retire the fact, promote the observation or let it go), and dropped [{id, why}] for any that turns out wrong. Use the ids above (p1, p2, ...). If proactive_report fails, send ONE notify_captain (kind "decision") with the proposals instead. Change nothing yourself; the captain's Go decides.`;
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

export type ItemRow = { id: number; fingerprint: string; kind: string; key: string; summary: string; short_id: string; raised_at: string; proposal: string | null; proposed_at: string | null; dropped_why: string | null; answer: string | null; answered_at: string | null };
export type ReportResult = { ok: boolean; message: string };

const asFinding = (r: ItemRow): Finding => ({ kind: r.kind as FindingKind, key: r.key, summary: r.summary, fingerprint: r.fingerprint, rank: 0 });

/**
 * Alice's proactive_report: a proposal per item of the latest sweep line (by short
 * id), and the ones she checked and found wrong. A dropped item is marked done for
 * its fingerprint, so it is not raised again until the value changes. A proposal can
 * be corrected until the captain answers it.
 */
export function proactiveReport(items: { id?: unknown; proposal?: unknown }[], dropped: { id?: unknown; why?: unknown }[] = [], now = new Date()): ReportResult {
  const d = journalDb();
  const batch = (d.query("SELECT MAX(raised_at) AS t FROM proactive_items").get() as { t: string | null }).t;
  const find = (id: unknown) => (batch ? (d.query("SELECT * FROM proactive_items WHERE raised_at = ? AND short_id = ?").get(batch, String(id ?? "").trim().toLowerCase()) as ItemRow | null) : null);
  const t = now.toISOString();
  const problems: string[] = [];
  let proposed = 0;
  let drops = 0;
  for (const x of items) {
    const row = find(x.id);
    const proposal = String(x.proposal ?? "").trim().slice(0, 400);
    if (!row) problems.push(`${String(x.id)}: not in the latest sweep line`);
    else if (!proposal) problems.push(`${row.short_id}: give a proposal`);
    else if (row.answer || row.dropped_why) problems.push(`${row.short_id}: already ${row.answer ? "answered" : "dropped"}`);
    else {
      d.query("UPDATE proactive_items SET proposal = ?, proposed_at = ? WHERE id = ?").run(proposal, t, row.id);
      proposed++;
    }
  }
  for (const x of dropped) {
    const row = find(x.id);
    const why = String(x.why ?? "").trim().slice(0, 300);
    if (!row) problems.push(`${String(x.id)}: not in the latest sweep line`);
    else if (!why) problems.push(`${row.short_id}: say why it is dropped`);
    else if (row.answer) problems.push(`${row.short_id}: already answered`);
    else {
      d.query("UPDATE proactive_items SET dropped_why = ?, proposal = NULL, proposed_at = NULL WHERE id = ?").run(why, row.id);
      giveFeedback(row.fingerprint, "done", now, [asFinding(row)]);
      drops++;
    }
  }
  const head = `${proposed} proposal${proposed === 1 ? "" : "s"} shown to the captain, ${drops} dropped`;
  if (!proposed && !drops) return { ok: false, message: `Nothing recorded${problems.length ? `: ${problems.join("; ")}` : ""}.` };
  return { ok: true, message: `${head}.${problems.length ? ` Not recorded: ${problems.join("; ")}.` : ""} Do not repeat it in chat.` };
}

/** Proposals waiting on the captain, oldest first. */
export function openProposals(): ItemRow[] {
  return journalDb().query("SELECT * FROM proactive_items WHERE proposal IS NOT NULL AND dropped_why IS NULL AND answer IS NULL ORDER BY proposed_at, id").all() as ItemRow[];
}

export const SNOOZE_DAYS = 7;
export type ProactiveAction = "go" | "snooze" | "done";
export type AnswerResult = { ok: boolean; message: string; already?: boolean };

/** The line Alice gets when the captain says Go. */
export function goLine(r: Pick<ItemRow, "summary" | "proposal">): string {
  return `The captain said Go to your proposal for ${r.summary}: ${r.proposal}. Do it now with your tools (Go-gated actions still ask), and reply in one line.`;
}

/**
 * The captain's answer to a proposal. Idempotent: only the call that sets the answer
 * acts. Go hands the proposal back to Alice (and clears the answer if she cannot be
 * reached, so the card stays); Snooze and Done hold or end the finding like the CLI.
 */
export async function answerProposal(id: number, action: ProactiveAction, send: Send = acceptCrewLine, now = new Date()): Promise<AnswerResult> {
  const d = journalDb();
  const row = d.query("SELECT * FROM proactive_items WHERE id = ?").get(id) as ItemRow | null;
  if (!row) return { ok: false, message: `no proposal with id ${id}` };
  if (!row.proposal || row.dropped_why) return { ok: false, message: `proposal ${id} is not waiting on the captain` };
  if (row.answer) return { ok: row.answer === action, already: true, message: `proposal ${id} is already answered (${row.answer})` };
  const r = d.query("UPDATE proactive_items SET answer = ?, answered_at = ? WHERE id = ? AND answer IS NULL").run(action, now.toISOString(), id);
  if (!r.changes) return { ok: true, already: true, message: `proposal ${id} is already answered` };
  if (action === "go") {
    try {
      await send("alice", "proactive", goLine(row));
    } catch (e) {
      d.query("UPDATE proactive_items SET answer = NULL, answered_at = NULL WHERE id = ?").run(id);
      return { ok: false, message: `could not reach Alice: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, message: "Alice has it" };
  }
  giveFeedback(row.fingerprint, action === "done" ? "done" : { snooze: SNOOZE_DAYS }, now, [asFinding(row)]);
  return { ok: true, message: action === "done" ? "marked done" : `snoozed ${SNOOZE_DAYS} days` };
}

/** What came of the proposals: counts, and the go rate (go of the answered ones) overall and per kind. */
export function proposalReport(days = 30, now = new Date()): { reported: number; open: number; go: number; snoozed: number; done: number; dropped: number; goRate: number | null; perKind: { kind: string; reported: number; go: number; snoozed: number; done: number; dropped: number; goRate: number | null }[] } {
  const rows = journalDb().query("SELECT * FROM proactive_items WHERE raised_at >= ?").all(new Date(now.getTime() - days * DAY_MS).toISOString()) as ItemRow[];
  const count = (rs: ItemRow[]) => {
    const go = rs.filter((r) => r.answer === "go").length;
    const snoozed = rs.filter((r) => r.answer === "snooze").length;
    const done = rs.filter((r) => r.answer === "done").length;
    const answered = go + snoozed + done;
    return { reported: rs.filter((r) => r.proposal).length, open: rs.filter((r) => r.proposal && !r.answer && !r.dropped_why).length, go, snoozed, done, dropped: rs.filter((r) => r.dropped_why).length, goRate: answered ? Math.round((go / answered) * 100) / 100 : null };
  };
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  return { ...count(rows), perKind: kinds.map((kind) => ({ kind, ...(({ open: _o, ...c }) => c)(count(rows.filter((r) => r.kind === kind))) })) };
}
