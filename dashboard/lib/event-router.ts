import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptCrewLine } from "./chat-bridge.ts";
import { allChatTargetIds, chatTarget } from "./chat-targets.ts";
import { sendToFirstmateTui } from "./firstmate-chat.ts";
import { dashLog } from "./log.ts";
import { fleetInboxRoot, nodeStateDir } from "./paths.ts";
import { notifyCaptain } from "./notify.ts";
import { logShipEvent } from "./ship-log.ts";

/**
 * The event router (resilient fleet runtime, R1), in the fleet node.
 *
 * Agents talk through bus files (fleet/inbox/<agent>/events.jsonl), but a line
 * on a bus woke nobody: Firstmate never picked up the designer's design-ship
 * hand-off until the captain prompted it. The router watches every bus and
 * wakes its owner when something actionable lands:
 *
 * - Firstmate is woken through its TUI (fm-send) with a one-line pointer.
 * - Live agents (designers, the Architect, Alice, crewmates) get a message in
 *   their thread from "router", which starts their turn.
 *
 * Rules: never wake an agent for a line it wrote; skip noise (heartbeats, the
 * dashboard's own chat and wait lines); batch lines that arrive close together
 * into one wake (FLEET_ROUTER_BATCH_SECS, default 30); at most
 * FLEET_ROUTER_MAX_PER_HOUR wakes per agent (default 6), the rest waiting for
 * the next hour. Read positions persist in fleet/inbox/.node/router.json, so a
 * restart never replays old lines; a bus seen for the first time starts at its
 * end. Wakes are logged on the fleet ship log (kind "router").
 *
 * An owner that cannot be woken (Firstmate's TUI closed) keeps its lines and is
 * retried every 5 minutes, then hourly after UNREACHABLE_AFTER failures, when
 * the captain gets one notice. Only the first failure, that notice, and the
 * recovery are logged: on 2026-10-22 a hand-off to a Firstmate that had been
 * down for six days wrote the same failure 60 times in nine hours, and nobody
 * was told.
 */

const BATCH_MS = Math.max(5, Number(process.env.FLEET_ROUTER_BATCH_SECS) || 30) * 1000;
const MAX_PER_HOUR = Math.max(1, Number(process.env.FLEET_ROUTER_MAX_PER_HOUR) || 6);
const POLL_MS = 5000;
/** Failed wakes in a row before the captain is told and retries slow to hourly. */
export const UNREACHABLE_AFTER = 3;
/** Lines that never need anyone: liveness, the dashboard's own bookkeeping. */
const NOISE = new Set(["heartbeat", "captain-chat", "captain-wait", "captain-wait-clear"]);

export type BusEvent = { ts?: string; from?: string; kind?: string; summary?: string; ref?: unknown; project?: string; ship?: string; [k: string]: unknown };

/** Does this line on `owner`'s bus need `owner`? */
export function wakes(owner: string, e: BusEvent): boolean {
  if (!e.kind || NOISE.has(e.kind)) return false;
  if (e.from === owner || e.from === "router") return false;
  return true;
}

function refText(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (Array.isArray(ref)) return ref.filter((r) => typeof r === "string").join(", ");
  if (ref && typeof ref === "object") return Object.values(ref).filter((r) => typeof r === "string").slice(0, 3).join(", ");
  return "";
}

function line(e: BusEvent, max = 200): string {
  const ref = refText(e.ref);
  const where = e.project ?? e.ship;
  return `${e.kind} from ${e.from ?? "?"}${where ? ` (${where})` : ""}: ${String(e.summary ?? "").replace(/\s+/g, " ").slice(0, max)}${ref ? ` [${ref.slice(0, 160)}]` : ""}`;
}

/** The wake message for a batch of lines on `owner`'s bus. */
export function wakeText(owner: string, events: BusEvent[], firstmate: boolean): string {
  const bus = `fleet/inbox/${owner}/events.jsonl`;
  if (firstmate) {
    // One line: it is typed into the TUI.
    const head = events.length === 1 ? line(events[0]!, 140) : `${events.length} new lines (${events.map((e) => e.kind).join(", ")})`;
    return `Bus: ${head}. Read ${bus} and act per your role.`;
  }
  return [
    `Event router (automatic, not the captain): new on your bus ${bus}:`,
    ...events.map((e) => `- ${line(e)}`),
    "",
    "Read the lines and act on them per your role. If nothing needs doing, reply in one line.",
  ].join("\n");
}

/** A wake failure's useful part: Firstmate's tools print a framed banner first. */
function firstLines(detail: string): string {
  const lines = detail.split("\n").map((l) => l.replace(/^[\s●━─═|]+|[\s●━─═]+$/g, "")).filter((l) => l && !/^[━─═]+$/.test(l));
  return lines.slice(0, 3).join(" · ").slice(0, 400);
}

type Offsets = Record<string, number>;

function offsetsPath(): string {
  return join(nodeStateDir(), "router.json");
}

function busPath(owner: string): string {
  return join(fleetInboxRoot(), owner, "events.jsonl");
}

export class EventRouter {
  private offsets: Offsets = {};
  private pending = new Map<string, { events: BusEvent[]; timer: ReturnType<typeof setTimeout> | null }>();
  private sent = new Map<string, number[]>();
  /** Failed wakes in a row per owner, and whether the captain was told. */
  private failing = new Map<string, { count: number; told: boolean }>();
  private busy = false;

  constructor(
    private wake: (owner: string, events: BusEvent[]) => Promise<{ ok: boolean; detail: string }>,
    private owners: () => string[],
    private batchMs = BATCH_MS,
    private tell: (summary: string, detail: string) => void = (summary, detail) => void notifyCaptain({ from: "router", kind: "blocked", summary, detail, ref: "health" }),
  ) {
    try {
      this.offsets = JSON.parse(readFileSync(offsetsPath(), "utf8")) as Offsets;
    } catch {
      this.offsets = {};
    }
  }

  private async save(): Promise<void> {
    await mkdir(nodeStateDir(), { recursive: true });
    await writeFile(offsetsPath() + ".tmp", JSON.stringify(this.offsets) + "\n", "utf8");
    await rename(offsetsPath() + ".tmp", offsetsPath());
  }

  /** Read new lines on every bus; queue the actionable ones for a batched wake. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let moved = false;
    try {
      for (const owner of this.owners()) {
        const path = busPath(owner);
        if (!existsSync(path)) continue;
        const size = statSync(path).size;
        const at = this.offsets[owner];
        if (at === undefined || size < at) {
          // First sight (or the file was rewritten): start at the end, never replay history.
          this.offsets[owner] = size;
          moved = true;
          continue;
        }
        if (size === at) continue;
        const fh = await open(path, "r");
        const buf = Buffer.alloc(size - at);
        try {
          await fh.read(buf, 0, buf.length, at);
        } finally {
          await fh.close();
        }
        const text = buf.toString("utf8");
        const end = text.lastIndexOf("\n");
        if (end < 0) continue; // a line still being written
        this.offsets[owner] = at + Buffer.byteLength(text.slice(0, end + 1));
        moved = true;
        for (const raw of text.slice(0, end).split("\n")) {
          let e: BusEvent;
          try {
            e = JSON.parse(raw) as BusEvent;
          } catch {
            continue;
          }
          if (wakes(owner, e)) this.queue(owner, e);
        }
      }
      if (moved) await this.save();
    } finally {
      this.busy = false;
    }
  }

  private queue(owner: string, e: BusEvent): void {
    const p = this.pending.get(owner) ?? { events: [], timer: null };
    p.events.push(e);
    if (!p.timer) p.timer = setTimeout(() => void this.flush(owner), this.batchMs);
    this.pending.set(owner, p);
  }

  /** Wake `owner` with everything queued for it, within the hourly cap. */
  async flush(owner: string): Promise<void> {
    const p = this.pending.get(owner);
    if (!p) return;
    p.timer = null;
    const hour = Date.now() - 3_600_000;
    const recent = (this.sent.get(owner) ?? []).filter((t) => t > hour);
    if (recent.length >= MAX_PER_HOUR) {
      // Over the cap: try again when the oldest wake in the hour ages out.
      p.timer = setTimeout(() => void this.flush(owner), recent[0]! + 3_600_000 - Date.now() + 1000);
      return;
    }
    const events = p.events.splice(0);
    this.pending.delete(owner);
    if (!events.length) return;
    recent.push(Date.now());
    this.sent.set(owner, recent);
    let res: { ok: boolean; detail: string };
    try {
      res = await this.wake(owner, events);
    } catch (err) {
      res = { ok: false, detail: err instanceof Error ? err.message : "wake failed" };
    }
    const kinds = events.map((e) => e.kind).join(", ");
    const payload = { owner, ok: res.ok, kinds: events.map((e) => e.kind), from: [...new Set(events.map((e) => e.from))], detail: firstLines(res.detail).slice(0, 300) };
    const was = this.failing.get(owner);
    await dashLog("router", `${owner} ${res.ok ? "woken" : "not woken"}: ${events.map((e) => e.kind).join(",")} ${firstLines(res.detail).slice(0, 120)}`);
    if (res.ok) {
      this.failing.delete(owner);
      logShipEvent("fleet", "router", "router", `Woke ${owner}: ${kinds}${was ? ` (reachable again after ${was.count} failed tries)` : ""}`, payload);
      return;
    }
    const f = { count: (was?.count ?? 0) + 1, told: was?.told ?? false };
    this.failing.set(owner, f);
    if (f.count === 1) logShipEvent("fleet", "router", "router", `Could not wake ${owner}: ${kinds} (${firstLines(res.detail)}); retrying every 5 minutes`, payload);
    if (f.count >= UNREACHABLE_AFTER && !f.told) {
      f.told = true;
      logShipEvent("fleet", "router", "router", `${owner} is unreachable (${f.count} failed wakes); holding its lines and retrying hourly`, payload);
      this.tell(`${owner} cannot be woken; ${events.length} bus line(s) wait for it`, `The event router could not reach ${owner} ${f.count} times in a row: ${firstLines(res.detail)}\n\nWaiting: ${events.map((e) => line(e, 120)).join("\n")}\n\nThey are delivered when ${owner} is back (retried hourly).`);
    }
    // Keep them for the next attempt (Firstmate's TUI may be closed).
    const back = this.pending.get(owner) ?? { events: [], timer: null };
    back.events.unshift(...events);
    if (!back.timer) back.timer = setTimeout(() => void this.flush(owner), (f.count >= UNREACHABLE_AFTER ? 60 : 5) * 60_000);
    this.pending.set(owner, back);
  }
}

/** Default wake: Firstmate through its TUI, live agents through their thread. */
async function wakeOwner(owner: string, events: BusEvent[]): Promise<{ ok: boolean; detail: string }> {
  if (owner === "firstmate") {
    const r = await sendToFirstmateTui(wakeText(owner, events, true));
    return { ok: r.ok, detail: r.ok ? "fm-send" : (r.stderr || r.stdout || "TUI not reachable").trim() };
  }
  if (!chatTarget(owner)) return { ok: false, detail: `${owner} is not on the rail` };
  const line = await acceptCrewLine(owner, "router", wakeText(owner, events, false));
  return { ok: true, detail: `thread line ${line.ts}` };
}

let router: EventRouter | null = null;

export function startEventRouter(): EventRouter {
  router = new EventRouter(wakeOwner, () => [...new Set(["firstmate", ...allChatTargetIds()])]);
  void router.poll();
  setInterval(() => void router?.poll(), POLL_MS);
  return router;
}

/** Recent wakes for Health (newest first), from the fleet ship log. */
export async function recentWakes(limit = 8): Promise<{ ts: string; summary: string; ok: boolean }[]> {
  const { recentShipEvents } = await import("./ship-log.ts");
  return recentShipEvents("fleet", 400)
    .filter((e) => e.kind === "router")
    .slice(0, limit)
    .map((e) => ({ ts: e.ts, summary: e.summary, ok: e.payload?.ok !== false }));
}
