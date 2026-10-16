import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeStateDir } from "./paths.ts";

/**
 * The fleet node's API token (fleet/inbox/.node/token, mode 0600). Whichever
 * of the dashboard and the node starts first writes it; both read the same
 * file, so only processes running as the captain can drive agents.
 */
export function nodeToken(): string {
  const dir = nodeStateDir();
  const path = join(dir, "token");
  try {
    const t = readFileSync(path, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* first run */
  }
  mkdirSync(dir, { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(path, t + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return t;
}

/** Constant-time compare of a presented bearer token. */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
