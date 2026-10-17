import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { syncCaptainWait, waitDisplaySummary } from "./captain-wait.ts";
import { fleetInboxRoot } from "./paths.ts";
import { collectCaptainHolds, recentFleetSnapshot } from "./fleet-snapshot.ts";

export type CaptainHoldRow = {
  id: string;
  title: string;
  holdReason: string;
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
  displaySummary: string;
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
        if (
          o.kind === "captain-wait" &&
          (o.from === "firstmate" || o.from === "dashboard")
        ) {
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
  const snap = await recentFleetSnapshot();
  if (!snap.ok) {
    return {
      snapshotOk: false,
      snapshotError: snap.error ?? "snapshot unavailable",
      actionableHolds: [],
      captainWait,
      waitingOnYou: Boolean(captainWait),
      displaySummary: captainWait?.summary ?? "",
    };
  }
  const waitHolds = collectCaptainHolds(snap);
  const byId = new Map(snap.backlog.map((r) => [r.id ?? "", r]));
  const actionableHolds: CaptainHoldRow[] = waitHolds.map((h) => {
    const rec = byId.get(h.id);
    return {
      id: h.id,
      title: h.title,
      holdReason: h.holdReason,
      holdAgeDays: rec?.hold_age_days,
      holdBucket: rec?.hold_bucket,
    };
  });
  await syncCaptainWait(waitHolds);
  return {
    snapshotOk: true,
    actionableHolds,
    captainWait,
    waitingOnYou: actionableHolds.length > 0 || Boolean(captainWait),
    displaySummary: waitDisplaySummary(waitHolds, captainWait?.summary),
  };
}
