import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { postBus } from "./bus-post.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * The agents' buses over the node (S3b, vault s3-fleet-state-api): bus_post
 * and bus_read (extensions/bus.ts) replace appending to and reading
 * fleet/inbox/<agent>/events.jsonl with bash, so an agent on another host
 * hands off with no shared disk. The caller is the agent its token names.
 */

type Res = { ok: boolean; message: string; [k: string]: unknown };

const KIND = /^[a-z][a-z0-9-]{1,40}$/;
const EXTRA = ["ref", "ship", "project", "branch"] as const;

export async function busPost(from: string, b: Record<string, unknown>, known: (id: string) => Promise<boolean>): Promise<Res> {
  const to = String(b.to ?? "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(to) || !(await known(to))) return { ok: false, message: `No agent named ${to || "(none)"} to post to.` };
  if (to === from) return { ok: false, message: "That is your own bus; post to the agent the hand-off is for." };
  const kind = String(b.kind ?? "");
  if (!KIND.test(kind)) return { ok: false, message: "A kind: a short lowercase slug, e.g. plan-ready, design-request, handoff." };
  const summary = String(b.summary ?? "").replace(/\s+/g, " ").trim();
  if (summary.length < 5) return { ok: false, message: "A one-line summary of the hand-off." };
  const extra: Record<string, string> = {};
  for (const k of EXTRA) if (typeof b[k] === "string" && b[k]) extra[k] = (b[k] as string).slice(0, 300);
  await postBus(to, { from, kind, summary: summary.slice(0, 600), ...extra });
  return { ok: true, message: `Posted ${kind} to ${to}; the event router wakes it.` };
}

/** The caller's own bus: lines after `since` (an ISO time), newest last, at most `limit`. */
export async function busRead(agent: string, since = "", limit = 30): Promise<Res> {
  let raw = "";
  try {
    raw = await readFile(join(fleetInboxRoot(), agent, "events.jsonl"), "utf8");
  } catch {
    /* no bus yet */
  }
  const lines = raw.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const after = since ? lines.filter((l) => String(l.ts ?? "") > since) : lines;
  const events = after.slice(-Math.min(100, Math.max(1, limit)));
  return { ok: true, message: `${events.length} of ${after.length} line(s) on your bus${since ? ` since ${since}` : ""}.`, events };
}
