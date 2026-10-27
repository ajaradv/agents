import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "test-secret-access-key";
const ACCESS = "test-access-key-id";
const ACCOUNT = "acctid";
const BUCKET = "ajaradv-fleet-hub-backups";
const root = join(import.meta.dir, "..", "..");
const script = join(root, "bin", "fleet-backup");
const pin = join(root, "bin", "litestream-pin.sh");
const bunBin = process.execPath;
const keep = mkdtempSync(join(tmpdir(), "fleet-backup-"));
afterAll(() => rmSync(keep, { recursive: true, force: true }));

function writeExe(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

type World = { home: string; inbox: string; confDir: string; bin: string; log: string; systemd: string; os: "Linux" | "Darwin" };

function world(os: "Linux" | "Darwin" = "Linux"): World {
  const home = mkdtempSync(join(keep, "home-"));
  const bin = join(home, "fake-bin");
  const log = join(home, "log");
  const inbox = join(home, "inbox");
  const systemd = join(home, "systemd");
  mkdirSync(bin, { recursive: true });
  mkdirSync(log, { recursive: true });
  mkdirSync(join(inbox, ".node"), { recursive: true });
  mkdirSync(systemd, { recursive: true });
  const confDir = join(home, ".config", "fleet");
  writeExe(bin, "uname", "#!/bin/bash\nif [ \"$1\" = -m ]; then echo x86_64; exit 0; fi\necho \"${FAKE_OS:-Linux}\"\n");
  writeExe(
    bin,
    "systemctl",
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/systemctl.log"
case "$1" in
  is-active)
    if [ -f "$FLEET_TEST_LOG/active" ]; then echo active; exit 0; fi
    echo inactive
    exit 3
    ;;
  is-enabled) echo disabled; exit 1 ;;
esac
exit 0
`,
  );
  writeExe(
    bin,
    "sudo",
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/sudo.log"
if [ "$1" = -n ]; then shift; fi
if [ "$1" = tee ]; then cat > "$2"; exit 0; fi
if [ "$1" = systemctl ]; then
  shift
  printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/systemctl.log"
  case "$1" in
    enable|start|restart) touch "$FLEET_TEST_LOG/active" ;;
  esac
  exit 0
fi
exit 0
`,
  );
  writeExe(
    bin,
    "litestream",
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/litestream-args.log"
case "$1" in
  version) echo 0.5.17; exit 0 ;;
  restore)
    out=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = -o ]; then out="$a"; fi
      prev="$a"
    done
    if [ -z "$out" ]; then out="\${@: -1}"; fi
    sqlite3 "$out" 'CREATE TABLE t(x); INSERT INTO t VALUES (1);'
    exit 0
    ;;
  ltx) echo "level min_txid max_txid"; echo "9 1 1"; exit 0 ;;
  status) echo "database status local"; echo "ok"; exit 0 ;;
esac
exit 0
`,
  );
  writeExe(
    bin,
    "bun",
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/bun-argv.log"
exec ${JSON.stringify(bunBin)} "$@"
`,
  );
  writeExe(
    bin,
    "curl",
    `#!/bin/bash
printf '%s\\n' "$*" >> "$FLEET_TEST_LOG/curl.log"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = -o ]; then out="$a"; fi
  prev="$a"
done
printf 'not-a-tarball' > "$out"
exit 0
`,
  );
  return { home, inbox, confDir, bin, log, systemd, os };
}

function envOf(w: World, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${w.bin}:/usr/bin:/bin`,
    HOME: w.home,
    FAKE_OS: w.os,
    FLEET_INBOX: w.inbox,
    FLEET_CONFIG_DIR: w.confDir,
    FLEET_SECRETS_DIR: join(w.confDir, "secrets"),
    FLEET_SYSTEMD_DIR: w.systemd,
    FLEET_SECRET_BACKEND: "file",
    FLEET_TEST_LOG: w.log,
    ...extra,
  };
}

async function run(w: World, args: string[], extra: Record<string, string> = {}, stdin?: string, file = script) {
  const proc = Bun.spawn(["bash", file, ...args], {
    env: envOf(w, extra),
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr, out: `${stdout}\n${stderr}` };
}

function credsStdin(): string {
  return `LITESTREAM_ACCESS_KEY_ID=${ACCESS}\nLITESTREAM_SECRET_ACCESS_KEY=${SECRET}\nR2_ACCOUNT_ID=${ACCOUNT}\nR2_BUCKET=${BUCKET}\n`;
}

function seedDbs(inbox: string) {
  const paths = [
    join(inbox, ".node", "metrics.db"),
    join(inbox, ".node", "journal.db"),
    join(inbox, "ships", "alpha", "ship.db"),
    join(inbox, "ships", "beta", "ship.db"),
    join(inbox, "ships", "zz-probe", "ship.db"),
    join(inbox, "ships", "fixture", "ship.db"),
    join(inbox, "ships", "alpha", "adws", "adw_data", "sssf.db"),
    join(inbox, "fixture", "rig", "ship.db"),
  ];
  for (const path of paths) {
    mkdirSync(join(path, ".."), { recursive: true });
    const made = Bun.spawnSync(["sqlite3", path, "CREATE TABLE t(x); INSERT INTO t VALUES (1);"]);
    if (made.exitCode !== 0) throw new Error(`sqlite3 ${path}: ${made.stderr.toString()}`);
  }
}

function assertPublicFiles(w: World) {
  const files = [join(w.confDir, "litestream.yml"), join(w.systemd, "fleet-litestream.service"), join(w.log, "bun-argv.log"), join(w.log, "sudo.log"), join(w.log, "litestream-args.log")];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCESS);
  }
}

describe("fleet-backup", () => {
  test("install refuses without the env file and does not enable the unit", async () => {
    const w = world();
    const r = await run(w, ["install"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("not set up");
    expect(r.out).not.toContain(SECRET);
    expect(existsSync(join(w.systemd, "fleet-litestream.service"))).toBe(false);
    expect(existsSync(join(w.log, "sudo.log"))).toBe(false);
    expect(existsSync(join(w.log, "active"))).toBe(false);
  });

  test("status without credentials says not set up and does not run litestream", async () => {
    const w = world();
    const r = await run(w, ["status"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("not set up");
    expect(existsSync(join(w.log, "litestream-args.log"))).toBe(false);
  });

  test("creds rejects values passed as arguments", async () => {
    const w = world();
    const r = await run(w, ["creds", ACCESS, SECRET]);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain(SECRET);
    expect(existsSync(join(w.confDir, "secrets", "litestream.env"))).toBe(false);
  });

  test("creds from stdin stores the secret store and a 0600 env file, and install writes no secret", async () => {
    const w = world();
    seedDbs(w.inbox);
    const stored = await run(w, ["creds"], {}, credsStdin());
    expect(stored.code).toBe(0);
    expect(stored.out).not.toContain(SECRET);
    expect(stored.out).not.toContain(ACCESS);
    const argv = readFileSync(join(w.log, "bun-argv.log"), "utf8");
    expect(argv).toContain("litestream-creds.ts");
    expect(argv).not.toContain(SECRET);
    expect(argv).not.toContain(ACCESS);
    const secrets = join(w.confDir, "secrets");
    const env = readFileSync(join(secrets, "litestream.env"), "utf8");
    expect(env).toContain(`R2_BUCKET=${BUCKET}`);
    expect(statSync(join(secrets, "litestream.env")).mode & 0o077).toBe(0);
    expect(statSync(join(secrets, "litestream-secret-access-key")).mode & 0o077).toBe(0);
    expect(readFileSync(join(secrets, "litestream-secret-access-key"), "utf8")).toBe(SECRET);
    expect(existsSync(join(w.systemd, "fleet-litestream.service"))).toBe(false);

    const installed = await run(w, ["install"]);
    expect(installed.code).toBe(0);
    const yml = readFileSync(join(w.confDir, "litestream.yml"), "utf8");
    const unit = readFileSync(join(w.systemd, "fleet-litestream.service"), "utf8");
    expect(yml).toContain("replica:");
    expect(yml).not.toContain("replicas:");
    expect(yml).toContain("retention: 720h");
    expect(yml).toContain("sync-interval: 10s");
    expect(yml).toContain(`endpoint: https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(yml).toContain("region: auto");
    expect(yml).toContain(`bucket: ${BUCKET}`);
    expect(yml).toContain("ships/alpha/ship");
    expect(yml).toContain("ships/beta/ship");
    expect(yml).toContain("fleet-hub/.node/metrics");
    expect(yml).not.toContain("zz-probe");
    expect(yml).not.toContain("sssf");
    expect(yml).not.toContain("fixture");
    expect(yml).not.toContain("/rig/");
    expect(unit).toContain("EnvironmentFile=");
    expect(unit).toContain("ConditionPathExists=");
    expect(unit).toContain("litestream.env");
    expect(readFileSync(join(w.log, "sudo.log"), "utf8")).toContain("enable");
    expect(statSync(join(w.confDir, "litestream.yml")).mode & 0o077).toBe(0);
    assertPublicFiles(w);

    mkdirSync(join(w.inbox, "ships", "gamma"), { recursive: true });
    writeFileSync(join(w.inbox, "ships", "gamma", "ship.db"), readFileSync(join(w.inbox, "ships", "alpha", "ship.db")));
    const reconciled = await run(w, ["reconcile"]);
    expect(reconciled.code).toBe(0);
    expect(reconciled.stdout).toContain("ships/gamma/ship");
    expect(reconciled.stdout).toContain("restarted fleet-litestream");
    expect(readFileSync(join(w.confDir, "litestream.yml"), "utf8")).toContain("ships/gamma/ship");
    assertPublicFiles(w);
  });

  test("status and drill keep the keys out of argv and generated files", async () => {
    const w = world();
    seedDbs(w.inbox);
    expect((await run(w, ["creds"], {}, credsStdin())).code).toBe(0);
    expect((await run(w, ["install"])).code).toBe(0);
    const status = await run(w, ["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("fleet-litestream: active");
    expect(status.stdout).toContain("snapshots (level 9)");
    expect(status.out).not.toContain(SECRET);
    const args = readFileSync(join(w.log, "litestream-args.log"), "utf8");
    expect(args).toContain("ltx");
    expect(args).toContain("-level");
    expect(args).not.toContain(SECRET);
    const drill = await run(w, ["drill"]);
    expect(drill.code).toBe(0);
    expect(drill.stdout).toContain("drill passed");
    expect(drill.out).not.toContain(SECRET);
    assertPublicFiles(w);
  });

  test("restore moves the database aside, checks it, and restarts", async () => {
    const w = world();
    seedDbs(w.inbox);
    expect((await run(w, ["creds"], {}, credsStdin())).code).toBe(0);
    expect((await run(w, ["install"])).code).toBe(0);
    const db = join(w.inbox, ".node", "metrics.db");
    writeFileSync(`${db}-wal`, "wal");
    const restored = await run(w, ["restore", db]);
    expect(restored.code).toBe(0);
    expect(restored.stdout).toContain("restore passed");
    expect(restored.out).not.toContain(SECRET);
    const asides = readdirSync(join(w.inbox, ".node")).filter((name) => name.startsWith("metrics.db") && name.includes(".aside-"));
    expect(asides.some((name) => name.startsWith("metrics.db.aside-"))).toBe(true);
    expect(asides.some((name) => name.includes("-wal"))).toBe(true);
    const check = Bun.spawnSync(["sqlite3", db, "PRAGMA integrity_check"]);
    expect(check.stdout.toString().trim()).toBe("ok");
    expect(readFileSync(join(w.log, "systemctl.log"), "utf8")).toContain("start");
    assertPublicFiles(w);
  });

  test("a Mac is refused and nothing is written", async () => {
    const w = world("Darwin");
    const r = await run(w, ["install"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("macOS is not wired up");
    expect(existsSync(join(w.confDir, "litestream.yml"))).toBe(false);
    expect(existsSync(join(w.systemd, "fleet-litestream.service"))).toBe(false);
  });

  test("the Litestream pin rejects a bad checksum and skips a current binary", async () => {
    const w = world();
    const fresh = join(w.home, "pin-fresh");
    mkdirSync(fresh);
    const bad = await run(w, [], { LITESTREAM_BIN_DIR: fresh }, undefined, pin);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("checksum");
    expect(existsSync(join(fresh, "litestream"))).toBe(false);
    const current = join(w.home, "pin-current");
    mkdirSync(current);
    writeExe(current, "litestream", "#!/bin/bash\necho 0.5.17\n");
    const skip = await run(w, [], { LITESTREAM_BIN_DIR: current }, undefined, pin);
    expect(skip.code).toBe(0);
    expect(skip.stdout).toContain("already installed");
    expect(existsSync(join(w.log, "curl.log"))).toBe(true);
    const curlLines = readFileSync(join(w.log, "curl.log"), "utf8").trim().split("\n").length;
    const skipAgain = await run(w, [], { LITESTREAM_BIN_DIR: current }, undefined, pin);
    expect(skipAgain.code).toBe(0);
    expect(readFileSync(join(w.log, "curl.log"), "utf8").trim().split("\n").length).toBe(curlLines);
  });
});
