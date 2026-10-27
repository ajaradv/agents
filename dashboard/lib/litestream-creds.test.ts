import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_KEY_SERVICE, SECRET_KEY_SERVICE, storeLitestreamCreds } from "./litestream-creds.ts";
import { readSecret } from "./secret-store.ts";

const SECRET = "test-secret-access-key";
const ACCESS = "test-access-key-id";
const ACCOUNT = "acctid";
const BUCKET = "ajaradv-fleet-hub-backups";
const dir = mkdtempSync(join(tmpdir(), "litestream-creds-"));
const saved = { backend: process.env.FLEET_SECRET_BACKEND, secrets: process.env.FLEET_SECRETS_DIR };

afterAll(() => {
  if (saved.backend === undefined) delete process.env.FLEET_SECRET_BACKEND;
  else process.env.FLEET_SECRET_BACKEND = saved.backend;
  if (saved.secrets === undefined) delete process.env.FLEET_SECRETS_DIR;
  else process.env.FLEET_SECRETS_DIR = saved.secrets;
  rmSync(dir, { recursive: true, force: true });
});

function useDir(name: string): string {
  const secrets = join(dir, name);
  process.env.FLEET_SECRET_BACKEND = "file";
  process.env.FLEET_SECRETS_DIR = secrets;
  return secrets;
}

function lines(): string {
  return `LITESTREAM_ACCESS_KEY_ID=${ACCESS}\nLITESTREAM_SECRET_ACCESS_KEY=${SECRET}\nR2_ACCOUNT_ID=${ACCOUNT}\nR2_BUCKET=${BUCKET}\n`;
}

describe("fleet-backup creds", () => {
  test("stores both secrets and the 0600 env file, and the message has neither value", async () => {
    const secrets = useDir("ok");
    const result = await storeLitestreamCreds(lines());
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain(SECRET);
    expect(result.message).not.toContain(ACCESS);
    expect(await readSecret(ACCESS_KEY_SERVICE)).toBe(ACCESS);
    expect(await readSecret(SECRET_KEY_SERVICE)).toBe(SECRET);
    const envPath = join(secrets, "litestream.env");
    const env = readFileSync(envPath, "utf8");
    expect(env).toContain(`R2_BUCKET=${BUCKET}`);
    expect(env).toContain(`LITESTREAM_SECRET_ACCESS_KEY=${SECRET}`);
    expect(statSync(envPath).mode & 0o077).toBe(0);
    expect(statSync(secrets).mode & 0o077).toBe(0);
    expect(statSync(join(secrets, SECRET_KEY_SERVICE)).mode & 0o077).toBe(0);
  });

  test("writes nothing when a value contains a character the command will not pass through", async () => {
    const secrets = useDir("bad");
    const result = await storeLitestreamCreds(lines().replace(SECRET, "not safe"));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not stored");
    expect(result.message).not.toContain("not safe");
    expect(result.message).not.toContain(ACCESS);
    expect(existsSync(secrets)).toBe(false);
  });

  test("writes nothing when a field is missing", async () => {
    const secrets = useDir("missing");
    let writes = 0;
    const result = await storeLitestreamCreds("LITESTREAM_ACCESS_KEY_ID=test-access-key-id\n", {
      write: async () => {
        writes += 1;
        return true;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("LITESTREAM_SECRET_ACCESS_KEY");
    expect(writes).toBe(0);
    expect(existsSync(secrets)).toBe(false);
  });

  test("a failed secret-store write does not publish the env file", async () => {
    const secrets = useDir("fail-write");
    chmodSync(dir, 0o700);
    const result = await storeLitestreamCreds(lines(), { write: async () => false });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(SECRET);
    expect(readdirSync(dir).includes("fail-write")).toBe(false);
  });
});
