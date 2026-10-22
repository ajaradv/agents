import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the fleet keeps its two local secrets: the 1Password service-account
 * token (bin/fleet-op-token) and the cached provider keys (lib/op-sdk.ts).
 *
 * - macOS: the login Keychain (account "fleet"), as before.
 * - Linux (the exe.dev hub): one file per secret in ~/.config/fleet/secrets
 *   (FLEET_SECRETS_DIR), folder 0700, files 0600, readable only by the user
 *   the services run as. The VM has no desktop keyring to unlock.
 *
 * Values never go on a command line: `security` reads them on stdin, files are
 * written directly.
 */

/** "file" on Linux, "keychain" on macOS; FLEET_SECRET_BACKEND=file forces files (tests, or a Mac without a login keychain). */
const useFiles = () => (process.env.FLEET_SECRET_BACKEND ?? (process.platform === "linux" ? "file" : "keychain")) === "file";

export function secretsDir(): string {
  return process.env.FLEET_SECRETS_DIR || join(homedir(), ".config", "fleet", "secrets");
}

const fileFor = (service: string) => join(secretsDir(), service.replace(/[^\w.-]/g, "_"));

export async function readSecret(service: string): Promise<string> {
  if (useFiles()) {
    try {
      return readFileSync(fileFor(service), "utf8").trim();
    } catch {
      return "";
    }
  }
  const p = Bun.spawn(["/usr/bin/security", "find-generic-password", "-a", "fleet", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const t = setTimeout(() => p.kill(), 10_000);
  const out = await new Response(p.stdout).text();
  clearTimeout(t);
  return out.trim();
}

export async function writeSecret(service: string, value: string, label = service): Promise<boolean> {
  if (useFiles()) {
    const dir = secretsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${fileFor(service)}.tmp`;
    writeFileSync(tmp, value, { mode: 0o600 });
    renameSync(tmp, fileFor(service));
    return true;
  }
  const p = Bun.spawn(["/usr/bin/security", "-i"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  p.stdin.write(`add-generic-password -U -a fleet -s ${service} -l "${label.replace(/"/g, "")}" -w ${value}\n`);
  p.stdin.end();
  return (await p.exited) === 0;
}
