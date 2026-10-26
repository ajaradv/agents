import { describe, expect, test } from "bun:test";
import { exeClient, goldenVmName, sshResult, voyageVmName } from "./exe-dev.ts";

/** A fake exe.dev /exec: records the commands, answers from a table. */
function fakeExe(answers: Record<string, { body: unknown; exit?: number }>) {
  const seen: string[] = [];
  const fetch = async (_url: string, init: RequestInit) => {
    const cmd = String(init.body);
    seen.push(cmd);
    const key = Object.keys(answers).find((k) => cmd.startsWith(k));
    const a = key ? answers[key]! : { body: { error: "unknown" }, exit: 1 };
    return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { headers: { "X-Exe-Exit": String(a.exit ?? 0) } });
  };
  return { seen, client: exeClient({ token: async () => "exe1.test", fetch }) };
}

describe("the exe.dev driver", () => {
  test("lists only voyage VMs, copies with tags, pauses, resumes, removes", async () => {
    const { seen, client } = fakeExe({
      "ls --json": { body: { vms: [{ vm_name: "kinwork-golden", status: "paused", dns_name: "kinwork-golden.exe.xyz", tags: ["fleet-voyage"] }, { vm_name: "other", status: "running", dns_name: "o.exe.xyz", tags: ["mine"] }] } },
      "cp ": { body: { vm_name: "kinwork-search", status: "running", dns_name: "kinwork-search.exe.xyz" } },
      "pause ": { body: {} },
      "resume ": { body: {} },
      "rm ": { body: {} },
    });
    expect((await client.ls()).map((v) => v.vm_name)).toEqual(["kinwork-golden"]);
    expect((await client.cp("kinwork-golden", "kinwork-search")).dns_name).toBe("kinwork-search.exe.xyz");
    await client.pause("kinwork-search");
    await client.resume("kinwork-search");
    await client.rm("kinwork-search");
    expect(seen).toEqual(["ls --json", "cp kinwork-golden kinwork-search --copy-tags --json", "pause kinwork-search --json", "resume kinwork-search --json", "rm kinwork-search --json"]);
  });

  test("a failing command throws with exe.dev's words; names are checked before anything is sent", async () => {
    const { seen, client } = fakeExe({ "rm ": { body: "permission denied: VM is not tagged fleet-voyage", exit: 1 } });
    await expect(client.rm("fleet-hub-k1s7")).rejects.toThrow("not tagged fleet-voyage");
    await expect(client.rm("x; rm -rf /")).rejects.toThrow("not a VM name");
    expect(seen).toEqual(["rm fleet-hub-k1s7 --json"]);
  });

  test("no token, no call", async () => {
    const client = exeClient({ token: async () => "", fetch: async () => new Response("should not be called") });
    expect(await client.exec("ls --json")).toMatchObject({ ok: false, body: expect.stringContaining("no exe.dev token") });
  });

  test("VM tokens expire with the voyage", async () => {
    const { seen, client } = fakeExe({ "ssh-key generate-api-key": { body: { token: "exe1.vm" } } });
    expect(await client.vmToken("kinwork-search", "14d", "k1")).toBe("exe1.vm");
    expect(seen[0]).toBe("ssh-key generate-api-key --vm=kinwork-search --label=fleet-kinwork-search-k1 --exp=14d --json");
  });

  test("VM names: the ship and the voyage, lowercase, inside exe.dev's limits", () => {
    expect(voyageVmName("lineage_atria", "Search Page!")).toBe("lineage-atria-search-page");
    expect(goldenVmName("kinwork")).toBe("kinwork-golden");
    expect(voyageVmName("kinwork", "x".repeat(80)).length).toBeLessThanOrEqual(48);
  });
});

describe("an exe.dev voyage VM as a ship host", () => {
  test("requests go to the VM's worker port through exe.dev's proxy with both tokens", async () => {
    const { exeVoyageHost } = await import("./exe-host.ts");
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const host = exeVoyageHost("kinwork-search", {
      secret: async (n) => (n === "exe-vm-kinwork-search" ? "exe1.vm" : n === "exe-worker-kinwork-search" ? "w0rker" : ""),
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return Response.json({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false, ms: 1 });
      },
    });
    expect([host.kind, host.label]).toEqual(["vm", "the exe.dev VM kinwork-search"]);
    const r = await host.exec(["git", "status"], { timeoutMs: 5000, cwd: "/home/exedev/kinwork" });
    expect(r.stdout).toBe("ok");
    expect(calls[0]!.url).toBe("https://kinwork-search.exe.xyz:8790/host/exec");
    expect(calls[0]!.headers).toMatchObject({ "X-Exedev-Authorization": "Bearer exe1.vm", Authorization: "Bearer w0rker" });
  });
});

describe("ssh results", () => {
  test("the status comes from the VM's shell: exe.dev answers ok for any ssh", () => {
    expect(sshResult({ ok: true, exit: 0, body: "made\n__fleet_exit=0\n" })).toEqual({ ok: true, exit: 0, body: "made\n" });
    expect(sshResult({ ok: true, exit: 0, body: "boom\n__fleet_exit=1\nerror on stderr\n" })).toEqual({ ok: false, exit: 1, body: "boom\nerror on stderr\n" });
    // No marker: the command never got to report (the VM or exe.dev failed first).
    expect(sshResult({ ok: true, exit: 0, body: "" }).ok).toBe(false);
  });

  test("ssh appends the status marker to the command", async () => {
    const { seen, client } = fakeExe({ "ssh v1 ": { body: "hi\n__fleet_exit=3\n" } });
    const r = await client.ssh("v1", "exit 3");
    expect(seen[0]).toBe("ssh v1 exit 3; echo __fleet_exit=$?");
    expect([r.ok, r.exit, r.body]).toEqual([false, 3, "hi\n"]);
  });
});
