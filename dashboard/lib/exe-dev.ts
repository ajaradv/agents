import { readSecret } from "./secret-store.ts";

/**
 * exe.dev, driven from the hub (R2 of vault plan fleet/plans/feature/ship-rigging).
 * The HTTPS API is the SSH command line in a POST body: `POST https://exe.dev/exec`
 * with a bearer token; output is JSON, the exit code is the X-Exe-Exit
 * header (or trailer). The hub's token is scoped to the `fleet-voyage` tag, so
 * it can create, copy, pause, and delete voyage VMs and never touch the hub.
 */

export const VOYAGE_TAG = "fleet-voyage";
const NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type ExeVm = { vm_name: string; status: string; dns_name: string; https_url?: string; tags?: string[]; allocated_cpus?: number; memory_capacity_bytes?: number };
export type ExecResult = { ok: boolean; exit: number; body: string };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const vmNameOk = (name: string) => NAME_RE.test(name);

const EXIT_MARK = "__fleet_exit=";

/** An `ssh` result with the status the VM's shell printed last (stderr may follow it: exe.dev appends it). */
export function sshResult(r: ExecResult): ExecResult {
  const lines = r.body.split("\n");
  let at = -1;
  lines.forEach((l, i) => {
    if (/^__fleet_exit=\d+$/.test(l.trim())) at = i;
  });
  if (at < 0) return { ok: false, exit: r.ok ? -1 : r.exit, body: r.body };
  const exit = Number(lines[at]!.trim().slice(EXIT_MARK.length));
  const body = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n");
  return { ok: r.ok && exit === 0, exit, body };
}

/** The hub's exe.dev token (secret "exe-dev-voyage-token": Keychain on the laptop, a 0600 file on the hub). */
export const exeToken = () => readSecret("exe-dev-voyage-token");

export function exeClient(deps: { token?: () => Promise<string>; fetch?: Fetch; endpoint?: string } = {}) {
  const token = deps.token ?? exeToken;
  const doFetch: Fetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const endpoint = deps.endpoint ?? "https://exe.dev/exec";

  async function exec(command: string, timeoutMs = 120_000): Promise<ExecResult> {
    const t = await token();
    if (!t) return { ok: false, exit: -1, body: "no exe.dev token (secret exe-dev-voyage-token)" };
    const r = await doFetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${t}` }, body: command, signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.text();
    const exit = Number(r.headers.get("X-Exe-Exit") ?? (r.ok ? 0 : 1));
    return { ok: r.ok && exit === 0, exit, body };
  }

  const named = (name: string) => {
    if (!vmNameOk(name)) throw new Error(`not a VM name: ${name}`);
    return name;
  };
  const json = <T>(r: ExecResult): T => {
    if (!r.ok) throw new Error(`exe.dev: ${r.body.slice(0, 300)}`);
    return JSON.parse(r.body) as T;
  };

  return {
    exec,
    /** The voyage VMs (the token sees only its tag's VMs). */
    async ls(): Promise<ExeVm[]> {
      return (json<{ vms?: ExeVm[] }>(await exec("ls --json")).vms ?? []).filter((v) => !v.tags || v.tags.includes(VOYAGE_TAG));
    },
    async cp(source: string, name: string): Promise<ExeVm> {
      return json<ExeVm>(await exec(`cp ${named(source)} ${named(name)} --copy-tags --json`, 300_000));
    },
    async pause(name: string): Promise<void> {
      json(await exec(`pause ${named(name)} --json`));
    },
    async resume(name: string): Promise<void> {
      json(await exec(`resume ${named(name)} --json`));
    },
    async rm(name: string): Promise<void> {
      json(await exec(`rm ${named(name)} --json`));
    },
    /**
     * Run a command on a VM as its user. The command string goes through a shell on exe.dev's side,
     * so callers pass only fixed strings built from validated ids (ship ids), never user text.
     */
    async ssh(vm: string, command: string, timeoutMs = 300_000): Promise<ExecResult> {
      // exe.dev answers 200 with no exit header for `ssh` whatever the command did (verified live:
      // `false` and `exit 3` both came back "ok"), so the VM's shell reports the status itself.
      const r = await exec(`ssh ${named(vm)} ${command}; echo ${EXIT_MARK}$?`, timeoutMs);
      return sshResult(r);
    },
    /**
     * A VM token for the worker behind exe.dev's proxy (X-Exedev-Authorization), expiring with the voyage.
     * exe.dev keeps each as a key on the account, named by its label, after the VM is gone (until it
     * expires), so the label carries a suffix: a later VM with the same name must not collide.
     */
    async vmToken(name: string, exp = "14d", suffix = Date.now().toString(36)): Promise<string> {
      const r = json<{ token?: string; api_key?: string }>(await exec(`ssh-key generate-api-key --vm=${named(name)} --label=fleet-${named(name)}-${suffix.replace(/[^a-z0-9]/g, "")} --exp=${/^\d+[dhy]$/.test(exp) ? exp : "14d"} --json`));
      const t = r.token ?? r.api_key ?? "";
      if (!t) throw new Error("exe.dev returned no VM token");
      return t;
    },
  };
}

export type ExeClient = ReturnType<typeof exeClient>;

/** A voyage VM's name: the ship and the voyage's short name, inside exe.dev's limits. */
export function voyageVmName(ship: string, slug: string): string {
  const s = `${ship}-${slug}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 48).replace(/-+$/, "");
}

export const goldenVmName = (ship: string) => voyageVmName(ship, "golden");
