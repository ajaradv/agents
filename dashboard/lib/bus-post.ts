import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

/** Append one line to an agent's bus (fleet/inbox/<agent>/events.jsonl); the event router wakes it. */
export async function postBus(owner: string, line: { from: string; kind: string; summary: string; [k: string]: unknown }): Promise<void> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(owner)) return;
  const dir = join(fleetInboxRoot(), owner);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n", "utf8");
}
