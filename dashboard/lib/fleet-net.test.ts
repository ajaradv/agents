import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDevices, missingTools, onDevice, parseFacts, planUp } from "./fleet-net.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-net-"));

describe("fleet devices (N6)", () => {
  test("devices load with defaults; bad ones are reported, local always exists", () => {
    const f = join(dir, "net.yaml");
    writeFileSync(f, "defaults:\n  branch: fleet-reliability\ndevices:\n  old-macbook: { kind: ssh, ssh: fleet@old-macbook-pro }\n  exe-1: { kind: exe-dev, vm: fleet-1 }\n  Bad: { kind: ssh, ssh: x@y }\n  nokind: { ssh: x@y }\n  evil: { kind: ssh, ssh: \"x@y; rm -rf ~\" }\n");
    const { devices, problems } = loadDevices(f);
    expect(devices.map((d) => d.id)).toEqual(["local", "old-macbook", "exe-1"]);
    expect(devices[1]).toMatchObject({ branch: "fleet-reliability", codeDir: "~/Workspace/agents", ssh: "fleet@old-macbook-pro" });
    expect(devices[2]!.ssh).toBe("fleet-1.exe.xyz");
    expect(problems.length).toBe(3);
  });
  test("up: clone or update, install, test, references (never the token), services", () => {
    const d = loadDevices(join(dir, "net.yaml")).devices[1]!;
    const fresh = planUp(d, { repoUrl: "git@github.com:me/agents.git", hasRepo: false, envOp: true });
    expect(fresh.map((s) => s.step)).toEqual(["clone the repo", "install dependencies", "run the tests", "copy 1Password references (no secrets)", "install the services"]);
    expect(fresh.find((s) => s.step.startsWith("copy"))!.cmd).toContain("fleet/home/.env.op");
    expect(fresh.map((s) => s.cmd).join(" ")).not.toMatch(/op-service-account|OP_SERVICE_ACCOUNT_TOKEN|security find/);
    expect(planUp(d, { repoUrl: "x", hasRepo: true, envOp: false })[0]!.step).toBe("update the repo");
    expect(planUp(loadDevices().devices[0]!, { repoUrl: "x", hasRepo: true, envOp: true })).toEqual([{ step: "services", where: "here", cmd: "bin/fleet-services install" }]);
  });
  test("remote commands run in a login shell with their quotes intact", () => {
    const d = loadDevices(join(dir, "net.yaml")).devices[1]!;
    expect(onDevice(d, "echo 'hi there'")).toBe(`ssh -o BatchMode=yes -o ConnectTimeout=10 fleet@old-macbook-pro 'bash -lc '\\''echo '\\''\\'\\'''\\''hi there'\\''\\'\\'''\\'''\\'''`);
  });
  test("check reads the probe and says how to install what is missing", () => {
    const f = parseFacts("os=Darwin\narch=x86_64\ntool_git=yes\ntool_bun=no\ntool_pi=no\ntool_just=yes\n");
    expect(f.arch).toBe("x86_64");
    expect(missingTools(f).map((m) => m.tool)).toEqual(["bun", "pi"]);
    expect(missingTools({ ...f, os: "Linux" }).find((m) => m.tool === "bun")!.install).toContain("bun.sh/install");
  });
});
