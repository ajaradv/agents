import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatLine } from "./chat.ts";
import { frontmatter } from "./fleet-layers.ts";
import { jevAsk, type Question } from "./jev.ts";
import { journalDb } from "./journal.ts";
import { dashLog } from "./log.ts";
import { ROOT } from "./paths.ts";
import { redact } from "./redact.ts";
import { baseDir, readShipConfig } from "./ship-config.ts";

/**
 * Intent routing (vault plan alice-memory-and-tools, M3): when the captain
 * writes to Alice, Jev says who should own the message: Alice herself, the
 * Architect, the Designer, or a ship's lead. Observe mode only, like the
 * compaction advisor: it never changes routing, fails quiet, and logs every
 * verdict in journal.db (intent_routes). The captain labels the right owner
 * later (bin/fleet-axi intents label), which measures the confidence
 * thresholds and becomes the labelled set a local classifier needs.
 * FLEET_INTENT_ROUTE=off turns it off.
 */

export type IntentOption = { name: string; criteria: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function roleDescription(role: string): string | null {
  try {
    const d = frontmatter(readFileSync(join(ROOT, "roles", `${role}.md`), "utf8"))?.description;
    return typeof d === "string" && d.trim() ? clip(d.trim().replace(/\s+/g, " "), 220) : null;
  } catch {
    return null;
  }
}

/** Ships whose crew has a lead (the lead agent is `<ship>-lead`). */
export function shipsWithLead(): string[] {
  try {
    return readdirSync(baseDir())
      .filter((n) => n.endsWith(".yaml"))
      .map((n) => n.slice(0, -5))
      .filter((id) => {
        const crew = readShipConfig(id)?.crew;
        return Array.isArray(crew) && crew.includes("lead");
      })
      .sort();
  } catch {
    return [];
  }
}

/** The owners a message can go to, built from the roles and ships that exist now. */
export function intentOptions(): IntentOption[] {
  const out: IntentOption[] = [{ name: "alice", criteria: "Fleet status, numbers, the vault, memory, orders, chat, and anything that fits no other owner" }];
  for (const [role, fallback] of [["architect", "Design or plan a feature or system before it is built"], ["designer", "How something looks: UI, layout, visuals, images"]] as const) {
    if (existsSync(join(ROOT, "roles", `${role}.md`))) out.push({ name: role, criteria: roleDescription(role) ?? fallback });
  }
  for (const ship of shipsWithLead()) out.push({ name: `${ship}-lead`, criteria: `Work on the ${ship} ship's code or voyage` });
  return out;
}

export const intentMode = (): "observe" | "off" => (process.env.FLEET_INTENT_ROUTE === "off" ? "off" : "observe");

export type IntentVerdict = { choice: string; confidence: number; probabilities: Record<string, number> };

/** Ask Jev who should own the message, and log the verdict. Never throws. */
export async function routeIntent(agent: string, line: { ts: string; text: string }, ask: typeof jevAsk = jevAsk): Promise<{ ok: boolean; verdict?: IntentVerdict; error?: string }> {
  const options = intentOptions();
  const criteria: Record<string, string> = {};
  for (const o of options) criteria[o.name] = o.criteria;
  const state = { message: clip(redact(line.text), 1500), ships: options.filter((o) => o.name.endsWith("-lead")).map((o) => o.name.slice(0, -5)) };
  const r = await ask("intent-route", state, { owner: { type: "choice", instructions: "Who should own `message`? Pick the owner whose criteria fit what the captain is asking for.", criteria } satisfies Question });
  if (!r.ok) return { ok: false, error: r.error };
  const a = r.answers.owner;
  if (!a || a.type !== "choice") return { ok: false, error: "no choice in the answer" };
  const verdict = { choice: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  try {
    journalDb().query("INSERT INTO intent_routes (ts, agent, line_ts, excerpt, choice, confidence, probabilities) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      new Date().toISOString(), agent, line.ts, clip(redact(line.text).replace(/\s+/g, " "), 200), verdict.choice, verdict.confidence, JSON.stringify(verdict.probabilities),
    );
  } catch (e) {
    console.error("[intent-route] log:", e instanceof Error ? e.message : e);
  }
  return { ok: true, verdict };
}

const seen = new Set<string>();

/** Fire and forget from the chat bridge: only the captain's chat lines to Alice; a retry of the same line is not asked twice. */
export function observeIntent(agentId: string, line: ChatLine): void {
  if (agentId !== "alice" || line.kind !== "chat" || line.from !== "captain" || intentMode() === "off") return;
  const key = `${agentId}|${line.ts}`;
  if (seen.has(key) || !line.text.trim()) return;
  seen.add(key);
  if (seen.size > 500) seen.delete(seen.values().next().value as string);
  routeIntent(agentId, line).then(
    (r) => {
      if (!r.ok) void dashLog("intent-route", `no verdict: ${r.error}`);
    },
    () => {},
  );
}

export type IntentRow = { id: number; ts: string; agent: string; line_ts: string; excerpt: string; choice: string; confidence: number; label: string | null; labelled_at: string | null };

/** Confidence buckets for the thresholds measurement. */
export const BUCKETS = [
  { name: "<0.6", min: 0, max: 0.6 },
  { name: "0.6-0.8", min: 0.6, max: 0.8 },
  { name: "0.8-0.9", min: 0.8, max: 0.9 },
  { name: ">=0.9", min: 0.9, max: 1.01 },
] as const;

export type IntentReport = {
  total: number;
  rows: IntentRow[];
  perChoice: Record<string, number>;
  buckets: { bucket: string; count: number; labelled: number; right: number; accuracy: number | null }[];
};

/** Recent verdicts and the summary: per choice, per confidence bucket, and accuracy where the captain has labelled. */
export function intentReport(opts: { days?: number; unlabelledOnly?: boolean; limit?: number } = {}): IntentReport {
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000).toISOString();
  const all = journalDb().query("SELECT id, ts, agent, line_ts, excerpt, choice, confidence, label, labelled_at FROM intent_routes WHERE ts >= ? ORDER BY id DESC").all(since) as IntentRow[];
  const perChoice: Record<string, number> = {};
  for (const r of all) perChoice[r.choice] = (perChoice[r.choice] ?? 0) + 1;
  const buckets = BUCKETS.map((b) => {
    const inB = all.filter((r) => r.confidence >= b.min && r.confidence < b.max);
    const lab = inB.filter((r) => r.label !== null);
    const right = lab.filter((r) => r.label === r.choice).length;
    return { bucket: b.name, count: inB.length, labelled: lab.length, right, accuracy: lab.length ? Math.round((right / lab.length) * 100) / 100 : null };
  });
  const shown = opts.unlabelledOnly ? all.filter((r) => r.label === null) : all;
  return { total: all.length, rows: shown.slice(0, opts.limit ?? 30), perChoice, buckets };
}

/** The captain's label: the right owner, one of the option names now. Stored as given. */
export function labelIntent(id: number, owner: string): { ok: boolean; message: string } {
  const names = intentOptions().map((o) => o.name);
  if (!names.includes(owner)) return { ok: false, message: `${owner} is not an owner; options: ${names.join(", ")}` };
  const r = journalDb().query("UPDATE intent_routes SET label = ?, labelled_at = ? WHERE id = ?").run(owner, new Date().toISOString(), id);
  return r.changes ? { ok: true, message: `verdict ${id} labelled ${owner}` } : { ok: false, message: `no verdict with id ${id}` };
}
