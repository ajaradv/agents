/**
 * canvas: lets fleet agents show work on the captain's dashboard canvas.
 *
 * canvas_show publishes one item under $FLEET_INBOX/$FLEET_AGENT_ID/canvas/<id>/:
 * item.json (the manifest) plus copies of any files it shows, so the dashboard
 * only ever serves from the inbox. Kinds:
 *   image     one image, or a set (`paths`) such as three comps; `choose: true`
 *             adds a Pick button per image that replies to you in chat
 *   html      a page (file, or `dir` with its assets and an entry file); runs sandboxed
 *   markdown  a brief, plan, or findings (file or inline `content`)
 *   table     rows (inline JSON array of objects, or a .json/.csv file)
 *   url       a local page (http://localhost or 127.0.0.1 only), e.g. an
 *             impeccable decision board or the dev server
 * Re-using an id replaces that item. canvas_clear removes one.
 *
 * bin/launch loads this for every assistant and sets FLEET_AGENT_ID.
 */

import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, realpathSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_FILE = 15 * 1024 * 1024;
const MAX_DIR = 50 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif"]);

const ShowParams = Type.Object({
  id: Type.String({ description: "Short slug for this item, e.g. home-comps. Re-use it to update the item." }),
  title: Type.String({ description: "What the captain is looking at, in a few words" }),
  kind: StringEnum(["image", "html", "markdown", "table", "url"] as const),
  caption: Type.Optional(Type.String({ description: "One or two sentences under the item" })),
  path: Type.Optional(Type.String({ description: "File to show (image, html entry, markdown, table .json/.csv)" })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Image set, shown side by side (e.g. comps)", maxItems: 12 })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "One label per image in paths" })),
  choose: Type.Optional(Type.Boolean({ description: "Image sets: add a Pick button per image; the pick comes back as a chat message" })),
  dir: Type.Optional(Type.String({ description: "html only: folder to copy with its assets; path is the entry file inside it" })),
  content: Type.Optional(Type.String({ description: "Inline markdown, html, or JSON rows for table" })),
  url: Type.Optional(Type.String({ description: "url kind: http://localhost:<port>/... or http://127.0.0.1:<port>/..." })),
});

const ClearParams = Type.Object({ id: Type.String() });

function canvasRoot(): string | null {
  const agent = process.env.FLEET_AGENT_ID;
  const inbox = process.env.FLEET_INBOX?.replace(/^~/, process.env.HOME ?? "");
  if (!agent || !inbox || !/^[a-z][a-z0-9_-]{0,63}$/.test(agent)) return null;
  return join(inbox, agent, "canvas");
}

function slug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
}

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
      if (total > MAX_DIR) return;
    }
  };
  walk(dir);
  return total;
}

function copyIn(src: string, destDir: string, as?: string): string {
  const st = statSync(src);
  if (!st.isFile()) throw new Error(`${src} is not a file`);
  if (st.size > MAX_FILE) throw new Error(`${src} is over 15 MB`);
  const name = as ?? basename(src).replace(/[^A-Za-z0-9._-]+/g, "-");
  copyFileSync(src, join(destDir, name));
  return name;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows = text.trim().split(/\r?\n/).map((l) => l.split(","));
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "canvas_show",
    label: "Show on canvas",
    description:
      "Show the captain something to look at on the dashboard canvas: images or an image set, html, markdown, a table, or a local URL. Re-use an id to update. " +
      "html can send a choice back as a chat message with parent.postMessage({type: 'fleet-canvas', text: '...'}, '*') from a click handler (never on load); it is sandboxed, network only to cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, Google Fonts.",
    parameters: ShowParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = canvasRoot();
      if (!root) return ok("No canvas in this session (FLEET_AGENT_ID or FLEET_INBOX unset). Give the captain the path or URL instead.");
      const cwd = ctx.cwd ?? process.cwd();
      const id = slug(params.id);
      const tmp = join(root, `.${id}.tmp`);
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(tmp, { recursive: true });
      const item: Record<string, unknown> = {
        id,
        title: params.title.slice(0, 120),
        kind: params.kind,
        ...(params.caption ? { caption: params.caption.slice(0, 600) } : {}),
        updated: new Date().toISOString(),
      };
      try {
        switch (params.kind) {
          case "image": {
            const list = params.paths?.length ? params.paths : params.path ? [params.path] : [];
            if (!list.length) throw new Error("image needs path or paths");
            item.images = list.map((p, i) => {
              const src = abs(p, cwd);
              if (!IMAGE_EXT.has(extname(src).toLowerCase())) throw new Error(`${p} is not an image`);
              const file = copyIn(src, tmp, `${String(i + 1).padStart(2, "0")}-${basename(src).replace(/[^A-Za-z0-9._-]+/g, "-")}`);
              return { file, label: params.labels?.[i]?.slice(0, 80) ?? basename(src) };
            });
            if (params.choose) item.choose = true;
            break;
          }
          case "html": {
            if (params.dir) {
              const dir = realpathSync(abs(params.dir, cwd));
              if (dirSize(dir) > MAX_DIR) throw new Error(`${params.dir} is over 50 MB`);
              // Symlinks are left out: a link could point anywhere on disk, and the
              // dashboard serves this folder.
              cpSync(dir, join(tmp, "site"), { recursive: true, filter: (s) => !/\/(node_modules|\.git)(\/|$)/.test(s) && !lstatSync(s).isSymbolicLink() });
              const entry = params.path ?? "index.html";
              if (!existsSync(join(tmp, "site", entry))) throw new Error(`${entry} not found in ${params.dir}`);
              item.entry = `site/${entry}`;
            } else if (params.path) {
              item.entry = copyIn(abs(params.path, cwd), tmp, "index.html");
            } else if (params.content) {
              writeFileSync(join(tmp, "index.html"), params.content, "utf8");
              item.entry = "index.html";
            } else throw new Error("html needs path, dir, or content");
            break;
          }
          case "markdown": {
            const text = params.path ? readFileSync(abs(params.path, cwd), "utf8") : params.content;
            if (!text) throw new Error("markdown needs path or content");
            writeFileSync(join(tmp, "doc.md"), text.slice(0, 2_000_000), "utf8");
            item.file = "doc.md";
            break;
          }
          case "table": {
            let rows: unknown;
            if (params.path) {
              const src = abs(params.path, cwd);
              const text = readFileSync(src, "utf8");
              rows = extname(src).toLowerCase() === ".csv" ? parseCsv(text) : JSON.parse(text);
            } else if (params.content) rows = JSON.parse(params.content);
            if (!Array.isArray(rows)) throw new Error("table needs a JSON array of objects (or a .csv)");
            writeFileSync(join(tmp, "rows.json"), JSON.stringify(rows.slice(0, 2000)), "utf8");
            item.file = "rows.json";
            break;
          }
          case "url": {
            const u = new URL(String(params.url ?? ""));
            if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname)) {
              throw new Error("url must be http://localhost:<port>/... or http://127.0.0.1:<port>/...");
            }
            item.url = u.toString();
            break;
          }
        }
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        return ok(`Not shown: ${e instanceof Error ? e.message : String(e)}`);
      }
      writeFileSync(join(tmp, "item.json"), JSON.stringify(item, null, 2) + "\n", "utf8");
      const dest = join(root, id);
      rmSync(dest, { recursive: true, force: true });
      renameSync(tmp, dest);
      return ok(`Shown on the captain's canvas as "${item.title}" (${id}). Tell them in one line what to look at.${item.choose ? " Their pick arrives as a chat message." : ""}`);
    },
  });

  pi.registerTool({
    name: "canvas_clear",
    label: "Clear canvas item",
    description: "Remove one item from the captain's canvas by id.",
    parameters: ClearParams,
    async execute(_toolCallId, params) {
      const root = canvasRoot();
      if (!root) return ok("No canvas in this session.");
      const dest = join(root, slug(params.id));
      if (!existsSync(dest)) return ok(`No canvas item ${params.id}.`);
      rmSync(dest, { recursive: true, force: true });
      return ok(`Removed ${params.id} from the canvas.`);
    },
  });
}
