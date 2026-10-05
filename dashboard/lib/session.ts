import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

export type SessionInfo = {
  pid: number;
  agent: string;
  model?: string;
  started?: string;
  backend?: string;
  herdr_session?: string;
  herdr_workspace_id?: string;
  herdr_pane_id?: string;
};

export async function readSession(agentId: string): Promise<SessionInfo | null> {
  try {
    const raw = await readFile(
      join(fleetInboxRoot(), agentId, "session.json"),
      "utf8",
    );
    return JSON.parse(raw) as SessionInfo;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
