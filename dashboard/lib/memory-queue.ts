import { acceptCrewLine } from "./chat-bridge.ts";
import { journalDb } from "./journal.ts";
import { LABELS, type ProposalRow } from "./memory-extract.ts";

/**
 * The captain's queue of memory proposals (vault plan alice-memory-and-tools,
 * M4): the proposals from lib/memory-extract.ts worth asking about, shown in
 * Needs you. Approving or dismissing there is the captain's label. Nothing is
 * written by the node: on approval Alice gets a line from the system sender
 * `memory` and phrases the memory through remember / fact_set herself, so
 * generation is spent only on approved items.
 *
 * "Queued" is computed at read time, not stored: a proposal is queued while its
 * status is still `observed` and it passes the filters below, so changing the
 * floor or the window needs no migration or backfill. The stored statuses are
 * observed, approved, dismissed.
 *
 * FLEET_MEMORY_QUEUE_FLOOR (default 0.8) is the confidence a proposal needs;
 * FLEET_MEMORY_QUEUE_DAYS (default 7) how recent its message must be, so the
 * old backfill does not flood the queue (those stay labelable from the CLI).
 */

export const QUEUE_LABELS = ["preference", "fact", "decision", "correction"] as const;

export const queueFloor = (): number => {
  const n = Number(process.env.FLEET_MEMORY_QUEUE_FLOOR);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.8;
};
export const queueDays = (): number => {
  const n = Number(process.env.FLEET_MEMORY_QUEUE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 7;
};

/** Proposals waiting on the captain, newest message first. */
export function queuedProposals(): ProposalRow[] {
  const since = new Date(Date.now() - queueDays() * 86_400_000).toISOString();
  return journalDb()
    .query(`SELECT * FROM memory_proposals WHERE status = 'observed' AND label IN (${QUEUE_LABELS.map(() => "?").join(",")}) AND confidence >= ? AND line_ts >= ? ORDER BY line_ts DESC`)
    .all(...QUEUE_LABELS, queueFloor(), since) as ProposalRow[];
}

/** "captain.md › Section" or "fact subject.key", for a person; null when the proposal has no target. */
export function targetText(p: Pick<ProposalRow, "target">): string | null {
  if (!p.target) return null;
  if (p.target.startsWith("captain.md#")) return `captain.md › ${p.target.slice("captain.md#".length)}`;
  if (p.target.startsWith("fact:")) return `fact ${p.target.slice(5)}`;
  return p.target;
}

/** What the proposal would replace, as text: the bullet, or the fact. */
export function replacesText(p: Pick<ProposalRow, "label" | "target" | "replaces">): string | null {
  if (!p.replaces) return null;
  return p.label === "fact" ? (p.target?.startsWith("fact:") ? p.target.slice(5) : `fact #${p.replaces}`) : p.replaces;
}

/** The line Alice gets on approval: the quote verbatim, where it goes, and how to write it for this label. */
export function approvalLine(p: ProposalRow, label: string): string {
  const where = targetText(p);
  const replaces = replacesText(p);
  const date = p.line_ts.slice(0, 10);
  const head = `The captain approved this memory proposal (from ${p.agent} chat, ${date}; Jev read it as ${label}, ${Math.round(p.confidence * 100)}% sure). Their words:\n\n"${p.quote}"\n\n`;
  // Jev's label can be wrong (a speech-to-text slip read as a correction): Alice may decline rather than invent a rule.
  const tail = "If nothing lasting follows from it, write nothing and say so. Reply in one line with what you wrote.";
  if (label === "fact") {
    return `${head}Write it with fact_set, with source "captain in ${p.agent} chat ${date}".${where ? ` Proposed: ${where}.` : ""}${replaces ? ` It would change the current value of ${replaces}; fact_get it first.` : ""} ${tail}`;
  }
  if (label === "decision") {
    return `${head}This is a decision. Choose where it belongs: a fact (fact_set), a line in the captain profile (remember), or a note in the relevant vault plan (vault_patch or remember). ${tail}`;
  }
  const section = where ? ` Proposed: ${where}.` : " Pick the right section.";
  const rep = replaces ? ` Replace this bullet (replaces): "${replaces}".` : "";
  const what = label === "correction" ? "This corrects an agent: write the standing rule it implies, one line." : "Write it as one standing line.";
  return `${head}Write it with remember in the captain profile. ${what}${section}${rep} ${tail}`;
}

type Send = (to: string, from: string, text: string) => Promise<unknown>;
export type QueueResult = { ok: boolean; message: string; already?: boolean };

function find(id: number): ProposalRow | null {
  return (journalDb().query("SELECT * FROM memory_proposals WHERE id = ?").get(id) as ProposalRow | null) ?? null;
}

/**
 * Remember: mark approved with the captain's label (the proposed one unless
 * relabelled), then hand it to Alice. Idempotent: only the call that changes
 * the status posts the line. If the post fails the status goes back, so the
 * item stays in the queue.
 */
export async function approveProposal(id: number, opts: { label?: string } = {}, send: Send = acceptCrewLine): Promise<QueueResult> {
  const p = find(id);
  if (!p) return { ok: false, message: `no proposal with id ${id}` };
  if (p.status !== "observed") return { ok: p.status === "approved", already: true, message: `proposal ${id} is already ${p.status}` };
  const label = opts.label ?? p.label;
  if (!(QUEUE_LABELS as readonly string[]).includes(label)) return { ok: false, message: `${label} is not one to remember; options: ${QUEUE_LABELS.join(", ")}` };
  const r = journalDb().query("UPDATE memory_proposals SET status = 'approved', captain_label = ?, labelled_at = ? WHERE id = ? AND status = 'observed'").run(label, new Date().toISOString(), id);
  if (!r.changes) return { ok: true, already: true, message: `proposal ${id} is already approved` };
  try {
    await send("alice", "memory", approvalLine(p, label));
  } catch (e) {
    journalDb().query("UPDATE memory_proposals SET status = 'observed', captain_label = NULL, labelled_at = NULL WHERE id = ?").run(id);
    return { ok: false, message: `could not reach Alice: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, message: `proposal ${id} approved; Alice will write it` };
}

/** Not this: mark dismissed; the captain's label is the relabel, or none. Idempotent. */
export function dismissProposal(id: number, opts: { label?: string } = {}): QueueResult {
  const p = find(id);
  if (!p) return { ok: false, message: `no proposal with id ${id}` };
  if (p.status !== "observed") return { ok: p.status === "dismissed", already: true, message: `proposal ${id} is already ${p.status}` };
  const label = opts.label ?? "none";
  if (!(LABELS as readonly string[]).includes(label)) return { ok: false, message: `${label} is not a label; options: ${LABELS.join(", ")}` };
  const r = journalDb().query("UPDATE memory_proposals SET status = 'dismissed', captain_label = ?, labelled_at = ? WHERE id = ? AND status = 'observed'").run(label, new Date().toISOString(), id);
  return { ok: true, already: r.changes === 0, message: `proposal ${id} dismissed` };
}
