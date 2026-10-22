import { createClient } from "@1password/sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import { readSecret, writeSecret } from "./secret-store.ts";

/**
 * The fleet's provider keys from the 1Password service account, read with
 * 1Password's SDK (HTTPS with the token; no `op` CLI, no daemon, no app).
 * The `op` CLI started from the node or the dashboard (launchd services)
 * stalled before its first log line and never answered (2026-10-18), so the
 * services and bin/fleet-secrets both read keys here.
 *
 * - The token: what bin/fleet-op-token stores (lib/secret-store.ts: the login Keychain on macOS, a 0600 file on Linux).
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
  return readSecret("op-service-account");
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
    const got = await Promise.race([work, new Promise<Record<string, string>>((r) => (timer = setTimeout(() => r({}), timeoutMs)))]);
    logRead(Object.keys(refs).length, Object.keys(got).length);
    return got;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every service-account read, one line each (fleet/inbox/.node/op-reads.jsonl): a read
 * costs one request per reference, and the account allows 1,000 requests a day
 * (individual plan), so the count is worth seeing (bin/fleet-keys-seed --usage).
 */
function logRead(wanted: number, got: number): void {
  try {
    const { appendFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = join(process.env.FLEET_INBOX || join(ROOT, "fleet", "inbox"), ".node");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "op-reads.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), process: process.argv[1]?.split("/").pop() ?? "", requests: wanted, resolved: got })}\n`);
  } catch {
    /* the count never breaks a read */
  }
}

// ---------------------------------------------------------------- Keychain fallback

/**
 * The last good keys, kept in the login Keychain (where the service account
 * token already lives), for when 1Password refuses a read: the service account
 * hit its rate limit on 2026-10-19 after a day of restarts, and a freshly
 * started process had no keys at all. One item, rewritten only when the keys
 * change; values go to `security` through stdin, never on a command line.
 */
const CACHE_SERVICE = "fleet-keys-cache";

function cacheHash(keys: Record<string, string>): string {
  return Bun.hash(JSON.stringify(Object.entries(keys).sort())).toString(36);
}

export async function readKeychainCache(): Promise<Record<string, string>> {
  if (process.env.NODE_ENV === "test") return {};
  const out = await readSecret(CACHE_SERVICE);
  if (!out) return {};
  try {
    return JSON.parse(Buffer.from(out, "base64").toString("utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

let savedHash = "";
export async function saveKeychainCache(keys: Record<string, string>): Promise<void> {
  if (process.env.NODE_ENV === "test" || !Object.keys(keys).length) return;
  const h = cacheHash(keys);
  if (h === savedHash) return;
  if (!savedHash && cacheHash(await readKeychainCache()) === h) {
    savedHash = h;
    return;
  }
  const value = Buffer.from(JSON.stringify(keys)).toString("base64");
  if (await writeSecret(CACHE_SERVICE, value, "Fleet provider keys (cache)")) savedHash = h;
}

/** The service account first; when 1Password refuses (rate limit, outage), the Keychain copy of the last good keys. */
export async function readFleetKeys(): Promise<{ keys: Record<string, string>; from: "service-account" | "keychain-cache" | "none"; complete: boolean }> {
  const keys = await readServiceAccountKeys().catch(() => ({}) as Record<string, string>);
  const wanted = existsSync(opRefsPath()) ? Object.keys(parseRefs(readFileSync(opRefsPath(), "utf8"))).length : 0;
  // Every reference resolved: the new truth, saved for next time.
  if (wanted && Object.keys(keys).length >= wanted) {
    await saveKeychainCache(keys).catch(() => {});
    return { keys, from: "service-account", complete: true };
  }
  // Some or none (a rate limit can refuse part of a read): fill in from the Keychain copy, never overwrite it.
  const cached = await readKeychainCache().catch(() => ({}) as Record<string, string>);
  const merged = { ...cached, ...keys };
  if (!Object.keys(merged).length) return { keys: {}, from: "none", complete: false };
  return { keys: merged, from: Object.keys(cached).length ? "keychain-cache" : "service-account", complete: false };
}

// bin/fleet-secrets runs this: KEY=value lines, only ever into a pipe.
if (import.meta.main) {
  if (process.stdout.isTTY) {
    console.error("error: fleet-secrets prints secrets and only writes into a pipe");
    process.exit(2);
  }
  const { keys } = await readFleetKeys();
  process.stdout.write(Object.entries(keys).map(([k, v]) => `${k}=${v}\n`).join(""));
  process.exit(0);
}
