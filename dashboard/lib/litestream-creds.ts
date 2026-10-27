/**
 * bin/fleet-backup creds pipes KEY=value lines here. The two R2 secrets are
 * stored through the secret store (0600 files on the Linux hub). The same
 * command also writes litestream.env (0600), which systemd's EnvironmentFile
 * reads. Values arrive on stdin, never as arguments, and are not printed.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretsDir, writeSecret } from "./secret-store.ts";

export const ACCESS_KEY_SERVICE = "litestream-access-key-id";
export const SECRET_KEY_SERVICE = "litestream-secret-access-key";

const SAFE = /^[A-Za-z0-9+/=_-]+$/;
const FIELDS = ["LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID", "R2_BUCKET"] as const;

type Write = (service: string, value: string, label?: string) => Promise<boolean>;

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseCredLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}

function writeEnvFile(body: string): void {
  const dir = secretsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dest = join(dir, "litestream.env");
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
}

export async function storeLitestreamCreds(text: string, deps: { write?: Write; writeEnv?: (body: string) => void } = {}): Promise<{ ok: boolean; message: string }> {
  const vals = parseCredLines(text);
  const missing = FIELDS.filter((key) => !vals[key]);
  if (missing.length) {
    return { ok: false, message: `missing ${missing.join(", ")}` };
  }
  if (FIELDS.some((key) => !SAFE.test(vals[key] ?? ""))) {
    return { ok: false, message: "a value was not stored because it contained a character this command will not pass through" };
  }
  const write = deps.write ?? writeSecret;
  const okId = await write(ACCESS_KEY_SERVICE, vals.LITESTREAM_ACCESS_KEY_ID ?? "", "Fleet Litestream R2 access key id");
  const okSecret = await write(SECRET_KEY_SERVICE, vals.LITESTREAM_SECRET_ACCESS_KEY ?? "", "Fleet Litestream R2 secret access key");
  if (!okId || !okSecret) return { ok: false, message: "could not store the R2 keys in the secret store" };
  const body = `${FIELDS.map((key) => `${key}=${vals[key]}`).join("\n")}\n`;
  if (deps.writeEnv) deps.writeEnv(body);
  else writeEnvFile(body);
  return { ok: true, message: "stored the R2 credentials (secret store and litestream.env, mode 0600)" };
}

if (import.meta.main) {
  const text = await new Response(Bun.stdin).text();
  const result = await storeLitestreamCreds(text);
  if (result.ok) console.log(result.message);
  else console.error(result.message);
  process.exit(result.ok ? 0 : 1);
}
