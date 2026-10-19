import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { ROOT } from "./paths.ts";

/**
 * Fleet devices (N6, vault note pi-durable-news-agent; R5): the machines the
 * fleet can run on, in one file, and the steps that install the node there.
 *
 *   fleet/home/fleet-network.yaml   machine-local (gitignored), the real devices
 *   fleet/config/fleet-network.example.yaml   the documented example
 *
 * Kinds: `local` (this machine), `ssh` (a Mac with launchd or a Linux box with
 * systemd, reached over ssh, usually by its Tailscale name), `exe-dev` (an
 * exe.dev VM, reached as <vm>.exe.xyz over ssh). Secrets never live in the
 * file and never travel: `up` copies fleet/home/.env.op (1Password references
 * only); the service account token is stored on the device by hand.
 */

export type DeviceKind = "local" | "ssh" | "exe-dev";
export type Device = { id: string; name: string; kind: DeviceKind; ssh?: string; codeDir: string; branch: string; roles: string[] };
export type Step = { step: string; where: "here" | "device"; cmd: string };

export function networkPath(): string {
  return process.env.FLEET_NETWORK_FILE || join(ROOT, "fleet", "home", "fleet-network.yaml");
}

const LOCAL: Device = { id: "local", name: "This machine", kind: "local", codeDir: ROOT, branch: "", roles: ["gateway", "crews"] };

/** The devices in the file (plus `local`, always), and any problems with it. */
export function loadDevices(path = networkPath()): { devices: Device[]; problems: string[] } {
  const devices: Device[] = [LOCAL];
  const problems: string[] = [];
  if (!existsSync(path)) return { devices, problems };
  let raw: Record<string, unknown>;
  try {
    raw = (parse(readFileSync(path, "utf8")) ?? {}) as Record<string, unknown>;
  } catch (e) {
    return { devices, problems: [`${path} does not parse: ${String(e).slice(0, 160)}`] };
  }
  const defaults = (raw.defaults ?? {}) as Record<string, unknown>;
  const list = (raw.devices ?? {}) as Record<string, Record<string, unknown> | null>;
  for (const [id, d] of Object.entries(list)) {
    if (!d || id === "local") continue;
    const kind = String(d.kind ?? "") as DeviceKind;
    const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : typeof defaults[k] === "string" ? (defaults[k] as string) : "");
    const device: Device = {
      id,
      name: str("name") || id,
      kind,
      ssh: kind === "exe-dev" && !str("ssh") ? `${str("vm") || id}.exe.xyz` : str("ssh"),
      codeDir: str("code_dir") || "~/Workspace/agents",
      branch: str("branch") || "main",
      roles: Array.isArray(d.roles) ? (d.roles as unknown[]).map(String) : ["gateway", "crews"],
    };
    const bad = !/^[a-z][a-z0-9-]{0,40}$/.test(id) ? "needs an id (lowercase, dashes)" : !["ssh", "exe-dev"].includes(kind) ? `has kind "${kind}" (ssh or exe-dev)` : !/^[\w.@-]{1,120}$/.test(device.ssh ?? "") ? "needs ssh: user@host (a Tailscale name works)" : !/^[\w./~-]{1,200}$/.test(device.codeDir) ? "has a code_dir with unusual characters" : !/^[\w./-]{1,100}$/.test(device.branch) ? "has a branch name with unusual characters" : null;
    if (bad) problems.push(`${id} ${bad}`);
    else devices.push(device);
  }
  return { devices, problems };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A remote command, run with a login shell so Homebrew's and Bun's paths resolve. */
export function onDevice(d: Device, cmd: string): string {
  return d.kind === "local" ? cmd : `ssh -o BatchMode=yes -o ConnectTimeout=10 ${d.ssh} ${q(`bash -lc ${q(cmd)}`)}`;
}

/** What `check` asks the device: one line per fact, KEY=value. */
export const PROBE = [
  'echo "os=$(uname -s)"',
  'echo "arch=$(uname -m)"',
  'echo "version=$( (sw_vers -productVersion 2>/dev/null || . /etc/os-release 2>/dev/null && echo ${VERSION_ID:-}) | head -1)"',
  'for t in git bun node just jq pi tailscale docker; do printf "tool_%s=%s\\n" "$t" "$(command -v $t >/dev/null 2>&1 && echo yes || echo no)"; done',
  'echo "cpus=$( (sysctl -n hw.ncpu 2>/dev/null || nproc) | head -1)"',
  'echo "memory_gb=$( (sysctl -n hw.memsize 2>/dev/null | awk "{print int(\\$1/1073741824)}") || free -g | awk "/Mem:/ {print \\$2}")"',
  'echo "disk_free=$(df -h ~ | awk "NR==2 {print \\$4}")"',
  // The repo clones over GitHub SSH: the device needs its own key (or gh auth) for a private repo.
  'echo "github=$(ssh -o BatchMode=yes -o ConnectTimeout=8 -T git@github.com 2>&1 | grep -q "successfully authenticated" && echo yes || echo no)"',
].join("; ");

export function repoProbe(d: Device): string {
  return `cd ${d.codeDir} 2>/dev/null && echo "repo=yes" && echo "branch=$(git branch --show-current)" && echo "head=$(git log --oneline -1 | cut -c1-60)" || echo "repo=no"`;
}

/** Parse KEY=value lines from the probe. */
export function parseFacts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** Tools the node needs on the device, missing ones with how to install them. */
export function missingTools(facts: Record<string, string>): { tool: string; install: string }[] {
  const mac = facts.os === "Darwin";
  const how: Record<string, string> = {
    git: mac ? "xcode-select --install" : "sudo apt-get install -y git",
    bun: "curl -fsSL https://bun.sh/install | bash",
    node: mac ? "brew install node" : "sudo apt-get install -y nodejs",
    just: mac ? "brew install just" : "sudo apt-get install -y just",
    jq: mac ? "brew install jq" : "sudo apt-get install -y jq",
    pi: "npm install -g @earendil-works/pi-coding-agent",
  };
  return Object.keys(how).filter((t) => facts[`tool_${t}`] === "no").map((tool) => ({ tool, install: how[tool]! }));
}

/** The steps that install or update the fleet on a device. Nothing secret is copied. */
export function planUp(d: Device, opts: { repoUrl: string; hasRepo: boolean; envOp: boolean }): Step[] {
  if (d.kind === "local") return [{ step: "services", where: "here", cmd: "bin/fleet-services install" }];
  const dir = d.codeDir;
  const steps: Step[] = [];
  steps.push(
    opts.hasRepo
      ? { step: "update the repo", where: "device", cmd: `cd ${dir} && git fetch origin && git checkout ${d.branch} && git pull --ff-only origin ${d.branch}` }
      : { step: "clone the repo", where: "device", cmd: `mkdir -p $(dirname ${dir}) && git clone --branch ${d.branch} ${opts.repoUrl} ${dir}` },
    { step: "install dependencies", where: "device", cmd: `cd ${dir} && bun install` },
    { step: "run the tests", where: "device", cmd: `cd ${dir} && just test` },
  );
  if (opts.envOp) steps.push({ step: "copy 1Password references (no secrets)", where: "here", cmd: `ssh ${d.ssh} 'mkdir -p ${dir}/fleet/home' && scp -q fleet/home/.env.op ${d.ssh}:${dir}/fleet/home/.env.op` });
  steps.push({ step: "install the services", where: "device", cmd: `cd ${dir} && bin/fleet-services install` });
  return steps;
}
