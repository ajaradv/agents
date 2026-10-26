import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shipDb, shipLogPath } from "./ship-log.ts";

const dir = mkdtempSync(join(tmpdir(), "ship-log-"));
const saved = {
  inbox: process.env.FLEET_INBOX,
  reconcile: process.env.FLEET_BACKUP_RECONCILE,
  cmd: process.env.FLEET_BACKUP_RECONCILE_CMD,
};
afterAll(() => {
  for (const [k, v] of [
    ["FLEET_INBOX", saved.inbox],
    ["FLEET_BACKUP_RECONCILE", saved.reconcile],
    ["FLEET_BACKUP_RECONCILE_CMD", saved.cmd],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("ship.db", () => {
  test("sets a busy timeout so a Litestream checkpoint can wait", () => {
    const root = join(dir, "root-busy");
    const db = shipDb("alpha", root)!;
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  test("an explicit root (a fixture or a rig) does not schedule a reconcile", async () => {
    const marker = join(dir, "should-not-run");
    const cmd = join(dir, "mark-no.sh");
    writeFileSync(cmd, `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(cmd, 0o755);
    process.env.FLEET_BACKUP_RECONCILE = "1";
    process.env.FLEET_BACKUP_RECONCILE_CMD = cmd;
    shipDb("fixture", join(dir, "explicit-root"));
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
  });

  test("a new hub ship.db schedules one reconcile; an existing file does not", async () => {
    const inbox = join(dir, "inbox");
    const marker = join(dir, "reconcile-ran");
    const cmd = join(dir, "mark-yes.sh");
    writeFileSync(cmd, `#!/bin/bash\necho ran >> ${JSON.stringify(marker)}\n`);
    chmodSync(cmd, 0o755);
    process.env.FLEET_INBOX = inbox;
    process.env.FLEET_BACKUP_RECONCILE = "0";
    const existing = shipLogPath("old", inbox);
    mkdirSync(join(existing, ".."), { recursive: true });
    new Database(existing, { create: true }).close();
    process.env.FLEET_BACKUP_RECONCILE = "1";
    process.env.FLEET_BACKUP_RECONCILE_CMD = cmd;
    shipDb("old");
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
    shipDb("gammanew");
    shipDb("gammanew");
    const deadline = Date.now() + 2000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
    expect(readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)).toEqual(["ran"]);
  });
});
