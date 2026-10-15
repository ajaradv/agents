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
