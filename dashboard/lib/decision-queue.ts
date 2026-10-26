import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nodeStateDir } from "./paths.ts";

/**
 * The captain's decision queue (vault plan fleet/plans/feature/design-sessions):
 * every design and spec decision, in one ordered list the captain works
 * through with the flagship's designer and architect. Ships deliver only what
 * the queue decided; chores sail without it.
 *
 * Kinds: a design session (designer) and a spec session (architect) run on a
 * ship's rigged copy (lib/sessions.ts); spec and design reviews are decisions
 * on something already written (D2, D3).
 */

export const QUEUE_KINDS = ["design-session", "spec-session", "spec-review", "design-review"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];
export type QueueStatus = "queued" | "active" | "done" | "done-without-brief" | "dropped";

export type QueueItem = {
  id: string;
  kind: QueueKind;
  ship: string;
  title: string;
  /** What the captain (or whoever asked) wants decided, in their words. */
  request: string;
  status: QueueStatus;
  by: string;
  created: string;
  updated: string;
  /** The session's record (vault voyage note) once it starts. */
  record?: string;
};

const path = () => join(nodeStateDir(), "decision-queue.json");
const ID_RE = /^q[0-9a-z]{6,12}$/;

export function readQueue(): QueueItem[] {
  try {
    const j = JSON.parse(readFileSync(path(), "utf8")) as { items?: QueueItem[] };
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueItem[]): void {
  mkdirSync(dirname(path()), { recursive: true });
  const tmp = `${path()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ items }, null, 2) + "\n");
  renameSync(tmp, path());
}

/** Open items in the captain's order (the list order), then the finished ones, newest first. */
export function queueView(items = readQueue()): { open: QueueItem[]; done: QueueItem[] } {
  const open = items.filter((i) => i.status === "queued" || i.status === "active");
  const done = items.filter((i) => !open.includes(i)).sort((a, b) => b.updated.localeCompare(a.updated));
  return { open, done };
}

export function addQueueItem(b: { kind: string; ship: string; title: string; request?: string; by?: string }): { ok: true; item: QueueItem } | { ok: false; message: string } {
  if (!QUEUE_KINDS.includes(b.kind as QueueKind)) return { ok: false, message: `Kind is one of ${QUEUE_KINDS.join(", ")}.` };
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(b.ship)) return { ok: false, message: "Name the ship." };
  const title = b.title.trim().replace(/\s+/g, " ").slice(0, 160);
  if (title.length < 4) return { ok: false, message: "Give it a title (what is to be decided)." };
  const now = new Date().toISOString();
  const item: QueueItem = { id: `q${Date.now().toString(36)}`, kind: b.kind as QueueKind, ship: b.ship, title, request: (b.request ?? "").trim().slice(0, 4000), status: "queued", by: b.by || "captain", created: now, updated: now };
  writeQueue([...readQueue(), item]);
  return { ok: true, item };
}

export function updateQueueItem(id: string, patch: Partial<Pick<QueueItem, "status" | "record" | "title" | "request">>): QueueItem | null {
  if (!ID_RE.test(id)) return null;
  const items = readQueue();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  items[i] = { ...items[i]!, ...patch, updated: new Date().toISOString() };
  writeQueue(items);
  return items[i]!;
}

/** Move an open item up or down the captain's order. */
export function moveQueueItem(id: string, dir: "up" | "down"): boolean {
  const items = readQueue();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const open = (x: QueueItem) => x.status === "queued" || x.status === "active";
  let j = i;
  do j += dir === "up" ? -1 : 1;
  while (j >= 0 && j < items.length && !open(items[j]!));
  if (j < 0 || j >= items.length) return false;
  [items[i], items[j]] = [items[j]!, items[i]!];
  writeQueue(items);
  return true;
}

/** A session wrapped up: its queue item is done (lib/shipyard.ts dockVoyage). */
export function finishQueueItem(record: string, status: "done" | "done-without-brief"): void {
  const item = readQueue().find((i) => i.record === record && i.status === "active");
  if (item) updateQueueItem(item.id, { status });
}
