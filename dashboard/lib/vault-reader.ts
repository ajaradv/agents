import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { aliceVault } from "./paths.ts";
import { escapeHtml } from "./quota.ts";
import { type VaultSearchReply, vaultSearch } from "./node-client.ts";
import { splitNote } from "./vault-note.ts";

/**
 * The vault reader (vault plan feature/ship-roadmaps, SR4): read-only pages for
 * the notes, behind the dashboard's own request guard like every other page.
 *
 * - `/vault/` and `/vault/<folder>/`: notes with title and summary, subfolders.
 * - `/vault/<note>.md`: frontmatter header, body through Bun.markdown, `[[wiki
 *   links]]` resolved the way Obsidian does (by name across the vault).
 * - `/vault/<image>`: images that sit in the vault, for notes that embed them.
 * - `/vault/?q=words`: the vault search behind `vault_search`, with snippets.
 *
 * Out of reach, as in search: `career/`, `profile/`, `templates/`, anything
 * starting with a dot, and any path that leaves the vault (`..`, symlinks).
 * All of those answer 404, the same as a note that does not exist.
 */

const BLOCKED = new Set(["career", "profile", "templates"]);
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

export type Guarded = { rel: string; file: string; dir: boolean };

/** A reader path made safe: the real file under the vault, or null (404). `rel` is "" for the vault root. */
export function guardVaultPath(raw: string, vault = aliceVault()): Guarded | null {
  if (raw.includes("\0") || raw.includes("\\")) return null;
  const rel = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = rel ? rel.split("/") : [];
  if (parts.some((p) => !p || p.startsWith("."))) return null; // dot folders, "..", and empty segments
  if (parts[0] && BLOCKED.has(parts[0])) return null;
  let real: string;
  let root: string;
  try {
    root = realpathSync(vault);
    real = realpathSync(join(vault, ...parts));
  } catch {
    return null;
  }
  if (real !== root && !real.startsWith(root + sep)) return null;
  // A symlink inside the vault may land in a blocked folder or a dot folder.
  const inside = real === root ? [] : real.slice(root.length + 1).split(sep);
  if (inside.some((p) => p.startsWith(".")) || (inside[0] && BLOCKED.has(inside[0]))) return null;
  const st = statSync(real);
  if (!st.isDirectory() && !st.isFile()) return null;
  return { rel, file: real, dir: st.isDirectory() };
}

/** Every reachable file (notes and images), as vault-relative paths. Symlinks are skipped, as the indexer does. */
function walkReadable(vault: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".") || (!rel && BLOCKED.has(name))) continue;
      const file = join(dir, name);
      let st;
      try {
        st = lstatSync(file);
      } catch {
        continue;
      }
      const r = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) visit(file, r);
      else if (st.isFile() && (name.endsWith(".md") || ext(name) in IMAGE_TYPES)) out.push(r);
    }
  };
  visit(vault, "");
  return out;
}

/** Find the file a wiki link names: by path suffix when it has a slash, else by name; the nearest folder wins a tie. */
export function resolveWikiTarget(target: string, files: string[], fromDir = ""): string | null {
  let t = target.trim().replace(/[#^].*$/, "").toLowerCase();
  if (!t) return null;
  const isAsset = ext(t) in IMAGE_TYPES;
  if (!isAsset && t.endsWith(".md")) t = t.slice(0, -3);
  const key = (f: string) => (isAsset ? f.toLowerCase() : f.replace(/\.md$/, "").toLowerCase());
  const hits = files.filter((f) => {
    if (isAsset !== !f.endsWith(".md")) return false;
    const k = key(f);
    return k === t || k.endsWith(`/${t}`);
  });
  if (!hits.length) return null;
  const near = (f: string) => (dirname(f) === (fromDir || ".") ? 0 : 1);
  return hits.sort((a, b) => near(a) - near(b) || a.split("/").length - b.split("/").length || a.localeCompare(b))[0]!;
}

const href = (rel: string) => `/vault/${rel.split("/").map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"))).join("/")}`;

/** `[[note]]`, `[[note#heading|alias]]` and `![[image.png]]` as markdown links; code is left alone, a name that matches nothing becomes plain text. */
export function resolveWikiLinks(md: string, files: string[], fromDir = ""): string {
  const swap = (s: string) =>
    s.replace(/(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_m, bang: string, target: string, alias?: string) => {
      const hit = resolveWikiTarget(target, files, fromDir);
      const label = (alias?.trim() || target.trim().replace(/#.*$/, "") || target).replace(/[[\]]/g, "\\$&");
      if (!hit) return `<span class="dead" title="No note by that name">${escapeHtml(alias?.trim() || target.trim())}</span>`;
      const heading = target.includes("#") && !target.includes("^") ? `#${encodeURIComponent(target.slice(target.indexOf("#") + 1).trim().toLowerCase().replace(/\s+/g, "-"))}` : "";
      return bang && !hit.endsWith(".md") ? `![${label}](${href(hit)})` : `[${label}](${href(hit)}${heading})`;
    });
  let fence = "";
  return md
    .split("\n")
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (f) fence = !fence ? f[1]![0]! : fence === f[1]![0] ? "" : fence;
      if (fence || f) return line;
      return line.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : swap(seg))).join("");
    })
    .join("\n");
}

/** Relative images and links in rendered html point at their real reader URL (and a missing target stays as written). */
function fixRelative(html: string, noteDir: string, vault: string): string {
  const fix = (url: string): string => {
    const u = url.replace(/&amp;/g, "&");
    if (/^([a-z][a-z0-9+.-]*:|\/|#|\/\/)/i.test(u)) return url;
    const [pathPart, frag] = u.split("#") as [string, string | undefined];
    let rel: string;
    try {
      rel = posix.normalize(posix.join(noteDir, decodeURIComponent(pathPart)));
    } catch {
      return url;
    }
    const g = guardVaultPath(rel, vault);
    return g && !g.dir ? href(g.rel) + (frag ? `#${frag}` : "") : url;
  };
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]*)"/g, (_m, a: string, u: string) => `${a}${fix(u)}"`).replace(/(<a\b[^>]*?\bhref=")([^"]*)"/g, (_m, a: string, u: string) => `${a}${fix(u)}"`);
}

const CSS = `
  :root { color-scheme: light; --ink:#1a1a1a; --bone:#f4efe4; --sheet:#fffaf2; --teal:#0f6e68; --amber:#8a6200; --quiet:#3d4a3a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bone); color: var(--ink); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header.bar { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; padding: .6rem 1rem; background: var(--ink); color: var(--bone); }
  header.bar a { color: var(--bone); text-decoration: none; padding: .25rem .1rem; }
  header.bar a.on { border-bottom: 2px solid var(--bone); }
  header.bar form { margin-left: auto; display: flex; gap: .4rem; flex: 1 1 14rem; max-width: 24rem; }
  header.bar input { flex: 1; min-width: 0; padding: .4rem .5rem; border: 1px solid var(--bone); background: var(--sheet); font: inherit; }
  header.bar button { padding: .4rem .7rem; border: 1px solid var(--bone); background: var(--bone); font: inherit; cursor: pointer; }
  main { max-width: 56rem; margin: 0 auto; padding: 1rem; }
  main.wide { max-width: 72rem; }
  h1, h2, h3 { line-height: 1.2; margin: 1.2em 0 .4em; }
  h1:first-child { margin-top: 0; }
  a { color: var(--teal); }
  .dead { color: var(--quiet); border-bottom: 1px dotted var(--quiet); }
  pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; }
  pre { background: #f4efe4; border: 1px solid var(--ink); padding: .75rem; overflow: auto; }
  .note { background: var(--sheet); border: 2px solid var(--ink); padding: 1rem; overflow-wrap: anywhere; }
  .note table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; }
  .note th, .note td { border: 1px solid var(--ink); padding: .3rem .5rem; text-align: left; vertical-align: top; }
  .note img { max-width: 100%; height: auto; }
  .meta { display: flex; flex-wrap: wrap; gap: .4rem; margin: .3rem 0 .6rem; }
  .chip { border: 1px solid var(--ink); padding: 0 .4rem; font-size: .8rem; background: var(--bone); }
  .chip.warn { background: #f3d77a; border-color: var(--amber); color: #3b2a00; }
  .muted { color: var(--quiet); }
  ul.list { list-style: none; margin: 0; padding: 0; }
  ul.list li { background: var(--sheet); border: 1px solid var(--ink); padding: .5rem .7rem; margin-bottom: .4rem; }
  ul.list li a.t { font-weight: 600; }
  mark { background: #f3d77a; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 1rem; }
  .card { background: var(--sheet); border: 2px solid var(--ink); padding: .8rem; min-width: 0; overflow-wrap: anywhere; }
  .card h2 { margin: 0 0 .2rem; font-size: 1.15rem; }
  .card h3 { margin: .8rem 0 .2rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--quiet); }
  .card p, .card ul, .card ol { margin: .2rem 0; }
  .card .more { display: inline-block; margin-top: .7rem; }
  @media (max-width: 640px) { main { padding: .7rem; } body { font-size: 16px; } }
`;

export function readerPage(title: string, body: string, opts: { active?: "ships" | "vault"; q?: string; wide?: boolean } = {}): Response {
  const nav = (path: string, label: string, on: boolean) => `<a href="${path}"${on ? ' class="on"' : ""}>${label}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><meta name="theme-color" content="#071018" /><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><header class="bar">${nav("/", "Fleet", false)}${nav("/ships", "Ships", opts.active === "ships")}${nav("/vault/", "Vault", opts.active === "vault")}<form action="/vault/" method="get" role="search"><input type="search" name="q" value="${escapeHtml(opts.q ?? "")}" placeholder="Search the vault" aria-label="Search the vault" /><button type="submit">Search</button></form></header><main${opts.wide ? ' class="wide"' : ""}>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Notes are the captain's, but raw html in one must still not run.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'",
      "Cache-Control": "no-store",
    },
  });
}

const notFound = () => new Response("not found", { status: 404 });

const str = (v: unknown): string => (v === undefined || v === null || v === "" ? "" : Array.isArray(v) ? v.flat(3).join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const titleOf = (fm: Record<string, unknown> | null, rel: string) => str(fm?.title) || rel.replace(/^.*\//, "").replace(/\.md$/, "");

function crumbs(rel: string): string {
  const parts = rel ? rel.split("/") : [];
  const out = [`<a href="/vault/">vault</a>`];
  parts.slice(0, -1).forEach((p, i) => out.push(`<a href="${href(parts.slice(0, i + 1).join("/"))}/">${escapeHtml(p)}</a>`));
  return `<p class="muted">${out.join(" / ")}</p>`;
}

function noteResponse(g: Guarded, vault: string): Response {
  const { fm, body } = splitNote(readFileSync(g.file, "utf8"));
  const files = walkReadable(vault);
  const noteDir = posix.dirname(g.rel) === "." ? "" : posix.dirname(g.rel);
  const html = fixRelative(Bun.markdown.html(resolveWikiLinks(body, files, noteDir)), noteDir, vault);
  const title = titleOf(fm, g.rel);
  const chips = (["type", "category", "status", "ship", "updated"] as const)
    .map((k) => [k, str(fm?.[k])] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `<span class="chip">${k}: ${escapeHtml(v)}</span>`)
    .join("");
  const summary = str(fm?.summary) || str(fm?.description);
  const head = `${crumbs(g.rel)}<h1>${escapeHtml(title)}</h1><div class="meta">${chips}</div>${summary ? `<p class="muted">${escapeHtml(summary)}</p>` : ""}`;
  return readerPage(title, `${head}<article class="note">${html}</article>`, { active: "vault" });
}

function folderResponse(g: Guarded, vault: string): Response {
  const names = readdirSync(g.file).filter((n) => !n.startsWith(".") && !(g.rel === "" && BLOCKED.has(n))).sort();
  const dirs: string[] = [];
  const notes: { name: string; title: string; summary: string; updated: string }[] = [];
  for (const name of names) {
    const sub = guardVaultPath(g.rel ? `${g.rel}/${name}` : name, vault);
    if (!sub) continue;
    if (sub.dir) dirs.push(name);
    else if (name.endsWith(".md")) {
      const { fm } = splitNote(readFileSync(sub.file, "utf8"));
      notes.push({ name, title: titleOf(fm, name), summary: str(fm?.summary) || str(fm?.description), updated: str(fm?.updated) });
    }
  }
  notes.sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title));
  const here = g.rel ? `${g.rel}/` : "";
  const folderItems = dirs.map((d) => `<li><a class="t" href="${href(here + d)}/">${escapeHtml(d)}/</a></li>`).join("");
  const noteItems = notes
    .map((n) => `<li><a class="t" href="${href(here + n.name)}">${escapeHtml(n.title)}</a>${n.updated ? ` <span class="chip">${escapeHtml(n.updated)}</span>` : ""}${n.summary ? `<div class="muted">${escapeHtml(n.summary)}</div>` : ""}</li>`)
    .join("");
  const title = g.rel || "Vault";
  return readerPage(title, `${g.rel ? crumbs(`${g.rel}/x`) : ""}<h1>${escapeHtml(title)}</h1><ul class="list">${folderItems}${noteItems}</ul>${dirs.length + notes.length ? "" : `<p class="muted">Nothing here.</p>`}`, { active: "vault" });
}

/** Search runs in the fleet node, which owns the vault index; with the node down there is no local fallback. */
async function searchResponse(q: string, vault: string, search: VaultSearcher): Promise<Response> {
  const res = await search(q);
  if (!res) return readerPage("Search", `<h1>Search</h1><p class="muted">Search is unavailable while the fleet node is down.</p>`, { active: "vault", q });
  const mark = (s: string) => escapeHtml(s).replace(/«/g, "<mark>").replace(/»/g, "</mark>");
  const items = (res.hits ?? [])
    .filter((h) => guardVaultPath(h.path, vault))
    .map(
      (h) =>
        `<li><a class="t" href="${href(h.path)}">${escapeHtml(h.title)}</a> <span class="chip">${escapeHtml(h.path)}</span>${h.status ? ` <span class="chip">${escapeHtml(h.status)}</span>` : ""}${h.section && h.section !== "(top)" ? `<div class="muted">in ${escapeHtml(h.section)}</div>` : ""}${h.snippet ? `<div>${mark(h.snippet)}</div>` : ""}</li>`,
    )
    .join("");
  return readerPage(`Search: ${q}`, `<h1>Search</h1><p class="muted">${escapeHtml(res.message)}</p><ul class="list">${items}</ul>`, { active: "vault", q });
}

export type VaultSearcher = (query: string) => Promise<VaultSearchReply | null>;

/** GET /vault/<path>: a folder, a note, or an image; anything else 404. */
export async function vaultResponse(urlPath: string, search: URLSearchParams, vault = aliceVault(), searcher: VaultSearcher = vaultSearch): Promise<Response> {
  const q = (search.get("q") ?? "").trim();
  let raw: string;
  try {
    raw = decodeURIComponent(urlPath.replace(/^\/vault\/?/, ""));
  } catch {
    return notFound();
  }
  if (q && !raw) return searchResponse(q, vault, searcher);
  let g = guardVaultPath(raw, vault);
  if (!g && raw && !raw.endsWith(".md") && !raw.endsWith("/")) g = guardVaultPath(`${raw}.md`, vault); // a bare name, as in a wiki link
  if (!g) return notFound();
  if (g.dir) return folderResponse(g, vault);
  if (g.file.endsWith(".md")) return noteResponse(g, vault);
  const type = IMAGE_TYPES[ext(g.file)];
  if (!type) return notFound();
  return new Response(Bun.file(g.file), { headers: { "Content-Type": type, "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache" } });
}
