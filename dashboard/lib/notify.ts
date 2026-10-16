import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { journalDb, journalEvent } from "./journal.ts";
import { aliceVault } from "./paths.ts";

/**
 * Captain notifications (resilient fleet runtime, R3): one door for an agent to
 * tell the captain something, with a policy instead of chatter.
 *
 * - Kinds done, blocked, decision, and milestone interrupt: they appear on
 *   Needs you at once (and are spoken when voice is on).
 * - Everything else (info) waits for the digest.
 * - Snooze holds even the interrupting kinds; Wake ends the snooze and
 *   compiles what was held into a digest right away.
 * - Every morning (FLEET_DIGEST_HOUR, default 8, local time) everything since
 *   the last digest becomes one digest notice plus a vault note under
 *   fleet/digests/.
 *
 * Stored in the journal's database (table notices), so both the node and the
 * dashboard read and write it.
 */

export type NoticeKind = "done" | "blocked" | "decision" | "milestone" | "info" | "digest";
export const INTERRUPTING: ReadonlySet<NoticeKind> = new Set(["done", "blocked", "decision", "milestone"]);
export type Delivery = "interrupt" | "digest" | "held";
export type Notice = { id: number; ts: string; from: string; kind: NoticeKind; summary: string; detail: string; ref: string; delivery: Delivery; acked: boolean; digest: number | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, from_agent TEXT NOT NULL, kind TEXT NOT NULL,
  summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, digest INTEGER
);
CREATE INDEX IF NOT EXISTS notices_open ON notices(delivery, acked);
CREATE TABLE IF NOT EXISTS quiet (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

function db() {
  const d = journalDb();
  d.exec(SCHEMA);
  return d;
}

type Row = { id: number; ts: string; from_agent: string; kind: string; summary: string; detail: string; ref: string; delivery: string; acked: number; digest: number | null };
const toNotice = (r: Row): Notice => ({ id: r.id, ts: r.ts, from: r.from_agent, kind: r.kind as NoticeKind, summary: r.summary, detail: r.detail, ref: r.ref, delivery: r.delivery as Delivery, acked: r.acked === 1, digest: r.digest });

let changed: () => void = () => {};
/** Told whenever notices change (the node emits it to the dashboard). */
export function onNoticesChange(fn: () => void): void {
  changed = fn;
}

// ---------------------------------------------------------------- quiet (snooze)

export function quietState(): { snoozed: boolean; since: string | null; lastDigest: string | null; lastMorning: string | null } {
  const rows = db().query("SELECT k, v FROM quiet").all() as { k: string; v: string }[];
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  return { snoozed: m.snoozed === "1", since: m.snoozedSince ?? null, lastDigest: m.lastDigest ?? null, lastMorning: m.lastMorning ?? null };
}

function setQuiet(k: string, v: string): void {
  db().query("INSERT INTO quiet (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

export function snooze(): void {
  setQuiet("snoozed", "1");
  setQuiet("snoozedSince", new Date().toISOString());
  journalEvent("captain", "snooze", {});
  changed();
}

/** End the snooze and compile what was held into a digest now. */
export async function wake(): Promise<Notice | null> {
  setQuiet("snoozed", "0");
  journalEvent("captain", "wake", {});
  const held = (db().query("SELECT * FROM notices WHERE delivery = 'held' AND digest IS NULL ORDER BY id").all() as Row[]).map(toNotice);
  const digest = held.length ? await compileDigest(held, "While you were snoozed") : null;
  changed();
  return digest;
}

// ---------------------------------------------------------------- notify

/** The policy: interrupt for done/blocked/decision/milestone unless snoozed; the rest waits for the digest. */
export function deliveryFor(kind: NoticeKind, snoozed: boolean): Delivery {
  if (!INTERRUPTING.has(kind)) return "digest";
  return snoozed ? "held" : "interrupt";
}

export function notifyCaptain(n: { from: string; kind: NoticeKind; summary: string; detail?: string; ref?: string }): Notice {
  const kind: NoticeKind = (["done", "blocked", "decision", "milestone", "info"] as const).includes(n.kind as never) ? n.kind : "info";
  const delivery = deliveryFor(kind, quietState().snoozed);
  const ts = new Date().toISOString();
  const r = db()
    .query("INSERT INTO notices (ts, from_agent, kind, summary, detail, ref, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ts, n.from, kind, n.summary.slice(0, 500), (n.detail ?? "").slice(0, 4000), (n.ref ?? "").slice(0, 300), delivery);
  journalEvent(`notice-${r.lastInsertRowid}`, "notice", { from: n.from, kind, delivery });
  changed();
  return { id: Number(r.lastInsertRowid), ts, from: n.from, kind, summary: n.summary, detail: n.detail ?? "", ref: n.ref ?? "", delivery, acked: false, digest: null };
}

/** What Needs you shows: interrupting notices and digests not yet acknowledged. */
export function openNotices(): Notice[] {
  return (db().query("SELECT * FROM notices WHERE delivery = 'interrupt' AND acked = 0 ORDER BY id DESC LIMIT 50").all() as Row[]).map(toNotice);
}

export function ackNotice(id: number): boolean {
  const r = db().query("UPDATE notices SET acked = 1 WHERE id = ? AND acked = 0").run(id);
  if (r.changes) changed();
  return r.changes > 0;
}

// ---------------------------------------------------------------- digest

const LABEL: Record<NoticeKind, string> = { done: "Done", blocked: "Blocked", decision: "Needs a decision", milestone: "Milestones", info: "For your information", digest: "Digest" };

/** The digest text: grouped by kind, one line per notice. */
export function digestText(items: Notice[], title: string): string {
  const groups = new Map<NoticeKind, Notice[]>();
  for (const n of items) groups.set(n.kind, [...(groups.get(n.kind) ?? []), n]);
  const order: NoticeKind[] = ["decision", "blocked", "done", "milestone", "info"];
  const lines = [`# ${title}`, "", `${items.length} item(s), ${items[0]?.ts.slice(0, 16).replace("T", " ") ?? ""} to ${items.at(-1)?.ts.slice(0, 16).replace("T", " ") ?? ""} UTC.`, ""];
  for (const k of order) {
    const g = groups.get(k);
    if (!g?.length) continue;
    lines.push(`## ${LABEL[k]}`, "");
    for (const n of g) lines.push(`- **${n.from}**: ${n.summary}${n.ref ? ` (${n.ref})` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Fold notices into one digest notice (on Needs you) and a vault note. */
export async function compileDigest(items: Notice[], title: string): Promise<Notice | null> {
  if (!items.length) return null;
  const text = digestText(items, title);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rel = `fleet/digests/${stamp}.md`;
  try {
    await mkdir(join(aliceVault(), "fleet", "digests"), { recursive: true });
    await writeFile(join(aliceVault(), rel), `---\ntitle: "${title}"\ncreated: ${new Date().toISOString()}\nitems: ${items.length}\n---\n\n${text}`, "utf8");
  } catch {
    /* the notice still carries the text */
  }
  const d = db();
  const r = d
    .query("INSERT INTO notices (ts, from_agent, kind, summary, detail, ref, delivery) VALUES (?, 'fleet', 'digest', ?, ?, ?, 'interrupt')")
    .run(new Date().toISOString(), `${title}: ${items.length} item(s)`, text, rel);
  const id = Number(r.lastInsertRowid);
  const mark = d.query("UPDATE notices SET digest = ? WHERE id = ?");
  for (const n of items) mark.run(id, n.id);
  setQuiet("lastDigest", new Date().toISOString());
  return { id, ts: new Date().toISOString(), from: "fleet", kind: "digest", summary: `${title}: ${items.length} item(s)`, detail: text, ref: rel, delivery: "interrupt", acked: false, digest: null };
}

/** The morning digest: everything waiting for a digest (and anything held) since the last one. */
export async function morningDigest(): Promise<Notice | null> {
  const items = (db().query("SELECT * FROM notices WHERE delivery IN ('digest', 'held') AND digest IS NULL ORDER BY id").all() as Row[]).map(toNotice);
  const n = await compileDigest(items, "Morning digest");
  if (n) changed();
  return n;
}

/** Run the morning digest once a day at FLEET_DIGEST_HOUR (local), checking every minute. */
export function startDigestClock(hour = Number(process.env.FLEET_DIGEST_HOUR ?? 8)): void {
  const tick = async () => {
    const now = new Date();
    if (now.getHours() < hour) return;
    const today = now.toLocaleDateString("sv");
    if (quietState().lastMorning === today) return;
    setQuiet("lastMorning", today);
    await morningDigest();
  };
  setInterval(() => void tick().catch((e) => console.error("[node] digest:", e)), 60_000);
}
