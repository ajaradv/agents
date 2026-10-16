import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { escapeHtml } from "./quota.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * What the fleet's models actually cost, for the usage panel.
 *
 * - API lanes (DeepSeek, OpenRouter, ...): Pi records real token counts and
 *   dollar cost on every assistant message in its session files.
 * - Cursor (pi-cursor-sdk): Pi's numbers for Cursor are near zero, because each
 *   Pi turn becomes a Cursor agent run whose first message replays the whole Pi
 *   session as text. Cursor's own transcripts under ~/.cursor/projects show the
 *   real shape, so input is estimated from them: every model step carries the
 *   context so far (about 4 characters per token). It is an upper bound, before
 *   Cursor's caching. Cursor's dashboard has the billed numbers.
 *
 * Headless turns run with --no-session leave no Pi file, so they are not counted.
 */

export type SpendRow = {
  who: string;
  lane: string;
  todayUsd: number;
  weekUsd: number;
  todayTokens: number;
  weekTokens: number;
  estimated: boolean;
  /** Prompt tokens over the week, and how many of them the provider read from its cache. */
  weekPrompt?: number;
  weekCacheRead?: number;
};

const DAY_MS = 86_400_000;
const CACHE_MS = 5 * 60_000;
let cache: { at: number; rows: SpendRow[] } | null = null;

/** ~/.pi/agent/sessions/--Users-me-Workspace-agents-fleet-home-- → "fleet-home". */
function whoFromDir(dir: string): string {
  const name = basename(dir);
  const inbox = fleetInboxRoot();
  if (dirname(dirname(dir)) === inbox && name === "sessions") return basename(dirname(dir));
  const clean = name.replace(/^-+|-+$/g, "").replace(/^Users-[^-]+-/, "").replace(/^Workspace-/, "");
  if (clean.endsWith("agents-fleet-home")) return "firstmate";
  if (clean === "brain") return "alice / architect (vault)";
  if (clean === "agents") return "repo (shipwright, designer)";
  return clean || name;
}

async function filesUnder(dir: string, depth: number, since: number): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory() && depth > 0) out.push(...(await filesUnder(full, depth - 1, since)));
    else if (st.isFile() && name.endsWith(".jsonl") && st.mtimeMs >= since) out.push(full);
  }
  return out;
}

type Acc = Map<string, SpendRow>;

function add(acc: Acc, who: string, lane: string, estimated: boolean, ts: number, now: number, usd: number, tokens: number, cache?: { prompt: number; read: number }) {
  if (now - ts > 7 * DAY_MS) return;
  const key = `${who}\u0000${lane}`;
  const row = acc.get(key) ?? { who, lane, todayUsd: 0, weekUsd: 0, todayTokens: 0, weekTokens: 0, estimated };
  row.weekUsd += usd;
  row.weekTokens += tokens;
  if (cache) {
    row.weekPrompt = (row.weekPrompt ?? 0) + cache.prompt;
    row.weekCacheRead = (row.weekCacheRead ?? 0) + cache.read;
  }
  if (now - ts < DAY_MS) {
    row.todayUsd += usd;
    row.todayTokens += tokens;
  }
  acc.set(key, row);
}

/** Pi session file: real usage on assistant messages from non-Cursor providers. */
export function addPiSession(acc: Acc, who: string, text: string, now: number) {
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"') || line.includes('"provider":"cursor"')) continue;
    let e: { timestamp?: string; message?: { role?: string; provider?: string; model?: string; usage?: Record<string, unknown> } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e.message;
    if (m?.role !== "assistant" || !m.usage || !m.provider) continue;
    const u = m.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
    const tokens = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    const ts = Date.parse(e.timestamp ?? "") || now;
    const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    add(acc, who, `${m.provider}/${m.model ?? "?"}`, false, ts, now, u.cost?.total ?? 0, tokens, { prompt, read: u.cacheRead ?? 0 });
  }
}

/** Share of prompt tokens read from cache, or null with too little to judge. */
export function cacheShare(r: SpendRow): number | null {
  return r.weekPrompt && r.weekPrompt >= 20_000 ? (r.weekCacheRead ?? 0) / r.weekPrompt : null;
}

/** Cursor agent transcript: estimated input, each assistant step carrying the context so far. */
export function cursorRunTokens(text: string): number {
  let ctx = 0;
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    ctx += Math.ceil(line.length / 4);
    if (line.startsWith('{"role":"assistant"')) total += ctx;
  }
  return total;
}

async function collect(now: number): Promise<SpendRow[]> {
  const since = now - 7 * DAY_MS;
  const acc: Acc = new Map();
  const home = homedir();

  const piDirs = [join(home, ".pi", "agent", "sessions")];
  try {
    for (const id of await readdir(fleetInboxRoot())) piDirs.push(join(fleetInboxRoot(), id, "sessions"));
  } catch {
    /* no inbox */
  }
  for (const root of piDirs) {
    for (const f of await filesUnder(root, root.endsWith("sessions") && root.includes(".pi") ? 1 : 0, since)) {
      try {
        addPiSession(acc, whoFromDir(dirname(f)), await readFile(f, "utf8"), now);
      } catch {
        /* unreadable */
      }
    }
  }

  const cursorRoot = join(home, ".cursor", "projects");
  let projects: string[] = [];
  try {
    projects = await readdir(cursorRoot);
  } catch {
    /* no cursor */
  }
  for (const p of projects) {
    if (p.startsWith("private-tmp") || p.startsWith("private-var")) continue;
    for (const f of await filesUnder(join(cursorRoot, p, "agent-transcripts"), 1, since)) {
      try {
        const [text, st] = await Promise.all([readFile(f, "utf8"), stat(f)]);
        // pi-cursor-sdk runs are agent-<uuid>.jsonl; other transcripts are Cursor IDE/CLI chats.
        const sdk = basename(f).startsWith("agent-");
        add(acc, sdk ? whoFromDir(p) : "you (Cursor IDE / CLI chats)", "cursor (estimated)", true, st.mtimeMs, now, 0, cursorRunTokens(text));
      } catch {
        /* unreadable */
      }
    }
  }

  return [...acc.values()].filter((r) => r.weekTokens > 0).sort((a, b) => b.weekUsd - a.weekUsd || b.weekTokens - a.weekTokens);
}

export async function modelSpend(): Promise<SpendRow[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.rows;
  cache = { at: now, rows: await collect(now) };
  return cache.rows;
}

function tok(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function usd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : "$0";
}

/** Rows grouped by who, the costliest agent first; a group lists its models by cost. */
export function groupSpendRows(rows: SpendRow[]): SpendRow[] {
  const byWho = new Map<string, SpendRow[]>();
  for (const r of rows) byWho.set(r.who, [...(byWho.get(r.who) ?? []), r]);
  const weight = (list: SpendRow[]) => list.reduce((n, r) => n + r.weekUsd, 0) * 1e9 + list.reduce((n, r) => n + r.weekTokens, 0);
  return [...byWho.values()]
    .sort((a, b) => weight(b) - weight(a))
    .flatMap((list) => list.sort((a, b) => b.weekUsd - a.weekUsd || b.weekTokens - a.weekTokens));
}

export async function modelSpendHtml(): Promise<string> {
  const rows = groupSpendRows(await modelSpend());
  if (!rows.length) return "";
  // Past Junie rows (until 2026-10-14) billed in subscription credits, which Pi records as $0.
  const credits = (r: SpendRow) => r.lane.startsWith("junie/");
  const cell = (r: SpendRow, day: boolean) => {
    const t = tok(day ? r.todayTokens : r.weekTokens);
    if (r.estimated) return `~${t} tok`;
    if (credits(r)) return `credits <span class="muted">${t}</span>`;
    return `${usd(day ? r.todayUsd : r.weekUsd)} <span class="muted">${t}</span>`;
  };
  const billed = rows.filter((r) => !r.estimated && !credits(r));
  const sum = (day: boolean) => billed.reduce((n, r) => n + (day ? r.todayUsd : r.weekUsd), 0);
  return `<div class="stack">
      <h3>Model spend · last 7 days</h3>
      <table class="spend-table">
        <thead><tr><th>Who</th><th>Model</th><th>24h</th><th>7 days</th><th title="Share of prompt tokens served from the provider's cache over 7 days. Long-running agents should sit well above half; low means cache bugs or a provider that does not cache.">Cached</th></tr></thead>
        <tbody>${rows
          .map((r, i) => {
            const first = i === 0 || rows[i - 1]!.who !== r.who;
            const share = cacheShare(r);
            const cached = share === null ? `<span class="muted">${r.lane.startsWith("cursor") ? "no cache" : "–"}</span>` : `<span class="${share < 0.5 ? "warn" : ""}">${Math.round(share * 100)}%</span>`;
            return `<tr class="${first ? "spend-group" : ""}"><td>${first ? escapeHtml(r.who) : ""}</td><td>${escapeHtml(r.lane)}</td><td>${cell(r, true)}</td><td>${cell(r, false)}</td><td>${cached}</td></tr>`;
          })
          .join("")}</tbody>
        <tfoot><tr><th colspan="2">Billed total (API keys)</th><th>${usd(sum(true))}</th><th>${usd(sum(false))}</th><th></th></tr></tfoot>
      </table>
      <p class="muted spend-note">API rows are billed cost from Pi's session logs. Cursor rows are estimated input tokens from Cursor's transcripts (upper bound, before caching); Cursor's dashboard has the billed figures. Headless turns without a saved session are not counted.</p>
    </div>`;
}
