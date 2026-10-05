/**
 * Appends a Firstmate bus heartbeat on every agent_settled so the dashboard
 * can show liveness without prompting the model.
 *
 * Usage: pi -e extensions/fleet-dashboard-heartbeat.ts (Firstmate launch only)
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function fleetInboxFirstmateEvents(): string {
  const inbox = process.env.FLEET_INBOX;
  if (inbox) {
    return join(inbox.replace(/^~/, process.env.HOME ?? ""), "firstmate", "events.jsonl");
  }
  const fm = process.env.FM_HOME || process.cwd();
  return join(fm, "..", "inbox", "firstmate", "events.jsonl");
}

function appendHeartbeat(state: string): void {
  const path = fleetInboxFirstmateEvents();
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    from: "firstmate",
    kind: "heartbeat",
    state,
  });
  appendFileSync(path, `${line}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", (_event, ctx) => {
    const state = typeof ctx.isIdle === "function" && ctx.isIdle() ? "idle" : "settled";
    try {
      appendHeartbeat(state);
    } catch {
      /* best-effort */
    }
  });
}
