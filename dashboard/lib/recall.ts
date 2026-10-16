import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { journalDb } from "./journal.ts";
import { aliceVault, fleetInboxRoot } from "./paths.ts";

/**
 * recall (resilient fleet runtime, R3e): full-text search over what the fleet
 * said and did, so an officer can look up a past decision without carrying
 * history in its context. It replaces Hermes' session search for Alice.
 *
 * Indexed (incrementally, by the node): every agent's captain chat thread,
 * helper results (delegations), digests, and captain notices. The vault is not
 * indexed here: deep vault questions go to a librarian helper.
 *
 * SQLite FTS5 in the journal's database; queries need no model and return
 * short snippets with where they came from.
 */

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(source, ref, ts, text, tokenize = 'porter unicode61');
CREATE TABLE IF NOT EXISTS recall_seen (key TEXT PRIMARY KEY, mark TEXT NOT NULL);
`;

function db() {
  const d = journalDb();
  d.exec(SCHEMA);
  return d;
}

const seen = (key: string): string | null => (db().query("SELECT mark FROM recall_seen WHERE key = ?").get(key) as { mark: string } | null)?.mark ?? null;
const mark = (key: string, value: string) => db().query("INSERT INTO recall_seen (key, mark) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET mark = excluded.mark").run(key, value);
const add = (source: string, ref: string, ts: string, text: string) => db().query("INSERT INTO recall_fts (source, ref, ts, text) VALUES (?, ?, ?, ?)").run(source, ref, ts, text.slice(0, 8000));

/** New chat lines since the last pass (byte offset per thread file). */
function indexChats(): number {
  const root = fleetInboxRoot();
  let n = 0;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const agent of names) {
    const file = join(root, agent, "captain-chat.jsonl");
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agent) || !existsSync(file)) continue;
    const size = statSync(file).size;
    const from = Number(seen(`chat:${agent}`) ?? 0);
    if (size === from) continue;
    const start = size < from ? 0 : from;
    const buf = readFileSync(file).subarray(start);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) continue;
    for (const raw of text.slice(0, end).split("\n")) {
      try {
        const l = JSON.parse(raw) as { ts?: string; from?: string; kind?: string; text?: string };
        if (!l.text || l.kind === "answer") continue;
        add(`chat:${agent}`, `${agent} ${l.from ?? ""}`, l.ts ?? "", l.text);
        n++;
      } catch {
        /* skip */
      }
    }
    mark(`chat:${agent}`, String(start + Buffer.byteLength(text.slice(0, end + 1))));
  }
  return n;
}

/** Files that appear once and do not change: helper results, digests. */
function indexFiles(source: string, files: string[]): number {
  let n = 0;
  for (const f of files) {
    if (seen(`file:${f}`)) continue;
    try {
      add(source, f, statSync(f).mtime.toISOString(), readFileSync(f, "utf8"));
      mark(`file:${f}`, "1");
      n++;
    } catch {
      /* skip */
    }
  }
  return n;
}

function listFiles(dir: string, depth: number, name: RegExp): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory() && depth > 0) out.push(...listFiles(p, depth - 1, name));
    else if (st.isFile() && name.test(e)) out.push(p);
  }
  return out;
}

/** Notices (done, blocked, digests...) by id. */
function indexNotices(): number {
  const d = db();
  try {
    d.query("SELECT 1 FROM notices LIMIT 1").get();
  } catch {
    return 0;
  }
  const last = Number(seen("notices") ?? 0);
  const rows = d.query("SELECT id, ts, from_agent, kind, summary FROM notices WHERE id > ? AND kind != 'digest' ORDER BY id").all(last) as { id: number; ts: string; from_agent: string; kind: string; summary: string }[];
  for (const r of rows) add("notice", `${r.from_agent} ${r.kind}`, r.ts, r.summary);
  if (rows.length) mark("notices", String(rows.at(-1)!.id));
  return rows.length;
}

/** One incremental indexing pass; returns how many entries were added. */
export function indexRecall(): number {
  const inbox = fleetInboxRoot();
  return (
    indexChats() +
    indexFiles("helper", listFiles(inbox, 3, /^result\.md$/)) +
    indexFiles("digest", listFiles(join(aliceVault(), "fleet", "digests"), 0, /\.md$/)) +
    indexNotices()
  );
}

export type RecallHit = { source: string; ref: string; ts: string; snippet: string };

/** Search; words are matched as prefixes, quoted phrases kept. */
export function recall(query: string, limit = 8): RecallHit[] {
  const terms = (query.match(/"[^"]+"|[\p{L}\p{N}_-]+/gu) ?? []).map((t) => (t.startsWith('"') ? t : `"${t.replace(/"/g, "")}"*`));
  if (!terms.length) return [];
  try {
    indexRecall();
    return db()
      .query("SELECT source, ref, ts, snippet(recall_fts, 3, '«', '»', ' … ', 24) AS snippet FROM recall_fts WHERE recall_fts MATCH ? ORDER BY bm25(recall_fts) LIMIT ?")
      .all(terms.join(" OR "), Math.max(1, Math.min(20, limit))) as RecallHit[];
  } catch {
    return [];
  }
}

export function startRecallIndexer(): void {
  const tick = () => {
    try {
      indexRecall();
    } catch (e) {
      console.error("[node] recall index:", e);
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 60_000);
}
