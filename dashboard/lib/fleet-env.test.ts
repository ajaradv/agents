import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetServiceAccountForTests, loadFleetDotenv, mountAllowed, serviceAccountEnv } from "./fleet-env.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-env-"));
const refs = join(dir, ".env.op");
const secrets = join(dir, "secrets.sh");
const prev = { refs: process.env.FLEET_OP_ENV_FILE, cmd: process.env.FLEET_SECRETS_CMD, mount: process.env.FLEET_ENV_MOUNT };
afterAll(() => {
  for (const [k, v] of [["FLEET_OP_ENV_FILE", prev.refs], ["FLEET_SECRETS_CMD", prev.cmd], ["FLEET_ENV_MOUNT", prev.mount]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  _resetServiceAccountForTests();
  delete process.env.FLEET_ENV_MOUNT;
  process.env.FLEET_OP_ENV_FILE = refs;
  process.env.FLEET_SECRETS_CMD = secrets;
});

const script = (body: string) => {
  writeFileSync(secrets, `#!/bin/sh\n${body}\n`);
  chmodSync(secrets, 0o755);
};

describe("fleet keys come from the service account", () => {
  test("with a service account set up, the 1Password mount is never read", async () => {
    writeFileSync(refs, "OPENROUTER_API_KEY=op://x/y/z\n");
    script('echo "OPENROUTER_API_KEY=sk-test"');
    expect(mountAllowed()).toBe(false);
    expect(await loadFleetDotenv()).toEqual({ OPENROUTER_API_KEY: "sk-test" });
  });
  test("the mount is allowed without a service account, or when asked for", () => {
    rmSync(refs, { force: true });
    expect(mountAllowed()).toBe(true);
    writeFileSync(refs, "x\n");
    process.env.FLEET_ENV_MOUNT = "1";
    expect(mountAllowed()).toBe(true);
  });
  test("callers arriving together share one read", async () => {
    writeFileSync(refs, "x\n");
    script(`echo run >> ${join(dir, "runs")}; echo "DEEPSEEK_API_KEY=ds-test"`);
    const both = await Promise.all([serviceAccountEnv(), serviceAccountEnv()]);
    expect(both[1]).toEqual({ DEEPSEEK_API_KEY: "ds-test" });
    expect(Bun.file(join(dir, "runs")).size).toBe(4);
  });
});

describe("op-sdk refs", () => {
  test("reads KEY=op:// lines and skips comments, quotes, and other lines", async () => {
    const { parseRefs } = await import("./op-sdk.ts");
    expect(parseRefs('# DEEPSEEK_API_KEY=op://a/b/c\nTYPESAFE_API_KEY=op://v/i/credential\nGEMINI_API_KEY="op://v/j/credential"\nPLAIN=value\n')).toEqual({ TYPESAFE_API_KEY: "op://v/i/credential", GEMINI_API_KEY: "op://v/j/credential" });
  });
});
