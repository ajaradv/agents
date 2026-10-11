import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

export type WaitHold = {
  id: string;
  title: string;
  holdReason: string;
};

type BusEvent = {
  kind?: string;
  from?: string;
  summary?: string;
  prompt?: string;
};

let chain: Promise<void> = Promise.resolve();

function eventsPath(): string {
  return join(fleetInboxRoot(), "firstmate", "events.jsonl");
}

function holdPrompt(holds: WaitHold[]): string {
  return holds
    .map((h) => `${h.id}: ${h.holdReason || h.title}`)
    .join("\n");
}

function holdSummary(holds: WaitHold[]): string {
  if (holds.length === 1) {
    const h = holds[0]!;
    return h.holdReason || h.title || h.id;
  }
  return holds.map((h) => h.holdReason || h.title || h.id).join(" · ");
}

async function readEvents(): Promise<BusEvent[]> {
  try {
    const raw = await readFile(eventsPath(), "utf8");
    const out: BusEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as BusEvent);
      } catch {
        /* skip torn lines */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function openWait(events: BusEvent[]): BusEvent | null {
  let last: BusEvent | null = null;
  for (const ev of events) {
    if (ev.kind === "captain-wait-clear") {
      last = null;
      continue;
    }
    if (
      ev.kind === "captain-wait" &&
      (ev.from === "firstmate" || ev.from === "dashboard")
    ) {
      last = ev;
    }
  }
  return last;
}

async function appendEvent(event: Record<string, string>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  await appendFile(eventsPath(), `${line}\n`, "utf8");
}

async function syncBody(holds: WaitHold[]): Promise<void> {
  const events = await readEvents();
  const current = openWait(events);
  if (holds.length === 0) {
    if (!current) return;
    await appendEvent({
      from: "dashboard",
      kind: "captain-wait-clear",
      summary: "captain hold closed",
    });
    return;
  }
  const prompt = holdPrompt(holds);
  const summary = holdSummary(holds);
  if (current?.prompt === prompt && current.summary === summary) return;
  await appendEvent({
    from: "dashboard",
    kind: "captain-wait",
    summary,
    prompt,
  });
}

/** Keep a captain-wait line open while a live hold exists, and clear it when the hold closes. */
export function syncCaptainWait(holds: WaitHold[]): Promise<void> {
  const run = chain.then(() => syncBody(holds));
  chain = run.catch(() => undefined);
  return run;
}

export function waitDisplaySummary(
  holds: WaitHold[],
  captainSummary?: string,
): string {
  if (holds.length > 0) return holdSummary(holds);
  return captainSummary ?? "";
}
