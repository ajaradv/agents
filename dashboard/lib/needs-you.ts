import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WaitHold } from "./captain-wait.ts";
import { readCaptainChat, type ChatLine, type ChatQuestion } from "./chat.ts";
import { listChatTargets, type ChatTarget } from "./chat-targets.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Needs you: everything waiting on the captain, in one list.
 *
 * - question: an agent asked and nothing came after. `live` means its tool is
 *   blocked on this exact dialog right now (answers go back through it);
 *   otherwise the answer is sent as the next message.
 * - hold: a Firstmate task held for a captain decision before it ships.
 * - failed: the captain's last message to an agent did not go through.
 *
 * Questions that are no longer live and failed sends can be dismissed; holds
 * are answered or stay.
 */

type Who = { agentId: string; label: string; art: string | null; ship?: string };

export type NeedItem =
  | (Who & { kind: "question"; id: string; ts: string; text: string; questions: ChatQuestion[]; dialog?: { id: string; method: string }; live: boolean })
  | { kind: "hold"; id: string; taskId: string; title: string; reason: string }
  | (Who & { kind: "failed"; id: string; ts: string; error: string; sentText: string; sentTs: string });

const KIND_ORDER = { question: 0, hold: 1, failed: 2 } as const;

function who(t: ChatTarget): Who {
  return { agentId: t.id, label: t.label, art: t.art, ...(t.ship ? { ship: t.ship } : {}) };
}

/**
 * What one thread is waiting on, from its newest lines. A question counts
 * while it is the newest line, or while the agent's tool is still blocked on
 * that dialog (`waitingDialog`). A failed send counts while the error is the
 * newest line and the agent said nothing between the message and the error
 * (an error after a reply is a hiccup at the end of the turn, not a lost message).
 */
export function pendingInThread(t: ChatTarget, lines: ChatLine[], waitingDialog: boolean): NeedItem | null {
  const last = lines[lines.length - 1];
  if (!last) return null;
  if (waitingDialog) {
    const q = [...lines].reverse().find((l) => l.kind === "question" && l.dialog);
    const answered = q && lines.some((l) => l.kind === "answer" && l.ref === q.ts);
    if (q && !answered) return questionItem(t, q, true);
  }
  if (last.kind === "question" && last.questions?.length) return questionItem(t, last, false);
  if (last.kind === "error") {
    const at = last.ref ? lines.findIndex((l) => l.ts === last.ref && l.from === "captain") : -1;
    const sent = lines[at];
    if (!sent) return null;
    if (lines.slice(at + 1, -1).some((l) => l.from === t.id && (l.kind === "chat" || l.kind === "question"))) return null;
    return { ...who(t), kind: "failed", id: `failed:${t.id}:${last.ts}`, ts: last.ts, error: last.text, sentText: sent.text, sentTs: sent.ts };
  }
  return null;
}

function questionItem(t: ChatTarget, q: ChatLine, live: boolean): NeedItem {
  return {
    ...who(t),
    kind: "question",
    id: `question:${t.id}:${q.ts}`,
    ts: q.ts,
    text: q.text,
    questions: q.questions ?? [],
    ...(q.dialog && live ? { dialog: { id: q.dialog.id, method: q.dialog.method } } : {}),
    live,
  };
}

export function holdItems(holds: WaitHold[]): NeedItem[] {
  return holds.map((h) => ({ kind: "hold", id: `hold:${h.id}`, taskId: h.id, title: h.title || h.id, reason: h.holdReason }));
}

/** Questions first (an agent is blocked), then holds, then failed sends; newest first within each. */
export function sortNeeds(items: NeedItem[]): NeedItem[] {
  const ts = (i: NeedItem) => ("ts" in i ? i.ts : "");
  return [...items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || ts(b).localeCompare(ts(a)));
}

function dismissedPath(): string {
  return join(fleetInboxRoot(), ".needs-you", "dismissed.json");
}

async function readDismissed(): Promise<string[]> {
  try {
    const j = JSON.parse(await readFile(dismissedPath(), "utf8")) as unknown;
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Hide a question nobody is blocked on, or a failed send, from the list. */
export async function dismissNeed(id: string): Promise<boolean> {
  if (!/^(question|failed):[a-z][a-z0-9_-]{0,63}:[0-9T:.Z-]{10,40}$/.test(id)) return false;
  const list = await readDismissed();
  if (!list.includes(id)) list.push(id);
  const path = dismissedPath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path + ".tmp", JSON.stringify(list.slice(-500)) + "\n", "utf8");
  await rename(path + ".tmp", path);
  return true;
}

export async function collectNeedsYou(opts: { waiting: (agentId: string) => boolean; holds: WaitHold[] }): Promise<NeedItem[]> {
  const { agents, workers } = listChatTargets();
  const dismissed = new Set(await readDismissed());
  const threads = await Promise.all(
    agents.concat(workers).map(async (t) => pendingInThread(t, await readCaptainChat(t.id, 12).catch(() => []), opts.waiting(t.id))),
  );
  const items = threads
    .filter((i): i is NeedItem => i !== null)
    .filter((i) => (i.kind === "question" && i.live) || !dismissed.has(i.id));
  return sortNeeds(items.concat(holdItems(opts.holds)));
}
