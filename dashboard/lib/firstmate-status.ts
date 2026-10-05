import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";
import { runFleetSnapshotJson } from "./fleet-snapshot.ts";

export type CaptainHoldRow = {
  id: string;
  title: string;
  holdAgeDays?: number;
  holdBucket?: string;
};

export type CaptainWaitEvent = {
  ts: string;
  summary: string;
  prompt?: string;
};

export type FirstmateWaitStatus = {
  snapshotOk: boolean;
  snapshotError?: string;
  actionableHolds: CaptainHoldRow[];
  captainWait: CaptainWaitEvent | null;
  waitingOnYou: boolean;
};

type SnapshotTask = {
  id?: string;
  title?: string;
  captain_actionable?: boolean;
  hold_bucket?: string;
  hold_age_days?: number;
};

async function readLatestCaptainWait(): Promise<CaptainWaitEvent | null> {
  try {
    const raw = await readFile(
      join(fleetInboxRoot(), "firstmate", "events.jsonl"),
      "utf8",
    );
    const lines = raw.trim().split("\n").filter(Boolean);
    let lastWait: CaptainWaitEvent | null = null;
    for (const line of lines) {
      try {
        const o = JSON.parse(line) as {
          kind?: string;
          ts?: string;
          summary?: string;
          prompt?: string;
          from?: string;
        };
        if (o.kind === "captain-wait-clear") {
          lastWait = null;
          continue;
        }
        if (o.kind === "captain-wait" && o.from === "firstmate") {
          lastWait = {
            ts: o.ts ?? "",
            summary: o.summary ?? "Waiting on captain",
            prompt: o.prompt,
          };
        }
      } catch {
        continue;
      }
    }
    return lastWait;
  } catch {
    /* no bus */
  }
  return null;
}


export async function readFirstmateWaitStatus(): Promise<FirstmateWaitStatus> {
  const captainWait = await readLatestCaptainWait();
  const snap = await runFleetSnapshotJson();
  if (!snap.ok) {
    return {
      snapshotOk: false,
      snapshotError: snap.error ?? "snapshot unavailable",
      actionableHolds: [],
      captainWait,
      waitingOnYou: Boolean(captainWait),
    };
  }
  const actionableHolds: CaptainHoldRow[] = [];
  for (const t of snap.tasks as SnapshotTask[]) {
    if (!t.captain_actionable) continue;
    actionableHolds.push({
      id: String(t.id ?? ""),
      title: String(t.title ?? t.id ?? "captain hold"),
      holdAgeDays: t.hold_age_days,
      holdBucket: t.hold_bucket,
    });
  }
  return {
    snapshotOk: true,
    actionableHolds,
    captainWait,
    waitingOnYou: actionableHolds.length > 0 || Boolean(captainWait),
  };
}
