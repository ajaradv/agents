import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { escapeHtml } from "./quota.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Agent canvas items, written by extensions/canvas.ts under
 * fleet/inbox/<agent>/canvas/<id>/ (item.json plus copied files).
 *
 * Everything an agent wrote is served with a sandbox CSP: the page gets an
 * opaque origin and cannot call the dashboard's API or read its storage.
 * Agent html may run scripts but has no network except listed CDNs; markdown
 * and tables run no scripts at all.
 */

export type CanvasItem = {
  id: string;
  title: string;
  kind: "image" | "html" | "markdown" | "table" | "url";
  caption?: string;
  updated: string;
  images?: { file: string; label: string }[];
  choose?: boolean;
  entry?: string;
  file?: string;
  url?: string;
  /** url items: why the page will not show in a frame (set by withFrameChecks). */
  frameBlocked?: string;
};

const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const ITEM_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function canvasDir(agentId: string): string {
  return join(fleetInboxRoot(), agentId, "canvas");
}

export async function listCanvas(agentId: string): Promise<CanvasItem[]> {
  if (!ID_RE.test(agentId)) return [];
  let names: string[];
  try {
    names = await readdir(canvasDir(agentId));
  } catch {
    return [];
  }
  const items: CanvasItem[] = [];
  for (const name of names) {
    if (!ITEM_RE.test(name)) continue;
    try {
      const item = JSON.parse(await readFile(join(canvasDir(agentId), name, "item.json"), "utf8")) as CanvasItem;
      if (item.id !== name) continue;
      if (item.kind === "url" && !isLocalUrl(item.url)) continue;
      items.push(item);
    } catch {
      /* half-written or broken item */
    }
  }
  return items.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function isLocalUrl(raw: unknown): boolean {
  try {
    const u = new URL(String(raw));
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * Why a local page cannot be framed by the dashboard, or null when it can.
 * The dashboard is a different origin from any dev server, so X-Frame-Options
 * of any value (Django's default is DENY) blocks it, and so does a CSP
 * frame-ancestors list that does not name the dashboard.
 */
export function frameBlockReason(headers: Headers, dashboardOrigin: string): string | null {
  const xfo = headers.get("x-frame-options");
  if (xfo) return `the page sends X-Frame-Options: ${xfo}`;
  const fa = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(headers.get("content-security-policy") ?? "")?.[1]?.trim();
  if (fa !== undefined) {
    const sources = fa.split(/\s+/);
    const host = new URL(dashboardOrigin).host;
    if (!sources.some((src) => src === "*" || src === dashboardOrigin || src.endsWith(`//${host}`))) {
      return `the page's Content-Security-Policy sets frame-ancestors ${fa || "'none'"}`;
    }
  }
  return null;
}

/** Fill frameBlocked on url items by asking each local page for its headers. */
export async function withFrameChecks(items: CanvasItem[], dashboardOrigin: string): Promise<CanvasItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.kind !== "url" || !item.url) return item;
      try {
        const res = await fetch(item.url, { redirect: "follow", signal: AbortSignal.timeout(2000) });
        res.body?.cancel().catch(() => {});
        const reason = frameBlockReason(res.headers, dashboardOrigin);
        return reason ? { ...item, frameBlocked: reason } : item;
      } catch {
        return { ...item, frameBlocked: "the page is not responding (is the dev server running?)" };
      }
    }),
  );
}

/** Cheap change signature per agent: item ids and their item.json mtimes. */
export async function canvasSignature(agentId: string): Promise<string> {
  let names: string[];
  try {
    names = await readdir(canvasDir(agentId));
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const name of names.sort()) {
    if (!ITEM_RE.test(name)) continue;
    try {
      parts.push(`${name}:${(await stat(join(canvasDir(agentId), name, "item.json"))).mtimeMs}`);
    } catch {
      /* skip */
    }
  }
  return parts.join(",");
}

const SANDBOX_SCRIPTS =
  "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob:; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'";
const SANDBOX_STATIC =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:";

/**
 * A regular file inside an item's folder, or null. Checked after resolving
 * symlinks too, so a link copied into the item cannot point outside it.
 */
export async function confinedFile(base: string, rel: string): Promise<string | null> {
  const full = normalize(join(base, rel));
  if (!full.startsWith(base + sep)) return null;
  try {
    const [realBase, realFull] = await Promise.all([realpath(base), realpath(full)]);
    if (!realFull.startsWith(realBase + sep)) return null;
    return (await stat(realFull)).isFile() ? realFull : null;
  } catch {
    return null;
  }
}

/** Serve one file of an item, confined to the item's folder. */
export async function canvasFileResponse(agentId: string, itemId: string, rel: string): Promise<Response> {
  if (!ID_RE.test(agentId) || !ITEM_RE.test(itemId)) return new Response("not found", { status: 404 });
  const base = join(canvasDir(agentId), itemId);
  const full = await confinedFile(base, rel);
  if (!full || full.endsWith(`${sep}item.json`)) return new Response("not found", { status: 404 });
  const file = Bun.file(full);
  const isHtml = /\.html?$/i.test(full);
  const isSvg = /\.svg$/i.test(full);
  return new Response(file, {
    headers: {
      "Content-Security-Policy": isHtml ? SANDBOX_SCRIPTS : SANDBOX_STATIC,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...(isSvg ? { "Content-Type": "image/svg+xml" } : {}),
    },
  });
}

const VIEW_CSS = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 28px; background: #fffaf2; color: #1a1a1a;
         font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1, h2, h3 { line-height: 1.2; margin: 1.2em 0 0.4em; }
  h1:first-child, h2:first-child { margin-top: 0; }
  pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }
  pre { background: #f4efe4; padding: 12px; overflow: auto; border: 1px solid #1a1a1a; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #1a1a1a; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f4efe4; position: sticky; top: 0; }
  tr:nth-child(even) td { background: #fbf6ec; }
  img { max-width: 100%; }
  a { color: #0f6e68; }
`;

function viewPage(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>${VIEW_CSS}</style></head><body>${body}</body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SANDBOX_STATIC,
      "Cache-Control": "no-store",
    },
  });
}

function tableHtml(rows: unknown[]): string {
  const objs = rows.filter((r) => r && typeof r === "object") as Record<string, unknown>[];
  if (!objs.length) return "<p>No rows.</p>";
  const cols = [...new Set(objs.flatMap((r) => Object.keys(r)))].slice(0, 40);
  const cell = (v: unknown) => escapeHtml(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return `<table><thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${objs
    .map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

/** Rendered view for markdown and table items (no scripts). */
export async function canvasViewResponse(agentId: string, itemId: string): Promise<Response> {
  const item = (await listCanvas(agentId)).find((i) => i.id === itemId);
  if (!item || !item.file) return new Response("not found", { status: 404 });
  const path = await confinedFile(join(canvasDir(agentId), itemId), item.file);
  if (!path) return new Response("not found", { status: 404 });
  const raw = await readFile(path, "utf8");
  if (item.kind === "markdown") return viewPage(item.title, Bun.markdown.html(raw));
  if (item.kind === "table") {
    let rows: unknown = [];
    try {
      rows = JSON.parse(raw);
    } catch {
      /* show empty */
    }
    return viewPage(item.title, tableHtml(Array.isArray(rows) ? rows : []));
  }
  return new Response("not found", { status: 404 });
}
