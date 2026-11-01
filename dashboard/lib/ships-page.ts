import { readdirSync, readFileSync } from "node:fs";
import { aliceVault } from "./paths.ts";
import { escapeHtml } from "./quota.ts";
import { baseDir } from "./ship-config.ts";
import { readerPage, guardVaultPath, resolveWikiLinks } from "./vault-reader.ts";
import { sectionsOf, splitNote } from "./vault-note.ts";

/**
 * The Ships page (vault plan feature/ship-roadmaps, SR4): one card per ship from
 * fleet/ships/*.yaml, read from the ship's roadmap note, ships/<ship>/roadmap.md.
 * Each card links to the full note in the vault reader.
 */

/** A roadmap older than this many days is flagged (the same line ship_next uses). */
export const STALE_DAYS = 8;

export type ShipCard = {
  ship: string;
  /** False when ships/<ship>/roadmap.md does not exist. */
  found: boolean;
  summary: string;
  updated: string;
  /** Whole days since `updated`; null when the note has no readable date. */
  days: number | null;
  stale: boolean;
  now: string;
  next: string[];
  questions: string;
};

/** The ships in fleet/ships, by id. */
export function shipIds(): string[] {
  try {
    return readdirSync(baseDir()).filter((n) => n.endsWith(".yaml")).map((n) => n.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

/** The text under a level-2 heading that starts with `name`, subsections included. */
function section(body: string, name: RegExp): string {
  const s = sectionsOf(body).find((h) => h.level === 2 && name.test(h.heading));
  if (!s) return "";
  const text = body.slice(s.start, s.treeEnd);
  return text.slice(text.indexOf("\n") + 1).trim();
}

/** The first `n` top-level list items (numbered or bulleted), each with its continuation lines. */
function firstItems(text: string, n: number): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    if (/^(?:[-*]|\d+[.)])\s/.test(line)) items.push(line.replace(/^(?:[-*]|\d+[.)])\s+/, ""));
    else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items.slice(0, n);
}

const dateOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : v === undefined || v === null ? "" : String(v));

// TODO(SR1): use lib/roadmap.ts (the shared parser behind ship_next) instead of slicing sections here.
export function readShipCard(ship: string, vault = aliceVault(), now = Date.now()): ShipCard {
  const empty: ShipCard = { ship, found: false, summary: "", updated: "", days: null, stale: false, now: "", next: [], questions: "" };
  const g = guardVaultPath(`ships/${ship}/roadmap.md`, vault);
  if (!g || g.dir) return empty;
  const { fm, body } = splitNote(readFileSync(g.file, "utf8"));
  const updated = dateOf(fm?.updated);
  const t = Date.parse(updated);
  const days = Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 86_400_000));
  return {
    ship,
    found: true,
    summary: fm?.summary ? String(fm.summary) : "",
    updated,
    days,
    stale: days === null || days > STALE_DAYS,
    now: section(body, /^now\b/i),
    next: firstItems(section(body, /^next up\b/i), 3),
    questions: section(body, /^open questions\b/i),
  };
}

const md = (text: string) => Bun.markdown.html(resolveWikiLinks(text, []));

function badge(c: ShipCard): string {
  if (!c.found) return `<span class="chip warn">no roadmap yet</span>`;
  if (c.days === null) return `<span class="chip warn">updated: unknown</span>`;
  return `<span class="chip${c.stale ? " warn" : ""}">updated ${c.days === 0 ? "today" : c.days === 1 ? "1 day ago" : `${c.days} days ago`}</span>`;
}

export function shipCardHtml(c: ShipCard): string {
  const link = `/vault/ships/${encodeURIComponent(c.ship)}/roadmap.md`;
  const part = (label: string, html: string) => (html ? `<h3>${label}</h3>${html}` : "");
  const next = c.next.length ? `<ol>${c.next.map((i) => `<li>${Bun.markdown.html(resolveWikiLinks(i, [])).replace(/^<p>|<\/p>\s*$/g, "")}</li>`).join("")}</ol>` : "";
  const body = c.found
    ? `${c.summary ? `<p>${escapeHtml(c.summary)}</p>` : ""}${part("Now", md(c.now))}${part("Next up", next)}${part("Open questions", md(c.questions))}<a class="more" href="${link}">Full roadmap</a>`
    : `<p class="muted">The Architect has not written ships/${escapeHtml(c.ship)}/roadmap.md yet.</p>`;
  return `<section class="card"><h2>${escapeHtml(c.ship)}</h2><div class="meta">${badge(c)}</div>${body}</section>`;
}

export function shipsPageResponse(vault = aliceVault(), now = Date.now()): Response {
  const cards = shipIds().map((id) => shipCardHtml(readShipCard(id, vault, now)));
  return readerPage("Ships", `<h1>Ships</h1><div class="cards">${cards.join("") || `<p class="muted">No ships configured.</p>`}</div>`, { active: "ships", wide: true });
}
