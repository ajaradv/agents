import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExeVm } from "./exe-dev.ts";
import { buildGolden, readEnvStore, type GoldenDeps } from "./exe-golden.ts";

const TOKEN = "ab".repeat(32);
const PROXY = "proxy-secret-token-value";
const vm = (name: string, status = "running"): ExeVm => ({ vm_name: name, status, dns_name: `${name}.exe.xyz` });

function fakes(o: { vms?: ExeVm[]; tokenBody?: string; fail?: RegExp; files?: Record<string, string>; sshUp?: number } = {}) {
  const calls: string[] = [];
  const secrets: Record<string, string> = {};
  let t = 0;
  let tries = 0;
  const deps: GoldenDeps = {
    now: () => t,
    sleep: async (ms) => void (t += ms),
    ships: async () => [{ id: "kinwork" }, { id: "pochteca" }],
    client: {
      ls: async () => o.vms ?? [],
      rm: async (n: string) => void calls.push(`rm ${n}`),
      pause: async (n: string) => void calls.push(`pause ${n}`),
      vmToken: async (n: string, exp?: string) => (calls.push(`vmToken ${n} ${exp}`), PROXY),
      exec: async (c: string) => (calls.push(`exec ${c}`), { ok: true, exit: 0, body: '{"vm_name":"kinwork-golden"}' }),
      ssh: async (_n: string, c: string) => {
        if (c === "true") {
          calls.push("ssh true");
          return { ok: ++tries > (o.sshUp ?? 0), exit: 0, body: "" };
        }
        calls.push(`ssh ${c.replace(/^~\/Workspace\/agents\/bin\//, "")}`);
        if (o.fail?.test(c)) return { ok: false, exit: 1, body: "boom" };
        return { ok: true, exit: 0, body: c.includes("token --generate") ? (o.tokenBody ?? `${TOKEN}\nrestarted fleet-worker`) + "\n" : "fine" };
      },
    } as unknown as GoldenDeps["client"],
    writeSecret: async (n, v) => ((secrets[n] = v), true),
    forget: async (n) => void calls.push(`forget ${n}`),
    envFiles: async () => o.files ?? {},
    putEnv: async (v, tokens, ship, files) => (calls.push(`putEnv ${v} ${ship} ${Object.keys(files).join(",")} ${tokens.worker === TOKEN} ${tokens.proxy === PROXY}`), { ok: true, message: "stored" }),
  };
  return { calls, secrets, deps };
}

describe("buildGolden", () => {
  test("happy path: create, clone, setup, token, secrets, env, warm, seal, pause, in order", async () => {
    const f = fakes({ files: { "kinwork/.envs/.local/a.env": "A=1" } });
    const r = await buildGolden("kinwork", f.deps);
    expect(r.ok).toBe(true);
    const order = f.calls.map((c) => c.split(" ").slice(0, 4).join(" ").replace(/^putEnv.*/, "putEnv").replace(/^ssh test -d.*/, "ssh clone"));
    expect(order).toEqual(["exec new --name=kinwork-golden --cpu=2", "ssh true", "ssh clone", "ssh voyage-vm-setup setup kinwork", "ssh voyage-vm-setup token --generate", "vmToken kinwork-golden 90d", "putEnv", "ssh voyage-vm-setup warm kinwork", "ssh voyage-vm-setup seal", "pause kinwork-golden"]);
    expect(f.calls[0]).toContain("--cpu=2 --memory=4GB --disk=40GB --no-email --json");
    expect(f.calls).toContain("putEnv kinwork-golden kinwork kinwork/.envs/.local/a.env true true");
    expect(f.secrets).toEqual({ "exe-worker-kinwork-golden": TOKEN, "exe-vm-kinwork-golden": PROXY });
  });
  test("waits for ssh, retrying every 5 s", async () => {
    const f = fakes({ sshUp: 3 });
    expect((await buildGolden("kinwork", f.deps)).ok).toBe(true);
    expect(f.calls.filter((c) => c === "ssh true")).toHaveLength(4);
  });
  test("refuses: an existing golden, a busy pool, an unknown ship, a ship without a repo mapping", async () => {
    expect((await buildGolden("kinwork", fakes({ vms: [vm("kinwork-golden", "stopped")] }).deps)).message).toContain("already exists");
    const busy = fakes({ vms: [vm("pochteca-a-b")] });
    expect((await buildGolden("kinwork", busy.deps)).message).toContain("no room");
    expect(busy.calls).toEqual([]);
    expect((await buildGolden("nope", fakes().deps)).ok).toBe(false);
    expect((await buildGolden("../x", fakes().deps)).message).toContain("not a ship id");
    const noRepo = fakes();
    noRepo.deps.ships = async () => [{ id: "other" }];
    expect((await buildGolden("other", noRepo.deps)).message).toContain("no repo mapping");
    expect((await buildGolden("fleet", noRepo.deps)).message).toContain("not a ship on this fleet");
    expect(noRepo.calls).toEqual([]);
  });
  test("a running golden does not count as a busy pool; rebuild removes the old one and its tokens first", async () => {
    const f = fakes({ vms: [vm("kinwork-golden"), vm("pochteca-golden", "stopped")] });
    f.deps.rebuild = true;
    expect((await buildGolden("kinwork", f.deps)).ok).toBe(true);
    expect(f.calls.slice(0, 2)).toEqual(["rm kinwork-golden", "forget kinwork-golden"]);
  });
  test("the worker token must be 64 hex characters; a bad body fails, is never logged, and the VM is still paused", async () => {
    const bad = "oops secret-ish output";
    const f = fakes({ tokenBody: bad });
    const r = await buildGolden("kinwork", f.deps);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(bad);
    expect(f.secrets).toEqual({});
    expect(f.calls.at(-1)).toBe("pause kinwork-golden");
    expect(f.calls.some((c) => c.includes("warm") || c.includes("seal"))).toBe(false);
  });
  test("env files pushed only when the hub has some", async () => {
    const f = fakes();
    await buildGolden("kinwork", f.deps);
    expect(f.calls.some((c) => c.startsWith("putEnv"))).toBe(false);
  });
  test("a warm failure fails the build but still seals and pauses", async () => {
    const f = fakes({ fail: /warm/ });
    const r = await buildGolden("kinwork", f.deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("warm kinwork failed");
    expect(f.calls.slice(-2)).toEqual(["ssh voyage-vm-setup seal", "pause kinwork-golden"]);
  });
  test("a setup failure stops there and pauses without deleting", async () => {
    const f = fakes({ fail: /setup kinwork/ });
    const r = await buildGolden("kinwork", f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.some((c) => c.startsWith("rm "))).toBe(false);
    expect(f.calls.at(-1)).toBe("pause kinwork-golden");
    expect(f.calls.some((c) => c.includes("token"))).toBe(false);
  });
  test("no secret reaches the log", async () => {
    const f = fakes({ files: { "kinwork/.envs/.local/a.env": "SECRET=hunter2" } });
    const r = await buildGolden("kinwork", f.deps);
    const all = JSON.stringify(r);
    for (const s of [TOKEN, PROXY, "hunter2"]) expect(all).not.toContain(s);
  });
  test("env files over the worker's limit fail before they are sent", async () => {
    const f = fakes({ files: { "a/b": "x".repeat(300_000) } });
    const r = await buildGolden("kinwork", f.deps);
    expect(r.ok).toBe(false);
    expect(f.calls.some((c) => c.startsWith("putEnv"))).toBe(false);
  });
});

describe("readEnvStore", () => {
  test("reads the store but skips production files, ._ files, and production directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "envstore-"));
    for (const [rel, text] of Object.entries({ "kinwork/.envs/.local/django": "A=1", "kinwork/.envs/.local/._django": "x", "kinwork/.envs/.production/django": "P=1", "kinwork/.envs/.Production.env": "P=2", "kinwork/._envs": "x" })) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    expect(await readEnvStore("kinwork", root)).toEqual({ "kinwork/.envs/.local/django": "A=1" });
    rmSync(root, { recursive: true, force: true });
  });
});
