import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import { journalDb } from "./journal.ts";
import { dashLog } from "./log.ts";
import type { NeedItem } from "./needs-you.ts";
import { quietState } from "./notify.ts";
import { nodeStateDir } from "./paths.ts";

/**
 * Push notifications for the phone app (D6): when something lands in Needs
 * you (a question, a Go, an interrupting notice, an order that needs the
 * captain, a hold, a failed send), every subscribed device gets a notification
 * that opens Needs you.
 *
 * Web Push with VAPID: the keys are made once and kept in
 * fleet/inbox/.node/vapid.json; subscriptions and what was already pushed live
 * in the journal's database, so a restart neither forgets a device nor pushes
 * an item twice. While the captain has snoozed, nothing is pushed (the item
 * stays in Needs you, and Wake compiles the digest).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub_json TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_sent (item TEXT PRIMARY KEY, ts TEXT NOT NULL);
`;

function db() {
  const d = journalDb();
  d.exec(SCHEMA);
  return d;
}

type Vapid = { publicKey: string; privateKey: string };
let vapid: Vapid | null = null;

/** The VAPID key pair, made on first use. */
export function vapidKeys(): Vapid {
  if (vapid) return vapid;
  const path = join(nodeStateDir(), "vapid.json");
  if (existsSync(path)) vapid = JSON.parse(readFileSync(path, "utf8")) as Vapid;
  else {
    mkdirSync(nodeStateDir(), { recursive: true });
    vapid = webpush.generateVAPIDKeys();
    writeFileSync(path, JSON.stringify(vapid) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  webpush.setVapidDetails(process.env.FLEET_PUSH_CONTACT ?? "mailto:captain@fleet.local", vapid.publicKey, vapid.privateKey);
  return vapid;
}

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

export function validSub(s: unknown): s is PushSub {
  const o = s as PushSub;
  return !!o && typeof o.endpoint === "string" && /^https:\/\//.test(o.endpoint) && typeof o.keys?.p256dh === "string" && typeof o.keys?.auth === "string";
}

export function addSubscription(sub: PushSub, label = ""): void {
  db()
    .query("INSERT INTO push_subs (endpoint, sub_json, label, created) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub_json = excluded.sub_json, label = excluded.label")
    .run(sub.endpoint, JSON.stringify(sub), label.slice(0, 120), new Date().toISOString());
}

export function removeSubscription(endpoint: string): boolean {
  return db().query("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint).changes > 0;
}

export function subscriptions(): { sub: PushSub; label: string }[] {
  return (db().query("SELECT sub_json, label FROM push_subs").all() as { sub_json: string; label: string }[]).map((r) => ({ sub: JSON.parse(r.sub_json) as PushSub, label: r.label }));
}

export type PushMessage = { title: string; body: string; tag: string; url: string };

/** What the notification says for a Needs-you item. */
export function messageFor(item: NeedItem): PushMessage {
  const who = (i: { label?: string; agentId?: string }) => i.label ?? i.agentId ?? "An agent";
  const url = "/needs";
  switch (item.kind) {
    case "question":
      return { title: `${who(item)} asks`, body: (item.questions[0]?.question ?? item.text).slice(0, 180), tag: item.id, url };
    case "go":
      return { title: `Go? (${who(item)})`, body: item.summary.slice(0, 180), tag: item.id, url };
    case "notice": {
      const k = { done: "Done", blocked: "Blocked", decision: "Decision needed", milestone: "Milestone", info: "Note", digest: "Digest" }[item.noticeKind] ?? "Notice";
      return { title: `${k}: ${item.from}`, body: item.summary.slice(0, 180), tag: item.id, url };
    }
    case "order":
      return { title: item.status === "needs-captain" ? "Order paused" : "Order ready for your Go", body: `${item.title}${item.reason ? `: ${item.reason}` : ""}`.slice(0, 180), tag: item.id, url };
    case "hold":
      return { title: "Held for you", body: `${item.title}: ${item.reason}`.slice(0, 180), tag: item.id, url };
    case "failed":
      return { title: `Not delivered to ${who(item)}`, body: item.error.slice(0, 180), tag: item.id, url };
  }
}

/** Send one message to every device; drop devices the push service says are gone. */
export async function sendToAll(msg: PushMessage): Promise<{ sent: number; failed: number }> {
  if (!subscriptions().length) return { sent: 0, failed: 0 };
  vapidKeys();
  let sent = 0;
  let failed = 0;
  for (const { sub } of subscriptions()) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 6 * 3600, urgency: "high", topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined });
      sent++;
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) removeSubscription(sub.endpoint);
      void dashLog("push", `send failed (${code ?? "?"}): ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }
  return { sent, failed };
}

let baselined = false;

/**
 * Push the Needs-you items not pushed before; returns how many were new. The
 * very first call only records what is already there (no burst of old items).
 */
export async function pushNewNeeds(items: NeedItem[]): Promise<number> {
  const d = db();
  const seen = new Set((d.query("SELECT item FROM push_sent").all() as { item: string }[]).map((r) => r.item));
  const fresh = items.filter((i) => !seen.has(i.id));
  const mark = (i: NeedItem) => d.query("INSERT OR IGNORE INTO push_sent (item, ts) VALUES (?, ?)").run(i.id, new Date().toISOString());
  if (!baselined) {
    baselined = true;
    if (seen.size === 0) {
      fresh.forEach(mark);
      return 0;
    }
  }
  if (!fresh.length) return 0;
  fresh.forEach(mark);
  // Snoozed or no device: the items are recorded as seen (they stay in Needs you), nothing is sent.
  if (quietState().snoozed || !subscriptions().length) return fresh.length;
  // Several at once (a burst after a reconnect): one notification that says how many.
  const msg = fresh.length === 1 ? messageFor(fresh[0]!) : { title: `${fresh.length} things need you`, body: fresh.map((i) => messageFor(i).title).join(" · ").slice(0, 180), tag: "needs-batch", url: "/needs" };
  await sendToAll(msg);
  // Keep the sent table small: items long gone from Needs you are forgotten after a week.
  d.query("DELETE FROM push_sent WHERE ts < ?").run(new Date(Date.now() - 7 * 86_400_000).toISOString());
  return fresh.length;
}
