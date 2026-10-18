import { createClient } from "@1password/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

/**
 * The fleet's provider keys from the 1Password service account, read with
 * 1Password's SDK (HTTPS with the token; no `op` CLI, no daemon, no app).
 * The `op` CLI started from the node or the dashboard (launchd services)
 * stalled before its first log line and never answered (2026-10-18), so the
 * services and bin/fleet-secrets both read keys here.
 *
 * - The token: the login Keychain item bin/fleet-op-token stores (-a fleet -s op-service-account).
 * - The references: fleet/home/.env.op (KEY=op://vault/item/field, item ids).
 */

export function opRefsPath(): string {
  return process.env.FLEET_OP_ENV_FILE || join(ROOT, "fleet", "home", ".env.op");
}

/** KEY=op://... lines; comments and anything else skipped. */
export function parseRefs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^([A-Z][A-Z0-9_]*)=["']?(op:\/\/[^"'\s]+)["']?$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function keychainToken(): Promise<string> {
  const p = Bun.spawn(["/usr/bin/security", "find-generic-password", "-a", "fleet", "-s", "op-service-account", "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const t = setTimeout(() => p.kill(), 10_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(t);
  return out.trim();
}

/** KEY → value for every reference that resolves; {} when no token or no refs file. */
export async function readServiceAccountKeys(timeoutMs = 20_000): Promise<Record<string, string>> {
  const path = opRefsPath();
  if (!existsSync(path)) return {};
  const refs = parseRefs(readFileSync(path, "utf8"));
  if (!Object.keys(refs).length) return {};
  const token = await keychainToken();
  if (!token) return {};
  const work = (async () => {
    const client = await createClient({ auth: token, integrationName: "fleet", integrationVersion: "1.0.0" });
    const entries = await Promise.all(
      Object.entries(refs).map(async ([k, ref]) => {
        try {
          return [k, (await client.secrets.resolve(ref)).trim()] as const;
        } catch {
          return [k, ""] as const;
        }
      }),
    );
    return Object.fromEntries(entries.filter(([, v]) => v));
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<Record<string, string>>((r) => (timer = setTimeout(() => r({}), timeoutMs)))]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// bin/fleet-secrets runs this: KEY=value lines, only ever into a pipe.
if (import.meta.main) {
  if (process.stdout.isTTY) {
    console.error("error: fleet-secrets prints secrets and only writes into a pipe");
    process.exit(2);
  }
  const keys = await readServiceAccountKeys();
  process.stdout.write(Object.entries(keys).map(([k, v]) => `${k}=${v}\n`).join(""));
  process.exit(0);
}
