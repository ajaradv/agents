import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostRunning, stopHost } from "./agent-host.ts";
import { agentTuiIsLive } from "./agent-tui-control.ts";
import { fleetInboxRoot } from "./paths.ts";

/**
 * Start a fresh Pi session for an agent with `dashboard_session: persistent`.
 *
 * bin/launch reads fleet/inbox/<id>/sessions/current for the session id, so
 * writing a new id there makes the next turn (or Start TUI) begin empty. The
 * old session file stays on disk. Long sessions are what made every turn
 * expensive: each one re-sends the whole history.
 */
export async function newSession(agentId: string): Promise<{ ok: boolean; message: string; sessionId?: string }> {
  if (hostRunning(agentId)) return { ok: false, message: "It is working. Stop it first, then start a new session." };
  if (await agentTuiIsLive(agentId)) return { ok: false, message: "Its TUI is open on the session. Close the TUI first." };
  await stopHost(agentId);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-").toLowerCase();
  const sessionId = `dashboard-${agentId}-${stamp}`;
  const dir = join(fleetInboxRoot(), agentId, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "current"), sessionId + "\n", "utf8");
  return { ok: true, message: "New session started. The next message begins with an empty history.", sessionId };
}
