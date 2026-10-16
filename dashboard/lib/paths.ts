import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");

export function fleetInboxRoot(): string {
  const raw = process.env.FLEET_INBOX;
  if (raw) return raw.replace(/^~/, process.env.HOME ?? "");
  return join(ROOT, "fleet", "inbox");
}

export function aliceVault(): string {
  const raw = process.env.ALICE_VAULT ?? "/Users/avega/Workspace/brain";
  return raw.replace(/^~/, process.env.HOME ?? "");
}

/**
 * True when this process serves the real fleet (the default inbox). A test
 * dashboard or node runs with another FLEET_INBOX, often a copy of the real
 * one, whose session files point at the captain's live TUIs; it must never
 * type into them or start and stop them. FLEET_ALLOW_TUI=1 overrides.
 */
export function realFleet(): boolean {
  if (process.env.FLEET_ALLOW_TUI === "1") return true;
  const raw = process.env.FLEET_INBOX;
  if (!raw) return true;
  const resolved = raw.replace(/^~/, process.env.HOME ?? "").replace(/\/+$/, "");
  return resolved === join(ROOT, "fleet", "inbox");
}

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.DASHBOARD_PORT ?? 8787);
/**
 * The fleet node (node.ts): the long-lived process that runs agents. Loopback
 * only, one below the dashboard's port unless FLEET_NODE_PORT says otherwise,
 * so a test dashboard on another port gets its own node.
 */
export const NODE_PORT = Number(process.env.FLEET_NODE_PORT ?? PORT - 1);

/** The node's token, pid file, and log: fleet/inbox/.node/ (not a chat id, so never on the rail). */
export function nodeStateDir(): string {
  return join(fleetInboxRoot(), ".node");
}
