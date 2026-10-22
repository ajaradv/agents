import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(mkdtempSync(join(tmpdir(), "secret-store-")), "secrets");
const saved = { dir: process.env.FLEET_SECRETS_DIR, backend: process.env.FLEET_SECRET_BACKEND };
process.env.FLEET_SECRETS_DIR = dir;
process.env.FLEET_SECRET_BACKEND = "file";
const { readSecret, writeSecret } = await import("./secret-store.ts");
afterAll(() => {
  for (const [k, v] of [["FLEET_SECRETS_DIR", saved.dir], ["FLEET_SECRET_BACKEND", saved.backend]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

describe("secret store on Linux (files)", () => {
  test("a secret is written only the owner can read, read back, and replaced whole", async () => {
    expect(await readSecret("op-service-account")).toBe("");
    expect(await writeSecret("op-service-account", "ops_test-token")).toBe(true);
    expect(await readSecret("op-service-account")).toBe("ops_test-token");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "op-service-account")).mode & 0o777).toBe(0o600);
    await writeSecret("op-service-account", "ops_new");
    expect(await readSecret("op-service-account")).toBe("ops_new");
  });
});
