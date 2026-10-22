import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./paths.ts";

/**
 * Messages refused because the recipient had spent its daily budget, held for
 * delivery once the budget allows again (the next day, or as soon as the
 * captain raises it). Before this, a refused crew message only left an error
 * in the recipient's own thread: on 2026-10-19 a lead handed fleet-builder
 * its last task after the builder's $3.00 was spent, and the voyage sat for
 * two days with nobody told.
 *
 * One small JSON file (fleet/inbox/.node/budget-held.json): the chat line
 * stays in the recipient's thread; this keeps only which lines to deliver.
 */

export type Held = { agent: string; ts: string; from: string; heldAt: string };
type State = { held: Held[]; notified: Record<string, string> };

function file(): string {
  return join(process.env.FLEET_INBOX || join(ROOT, "fleet", "inbox"), ".node", "budget-held.json");
}

function read(): State {
  try {
    const s = JSON.parse(readFileSync(file(), "utf8")) as Partial<State>;
    return { held: Array.isArray(s.held) ? s.held : [], notified: s.notified ?? {} };
  } catch {
    return { held: [], notified: {} };
  }
}

function write(s: State): void {
  const f = file();
  if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
}

/**
 * Hold one refused line. `fresh` is false when it was already held (a retry
 * refused again); `tellCaptain` is true once per agent per day, so a busy lead
 * does not fill Needs you with the same news.
 */
export function holdForBudget(agent: string, line: { ts: string; from: string }, now = new Date()): { fresh: boolean; tellCaptain: boolean } {
  const s = read();
  const fresh = !s.held.some((h) => h.agent === agent && h.ts === line.ts);
  if (fresh) s.held.push({ agent, ts: line.ts, from: line.from, heldAt: now.toISOString() });
  const day = now.toISOString().slice(0, 10);
  const tellCaptain = s.notified[agent] !== day;
  if (tellCaptain) s.notified[agent] = day;
  write(s);
  return { fresh, tellCaptain };
}

export function heldLines(): Held[] {
  return read().held;
}

/**
 * Deliver every held line whose agent is under budget again. `refusal` is the
 * same check the bridge makes before a turn; `deliver` queues the line (it is
 * checked once more when its turn comes). Returns what was released.
 */
export async function releaseHeld(refusal: (agent: string) => Promise<string | null>, deliver: (h: Held) => Promise<void>): Promise<Held[]> {
  const s = read();
  if (!s.held.length) return [];
  const out: Held[] = [];
  const keep: Held[] = [];
  const open = new Map<string, boolean>();
  for (const h of s.held) {
    if (!open.has(h.agent)) open.set(h.agent, !(await refusal(h.agent).catch(() => "check failed")));
    if (open.get(h.agent)) out.push(h);
    else keep.push(h);
  }
  if (!out.length) return [];
  // Write first: a crash mid-delivery must not deliver twice.
  write({ ...s, held: keep });
  for (const h of out) await deliver(h).catch(() => {});
  return out;
}
