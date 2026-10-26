import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exeClient, goldenVmName, type ExeClient } from "./exe-dev.ts";
import { EXE_WORKER_PORT, forgetVoyageVm } from "./exe-host.ts";
import { readShips } from "./fleet-layers.ts";
import { ENV_STORE_LIMITS } from "./hosted.ts";
import { rigStore } from "./rig.ts";
import { writeSecret } from "./secret-store.ts";

/**
 * Building a ship's golden VM with one command (bin/fleet-exe golden <ship>),
 * which was done by hand for Kinwork: create the VM, clone the agents repo
 * over exe.dev's GitHub integration, `voyage-vm-setup setup`, a worker token
 * made on the VM and kept on the hub, the rig's env files through the
 * worker, `voyage-vm-setup warm` (the rig built once, images kept), seal, and
 * pause. The pool fits one 2-vCPU VM beside the hub, so no voyage VM may be
 * running. A failed build still pauses the VM (the captain may inspect it).
 */

/** Ships bin/voyage-vm-setup knows a repo for. */
export const GOLDEN_SHIPS = ["fleet", "kinwork", "pochteca", "lineage_atria"];
const SHIP_ID = /^[a-z][a-z0-9_-]{0,40}$/;
// exe.dev's `ssh <vm> <command>` acts like OpenSSH: one layer of quotes is stripped and the joined
// string runs in the VM's shell, so commands here are plain shell with no nested quoting (verified live).
const AGENTS_CLONE = "test -d ~/Workspace/agents/.git || git clone -q https://github.int.exe.xyz/ajaradv/agents.git ~/Workspace/agents";
const SETUP = "~/Workspace/agents/bin/voyage-vm-setup";

export type EnvFiles = Record<string, string>;
export type WorkerTokens = { proxy: string; worker: string };

export type GoldenDeps = {
  client?: Pick<ExeClient, "exec" | "ls" | "rm" | "ssh" | "pause" | "vmToken">;
  ships?: () => Promise<{ id: string }[]>;
  writeSecret?: (name: string, value: string) => Promise<boolean>;
  forget?: (vm: string) => Promise<unknown>;
  /** The hub's env store for the ship (rig env files, production and `._*` already left out). */
  envFiles?: (shipId: string) => Promise<EnvFiles>;
  /** POST /host/env-store on the golden's worker; throws while the worker is unreachable. */
  putEnv?: (vm: string, tokens: WorkerTokens, shipId: string, files: EnvFiles) => Promise<{ ok: boolean; message: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rebuild?: boolean;
  /** Each log line as it happens (the CLI shows progress during a 30-minute build). */
  onLog?: (line: string) => void;
};

export type GoldenResult = { ok: boolean; message: string; log: string[] };

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lastLines = (s: string) => s.trim().split("\n").slice(-3).join(" | ").slice(0, 400);

/** The hub's env store for a ship as {relpath: text}, leaving out production files, macOS `._*` files, and links. */
export async function readEnvStore(shipId: string, root = rigStore(shipId)): Promise<EnvFiles> {
  const out: EnvFiles = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith("._") || /production/i.test(r)) continue;
      if (e.isDirectory()) await walk(join(root, r), r);
      else if (e.isFile()) out[r] = await readFile(join(root, r), "utf8");
    }
  };
  await walk(root, "");
  return out;
}

async function putEnvReal(vm: string, t: WorkerTokens, ship: string, files: EnvFiles): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`https://${vm}.exe.xyz:${EXE_WORKER_PORT}/host/env-store`, {
    method: "POST",
    headers: { "X-Exedev-Authorization": `Bearer ${t.proxy}`, Authorization: `Bearer ${t.worker}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ship, files }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as { ok?: boolean; message?: string };
  return { ok: res.ok && body.ok === true, message: String(body.message ?? `HTTP ${res.status}`) };
}

/** Build (or with `rebuild`, rebuild) the ship's golden VM on exe.dev. Everything it touches comes in through `deps`. */
export async function buildGolden(shipId: string, deps: GoldenDeps = {}): Promise<GoldenResult> {
  const log: string[] = [];
  const note = (l: string) => {
    log.push(l);
    deps.onLog?.(l);
  };
  const refuse = (message: string): GoldenResult => ({ ok: false, message, log });
  if (!SHIP_ID.test(shipId)) return refuse(`${shipId} is not a ship id.`);
  if (!GOLDEN_SHIPS.includes(shipId)) return refuse(`${shipId} has no repo mapping in voyage-vm-setup (${GOLDEN_SHIPS.join(", ")}).`);
  if (!(await (deps.ships ?? readShips)()).some((s) => s.id === shipId)) return refuse(`${shipId} is not a ship on this fleet.`);

  const client = deps.client ?? exeClient();
  const write = deps.writeSecret ?? writeSecret;
  const forget = deps.forget ?? ((vm: string) => forgetVoyageVm(vm));
  const sleep = deps.sleep ?? sleepReal;
  const now = deps.now ?? Date.now;
  const golden = goldenVmName(shipId);

  let vms;
  try {
    vms = await client.ls();
  } catch (e) {
    return refuse(`exe.dev did not answer (${e instanceof Error ? e.message : String(e)}).`);
  }
  const busy = vms.filter((v) => v.status === "running" && !v.vm_name.endsWith("-golden"));
  if (busy.length) return refuse(`exe.dev's pool has no room: ${busy.map((v) => v.vm_name).join(", ")} running. Dock or move those voyages first.`);
  if (vms.some((v) => v.vm_name === golden)) {
    if (!deps.rebuild) return refuse(`${golden} already exists (pass --rebuild to replace it).`);
    try {
      await client.rm(golden);
    } catch (e) {
      return refuse(`could not remove the old ${golden}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await forget(golden).catch(() => {});
    note(`removed the old ${golden} and its tokens`);
  }

  try {
    const made = await client.exec(`new --name=${golden} --cpu=2 --memory=4GB --disk=40GB --no-email --json`, 300_000);
    if (!made.ok) return refuse(`could not create ${golden}: ${lastLines(made.body)}`);
    JSON.parse(made.body);
    note(`created ${golden} (2 vCPU, 4 GB, 40 GB)`);
  } catch (e) {
    return refuse(`could not create ${golden}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // From here the VM exists: a failure is logged, and the VM is still paused at the end.
  let failure = "";
  let seal = false;
  const run = async (what: string, timeoutMs: number, command: string): Promise<boolean> => {
    const r = await client.ssh(golden, command, timeoutMs);
    if (!r.ok) {
      failure = `${what} failed (exit ${r.exit}): ${lastLines(r.body)}`;
      note(failure);
      return false;
    }
    note(`${what}: ok`);
    return true;
  };
  try {
    const end = now() + 180_000;
    for (;;) {
      if ((await client.ssh(golden, "true", 30_000).catch(() => ({ ok: false }))).ok) break;
      if (now() >= end) throw new Error(`${golden} did not accept ssh within 3 minutes`);
      await sleep(5_000);
    }
    note("ssh is up");
    if (!(await run("clone the agents repo", 300_000, AGENTS_CLONE))) throw new Error(failure);
    if (!(await run(`setup ${shipId}`, 20 * 60_000, `${SETUP} setup ${shipId}`))) throw new Error(failure);

    const t = await client.ssh(golden, `${SETUP} token --generate`, 60_000);
    // The body carries stderr too (exe.dev appends it): take the one line that is a token.
    const lines = t.body.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l));
    const worker = lines.length === 1 ? lines[0]! : "";
    if (!t.ok || !worker) throw new Error(`the VM did not return a worker token (exit ${t.exit})`);
    if (!(await write(`exe-worker-${golden}`, worker))) throw new Error(`could not store exe-worker-${golden}`);
    note(`worker token made on the VM and stored as exe-worker-${golden}`);
    const proxy = await client.vmToken(golden, "90d");
    if (!(await write(`exe-vm-${golden}`, proxy))) throw new Error(`could not store exe-vm-${golden}`);
    note(`proxy token (90 days) stored as exe-vm-${golden}`);

    const files = await (deps.envFiles ?? ((s: string) => readEnvStore(s)))(shipId);
    const names = Object.keys(files);
    if (!names.length) note("the hub has no env files for this ship; none pushed");
    else {
      const bytes = Object.values(files).reduce((n, f) => n + Buffer.byteLength(f), 0);
      if (names.length > ENV_STORE_LIMITS.files || bytes > ENV_STORE_LIMITS.bytes) throw new Error(`the env store is over the worker's limit (${names.length} files, ${bytes} bytes)`);
      const put = deps.putEnv ?? putEnvReal;
      // The worker restarted with its new token: give it a moment to answer.
      const until = now() + 120_000;
      let r: { ok: boolean; message: string } | undefined;
      for (;;) {
        try {
          r = await put(golden, { proxy, worker }, shipId, files);
          break;
        } catch (e) {
          if (now() >= until) throw new Error(`the worker on ${golden} did not answer: ${e instanceof Error ? e.message : String(e)}`);
          await sleep(5_000);
        }
      }
      if (!r.ok) throw new Error(`the worker refused the env files: ${r.message}`);
      note(`pushed ${names.length} env file(s): ${r.message}`);
    }
    seal = true;
    await run(`warm ${shipId}`, 30 * 60_000, `${SETUP} warm ${shipId}`);
  } catch (e) {
    failure ||= e instanceof Error ? e.message : String(e);
    if (!log.includes(failure)) note(failure);
  }
  if (seal) {
    try {
      const r = await client.ssh(golden, `${SETUP} seal`, 120_000);
      note(r.ok ? `sealed: ${lastLines(r.body)}` : `seal failed (exit ${r.exit}): ${lastLines(r.body)}`);
      if (!r.ok) failure ||= "seal failed";
    } catch (e) {
      note(`seal failed: ${e instanceof Error ? e.message : String(e)}`);
      failure ||= "seal failed";
    }
  }
  try {
    await client.pause(golden);
    note(`paused ${golden}`);
  } catch (e) {
    note(`could not pause ${golden}: ${e instanceof Error ? e.message : String(e)}`);
    failure ||= "could not pause";
  }
  return failure ? { ok: false, message: `${golden} is not ready: ${failure}`, log } : { ok: true, message: `${golden} is built and paused.`, log };
}
