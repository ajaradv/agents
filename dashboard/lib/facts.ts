import { journalDb } from "./journal.ts";

/**
 * Alice's facts and observations (vault plan alice-memory-and-tools, M2), in
 * journal.db. A fact is an exact value that changes (a host, a model, an
 * owner, a date) under a subject and a key. Setting a new value never deletes
 * the old one: the old row points at its replacement (`superseded_by`), so
 * the chain says what was true when. The current value is the row nobody has
 * superseded. An observation is a passing note that expires (14 days by
 * default); it stops showing when it expires or is promoted to a fact or to
 * the captain's profile. Nothing is deleted.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

export const MAX_VALUE = 500;
export const MAX_SOURCE = 200;
export const MAX_OBSERVATION = 300;
const NAME = /^[a-z0-9_.-]{1,64}$/;
const DEFAULT_TTL_DAYS = 14;
const MAX_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

type FactRow = { id: number; subject: string; key: string; value: string; source: string; since: string; superseded_by: number | null; by: string };
type ObsRow = { id: number; text: string; subject: string | null; by: string; ts: string; expires: string; promoted_to: string | null };

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A subject or key: trimmed, lowercase, [a-z0-9_.-], at most 64 characters; null when it is not one. */
export function normName(s: unknown): string | null {
  const n = String(s ?? "").trim().toLowerCase();
  return NAME.test(n) ? n : null;
}

const badName = (what: string, v: unknown) => `${what} "${cut(String(v ?? ""), 40)}" is not usable: use 1-64 characters from a-z, 0-9, _ . - (for example hub or host).`;

export type FactSetArgs = { subject: unknown; key: unknown; value: unknown; source: unknown; by: string; observation?: number; now?: Date };

/** Set a fact: a new value supersedes the current one; the same value changes nothing. */
export function factSet(a: FactSetArgs): Res {
  const subject = normName(a.subject);
  const key = normName(a.key);
  if (!subject) return { ok: false, message: badName("subject", a.subject) };
  if (!key) return { ok: false, message: badName("key", a.key) };
  const value = flat(String(a.value ?? ""));
  if (!value) return { ok: false, message: "Give the fact a value." };
  if (value.length > MAX_VALUE) return { ok: false, message: `The value is ${value.length} characters; the limit is ${MAX_VALUE}. Shorten it, or keep the detail in a vault note and put its path here.` };
  const source = flat(String(a.source ?? ""));
  if (!source) return { ok: false, message: 'Give a source: where you learned it, e.g. "captain in chat 2026-10-30".' };
  if (source.length > MAX_SOURCE) return { ok: false, message: `The source is ${source.length} characters; the limit is ${MAX_SOURCE}.` };

  const d = journalDb();
  if (a.observation !== undefined && !d.query("SELECT 1 FROM observations WHERE id = ?").get(a.observation)) return { ok: false, message: `No observation ${a.observation}; nothing was written.` };
  const current = d.query("SELECT * FROM facts WHERE subject = ? AND key = ? AND superseded_by IS NULL").get(subject, key) as FactRow | null;
  const name = `${subject}.${key}`;
  let message: string;
  let id: number;
  if (current && current.value === value) {
    id = current.id;
    message = `${name} is already ${cut(value, 80)} (unchanged).`;
  } else {
    const row = d.query("INSERT INTO facts (subject, key, value, source, since, by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").get(subject, key, value, source, (a.now ?? new Date()).toISOString(), a.by) as { id: number };
    id = row.id;
    if (current) d.query("UPDATE facts SET superseded_by = ? WHERE id = ?").run(id, current.id);
    message = current ? `${name}: ${cut(current.value, 80)} → ${cut(value, 80)} (replaced; the old value stays in the history).` : `${name} = ${cut(value, 80)} (new fact).`;
  }
  if (a.observation !== undefined) promoteObservation(a.observation, `fact:${id}`);
  return { ok: true, message: a.observation !== undefined ? `${message} Observation ${a.observation} promoted.` : message, id };
}

const toFact = (r: FactRow) => ({ id: r.id, subject: r.subject, key: r.key, value: r.value, source: r.source, since: r.since.slice(0, 16), by: r.by, ...(r.superseded_by === null ? {} : { superseded_by: r.superseded_by }) });

export type FactGetArgs = { subject?: unknown; key?: unknown; history?: boolean; limit?: number };

/** Current facts, newest first; subject and key are optional filters. `history` with both returns the whole chain. */
export function factGet(a: FactGetArgs = {}): Res {
  const subject = a.subject === undefined || a.subject === "" ? undefined : normName(a.subject);
  const key = a.key === undefined || a.key === "" ? undefined : normName(a.key);
  if (subject === null) return { ok: false, message: badName("subject", a.subject) };
  if (key === null) return { ok: false, message: badName("key", a.key) };
  const limit = Math.min(200, Math.max(1, Math.floor(a.limit ?? 50) || 50));
  const d = journalDb();
  if (a.history) {
    if (!subject || !key) return { ok: false, message: "history needs both subject and key: it is the chain of one fact." };
    const rows = d.query("SELECT * FROM facts WHERE subject = ? AND key = ? ORDER BY id DESC LIMIT ?").all(subject, key, limit) as FactRow[];
    return { ok: true, message: rows.length ? `${subject}.${key}: ${rows.length} value(s), newest first` : `No fact ${subject}.${key}.`, facts: rows.map(toFact) };
  }
  const where = ["superseded_by IS NULL", ...(subject ? ["subject = ?"] : []), ...(key ? ["key = ?"] : [])];
  const args = [...(subject ? [subject] : []), ...(key ? [key] : [])];
  const total = (d.query(`SELECT COUNT(*) AS n FROM facts WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
  const rows = d.query(`SELECT * FROM facts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit) as FactRow[];
  const what = [subject, key].filter(Boolean).join(".");
  return {
    ok: true,
    message: total ? `${total} current fact(s)${what ? ` for ${what}` : ""}${total > rows.length ? `, showing the newest ${rows.length}` : ""}` : `0 facts${what ? ` for ${what}` : ""}`,
    facts: rows.map(toFact),
  };
}

/** The current facts as `subject.key = value` lines for the session prompt, most recently set first, cut to `capBytes`. */
export function factsBrief(capBytes: number): string {
  const rows = journalDb().query("SELECT subject, key, value FROM facts WHERE superseded_by IS NULL ORDER BY id DESC").all() as Pick<FactRow, "subject" | "key" | "value">[];
  const lines = rows.map((r) => `- ${r.subject}.${r.key} = ${cut(r.value, 160)}`);
  const more = (n: number) => `- (${n} more: fact_get)`;
  const out: string[] = [];
  let size = 0;
  for (const [i, l] of lines.entries()) {
    const left = lines.length - i - 1;
    // Leave room for the "N more" line unless this is the last one and fits.
    const reserve = left > 0 ? Buffer.byteLength(more(lines.length)) + 1 : 0;
    if (size + Buffer.byteLength(l) + 1 + reserve > capBytes) {
      out.push(more(lines.length - i));
      break;
    }
    out.push(l);
    size += Buffer.byteLength(l) + 1;
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

export type ObservationArgs = { text: unknown; subject?: unknown; ttlDays?: number; by: string; now?: Date };

/** Note something in passing: it shows for `ttlDays` (default 14, at most 90), then stops. */
export function logObservation(a: ObservationArgs): Res {
  const text = flat(String(a.text ?? ""));
  if (!text) return { ok: false, message: "Give the observation some text." };
  if (text.length > MAX_OBSERVATION) return { ok: false, message: `The observation is ${text.length} characters; the limit is ${MAX_OBSERVATION}. Shorten it.` };
  const subject = a.subject === undefined || a.subject === "" ? null : normName(a.subject);
  if (a.subject !== undefined && a.subject !== "" && !subject) return { ok: false, message: badName("subject", a.subject) };
  const ttl = Math.min(MAX_TTL_DAYS, Math.max(1, Math.floor(a.ttlDays ?? DEFAULT_TTL_DAYS) || DEFAULT_TTL_DAYS));
  const now = a.now ?? new Date();
  const row = journalDb()
    .query("INSERT INTO observations (text, subject, by, ts, expires) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(text, subject, a.by, now.toISOString(), new Date(now.getTime() + ttl * DAY_MS).toISOString()) as { id: number };
  return { ok: true, message: `Observation ${row.id} noted for ${ttl} days.`, id: row.id };
}

/** Unexpired, unpromoted observations, newest first. */
export function listObservations(a: { subject?: unknown; limit?: number; now?: Date } = {}): Res {
  const subject = a.subject === undefined || a.subject === "" ? undefined : normName(a.subject);
  if (subject === null) return { ok: false, message: badName("subject", a.subject) };
  const limit = Math.min(200, Math.max(1, Math.floor(a.limit ?? 50) || 50));
  const where = ["promoted_to IS NULL", "expires > ?", ...(subject ? ["subject = ?"] : [])];
  const args = [(a.now ?? new Date()).toISOString(), ...(subject ? [subject] : [])];
  const d = journalDb();
  const total = (d.query(`SELECT COUNT(*) AS n FROM observations WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n;
  const rows = d.query(`SELECT * FROM observations WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit) as ObsRow[];
  return {
    ok: true,
    message: total ? `${total} open observation(s)${total > rows.length ? `, showing the newest ${rows.length}` : ""}` : "0 open observations",
    observations: rows.map((r) => ({ id: r.id, text: r.text, subject: r.subject ?? undefined, by: r.by, ts: r.ts, expires: r.expires.slice(0, 10) })),
  };
}

/** Mark an observation as promoted ("fact:<id>" or "captain.md"); it stops showing. */
export function promoteObservation(id: number, to: string): boolean {
  return journalDb().query("UPDATE observations SET promoted_to = ? WHERE id = ? AND promoted_to IS NULL").run(to, id).changes > 0;
}

/** Whether an observation exists (promoted or expired ones too). */
export function observationExists(id: number): boolean {
  return Boolean(journalDb().query("SELECT 1 FROM observations WHERE id = ?").get(id));
}
