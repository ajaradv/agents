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
