import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aliceVault } from "./paths.ts";
import { ftsQuery, recallDb } from "./recall.ts";
import { writeSessionBrief, writeSessionFacts } from "./session-brief.ts";
import { sectionsOf, splitNote } from "./vault-note.ts";

/**
 * The vault mirror (vault plan alice-memory-and-tools, M1), one way: the notes
 * stay the source of truth, and the node copies what agents search by into the
 * journal's database.
 *
 * - `vault_notes`: one row per note with its frontmatter fields (type, title,
 *   status, ship, summary, description, updated), mtime, size, and the whole
 *   frontmatter as JSON, for exact filters.
 * - the recall FTS table, source `vault`: one entry per section (ref
 *   `path#heading`; the note's title and summary ride with its opening text).
 *
 * A pass is incremental by mtime and size. A changed or removed note loses all
 * its rows first, so nothing stale is left behind. `.obsidian/`, `templates/`
 * and other dot folders are skipped, and so are `career/` and `profile/`: the
 * captain's own notes stay out of agents' search (the captain, 2026-10-31).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_notes (
  path TEXT PRIMARY KEY, type TEXT, title TEXT, status TEXT, ship TEXT, summary TEXT, description TEXT,
  updated TEXT, mtime INTEGER NOT NULL, bytes INTEGER NOT NULL, fm_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS vault_notes_type ON vault_notes(type, status);
`;

function db() {
  const d = recallDb();
  d.exec(SCHEMA);
  return d;
}

/** Bump when what a pass extracts changes: the next pass then rebuilds every note instead of trusting mtimes. */
const INDEX_VERSION = "2";

const SKIP_DIRS = new Set(["templates", "career", "profile"]);
/** One FTS entry holds at most this many characters; a longer section becomes several entries under one ref. */
const CHUNK = 6000;

type Found = { rel: string; file: string; mtime: number; bytes: number };

function walk(root: string): Found[] {
  const out: Found[] = [];
  const visit = (dir: string, rel: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || (!rel && SKIP_DIRS.has(name))) continue;
      const file = join(dir, name);
      let st;
      try {
        st = lstatSync(file); // symlinks are skipped: they could point out of the vault
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(file, rel ? `${rel}/${name}` : name);
      else if (st.isFile() && name.endsWith(".md")) out.push({ rel: rel ? `${rel}/${name}` : name, file, mtime: Math.floor(st.mtimeMs), bytes: st.size });
    }
  };
  visit(root, "");
  return out;
}

const scalar = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : Array.isArray(v) ? v.flat(3).join(", ") : String(v));

/** Remove everything the mirror holds for one note. */
function forget(path: string): void {
  const d = db();
  d.query("DELETE FROM vault_notes WHERE path = ?").run(path);
  d.query("DELETE FROM recall_fts WHERE source = 'vault' AND substr(ref, 1, ?) = ?").run(path.length + 1, `${path}#`);
}

function remember(f: Found): void {
  const d = db();
  const text = readFileSync(f.file, "utf8");
  const { fm, body } = splitNote(text);
  const title = scalar(fm?.title) ?? f.rel.replace(/^.*\//, "").replace(/\.md$/, "");
  const summary = scalar(fm?.summary);
  const description = scalar(fm?.description);
  forget(f.rel);
  d.query("INSERT INTO vault_notes (path, type, title, status, ship, summary, description, updated, mtime, bytes, fm_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    f.rel,
    scalar(fm?.type) ?? scalar(fm?.category), // plans and research notes carry `category:` (research, feature, ...) instead of a type
    title,
    scalar(fm?.status),
    scalar(fm?.ship),
    summary,
    description,
    scalar(fm?.updated) ?? scalar(fm?.timestamp) ?? scalar(fm?.created),
    f.mtime,
    f.bytes,
    JSON.stringify(fm ?? {}),
  );
  const ts = new Date(f.mtime).toISOString();
  const add = (heading: string, chunkText: string) => {
    for (let i = 0; i === 0 || i < chunkText.length; i += CHUNK) d.query("INSERT INTO recall_fts (source, ref, ts, text) VALUES ('vault', ?, ?, ?)").run(`${f.rel}#${heading}`, ts, chunkText.slice(i, i + CHUNK));
  };
  const sections = sectionsOf(body);
  add("", [title, summary ?? description ?? "", body.slice(0, sections[0]?.start ?? body.length).trim()].filter(Boolean).join("\n"));
  for (const s of sections) add(s.heading, body.slice(s.start, s.flatEnd).trim());
}

/** One incremental pass over the vault; what changed. */
export function indexVault(vault = aliceVault()): { added: number; removed: number } {
  const d = db();
  const built = (d.query("SELECT mark FROM recall_seen WHERE key = 'vault-index'").get() as { mark: string } | null)?.mark;
  if (built !== INDEX_VERSION) {
    d.query("DELETE FROM vault_notes").run();
    d.query("DELETE FROM recall_fts WHERE source = 'vault'").run();
    d.query("INSERT INTO recall_seen (key, mark) VALUES ('vault-index', ?) ON CONFLICT(key) DO UPDATE SET mark = excluded.mark").run(INDEX_VERSION);
  }
  const known = new Map((d.query("SELECT path, mtime, bytes FROM vault_notes").all() as { path: string; mtime: number; bytes: number }[]).map((r) => [r.path, r]));
  const found = walk(vault);
  const live = new Set(found.map((f) => f.rel));
  let added = 0;
  let removed = 0;
  d.transaction(() => {
    for (const path of known.keys()) {
      if (live.has(path)) continue;
      forget(path);
      removed++;
    }
    for (const f of found) {
      const k = known.get(f.rel);
      if (k && k.mtime === f.mtime && k.bytes === f.bytes) continue;
      try {
        remember(f);
        added++;
      } catch {
        forget(f.rel); // unreadable now: no half-indexed note
      }
    }
  })();
  return { added, removed };
}

type Hit = { path: string; title: string; type: string | null; status: string | null; summary: string | null; section?: string; snippet?: string };

export type VaultSearch = { query?: string; type?: string; status?: string; ship?: string; path?: string; limit?: number; /** swaps the query builder (the M6 eval's variant; the tools never pass it) */ match?: (query: string) => string | null };

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Frontmatter filters from the mirror, and with `query` the sections that match, best first; one row per note. */
export function searchVault(q: VaultSearch, vault = aliceVault()): { ok: boolean; message: string; [k: string]: unknown } {
  try {
    indexVault(vault);
  } catch {
    /* search what the mirror has */
  }
  const d = db();
  const limit = Math.max(1, Math.min(25, Math.floor(Number(q.limit) || 8)));
  const where: string[] = [];
  const args: string[] = [];
  for (const k of ["type", "status", "ship"] as const) {
    if (q[k]) {
      where.push(`${k} = ? COLLATE NOCASE`);
      args.push(q[k]!);
    }
  }
  if (q.path) {
    const p = q.path.replace(/^\.\//, "");
    if (/[*?[]/.test(p)) {
      where.push("path GLOB ?");
      args.push(p);
    } else {
      where.push("path LIKE ? ESCAPE '\\'");
      args.push(`${likeEscape(p)}%`);
    }
  }
  const notes = d
    .query(`SELECT path, title, type, status, summary, description FROM vault_notes ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY mtime DESC`)
    .all(...args) as { path: string; title: string; type: string | null; status: string | null; summary: string | null; description: string | null }[];
  const filters = (["type", "status", "ship", "path"] as const).filter((k) => q[k]).map((k) => `${k}=${q[k]}`);
  const what = [q.query ? `"${q.query}"` : "", ...filters].filter(Boolean).join(", ") || "all notes";
  const shape = (n: (typeof notes)[number]): Hit => ({ path: n.path, title: n.title, type: n.type, status: n.status, summary: n.summary ?? n.description });

  const fts = q.query ? (q.match ?? ftsQuery)(q.query) : null;
  if (q.query && !fts) return { ok: false, message: "The query has no searchable words. Use words, or leave it out and filter by type, status, ship, path." };
  let hits: Hit[];
  if (fts) {
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const rows = d
      .query("SELECT ref, snippet(recall_fts, 3, '«', '»', ' … ', 24) AS snippet FROM recall_fts WHERE recall_fts MATCH ? AND source = 'vault' ORDER BY bm25(recall_fts) LIMIT 300")
      .all(fts) as { ref: string; snippet: string }[];
    hits = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const cut = r.ref.indexOf(".md#");
      const path = r.ref.slice(0, cut + 3);
      const n = byPath.get(path);
      if (!n || seen.has(path)) continue;
      seen.add(path);
      hits.push({ ...shape(n), section: r.ref.slice(cut + 4) || "(top)", snippet: r.snippet });
    }
  } else {
    hits = notes.map(shape);
  }
  const shown = hits.slice(0, limit);
  return {
    ok: true,
    message: hits.length ? `${hits.length} note(s) match ${what}${hits.length > shown.length ? `; showing the first ${shown.length}` : ""}` : `0 notes match ${what}`,
    total: hits.length, // before the limit (the search log counts it)
    hits: shown,
  };
}

/** The node's vault pass: refresh the mirror and the session brief, once now and then every minute. */
export function startVaultIndexer(): void {
  const tick = () => {
    try {
      indexVault();
      writeSessionBrief();
      writeSessionFacts();
    } catch (e) {
      console.error("[node] vault index:", e);
    }
  };
  setTimeout(tick, 8000);
  setInterval(tick, 60_000);
}
