import { describe, expect, test } from "bun:test";
import { adoptVoyageVm, exeVoyageHost, forgetVoyageVm } from "./exe-host.ts";
import { ensureIngest } from "./worker-host.ts";

/** A secret store in memory. */
function store(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    read: async (n: string) => m.get(n) ?? "",
    write: async (n: string, v: string) => (m.set(n, v), true),
    remove: async (n: string) => (m.delete(n), true),
  };
}

type Call = { url: string; headers: Record<string, string>; body: string };
const fakeFetch = (reply: () => Response | Promise<Response>, calls: Call[] = []) => async (url: string, init: RequestInit) => {
  calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body ?? "") });
  return reply();
};

describe("exeVoyageHost", () => {
  test("sends this VM's two tokens, not another's", async () => {
    const calls: Call[] = [];
    const s = store({ "exe-vm-a": "proxy-a", "exe-worker-a": "worker-a", "exe-vm-b": "proxy-b", "exe-worker-b": "worker-b" });
    const host = exeVoyageHost("b", { secret: s.read, fetch: fakeFetch(() => Response.json({ ships: [] }), calls) });
    await host.repoPath({ id: "x", path: "" });
    expect(calls).toHaveLength(1);
    for (const c of calls) {
      expect(c.headers["X-Exedev-Authorization"]).toBe("Bearer proxy-b");
      expect(c.headers.Authorization).toBe("Bearer worker-b");
    }
  });
});

describe("adoptVoyageVm", () => {
  const golden = "g".repeat(64);
  const setup = (reply: () => Response | Promise<Response>) => {
    const s = store({ "exe-worker-gold": golden });
    const calls: Call[] = [];
    const deps = { vmToken: async () => "proxy-new", fetch: fakeFetch(reply, calls), read: s.read, write: s.write, random: () => "n".repeat(64) };
    return { s, calls, deps };
  };

  test("rotates the copy's token with the golden one and stores both new secrets", async () => {
    const { s, calls, deps } = setup(() => Response.json({ ok: true, message: "ok" }));
    expect(await adoptVoyageVm("v1", "gold", deps)).toEqual({ ok: true, message: expect.any(String) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://v1.exe.xyz:8790/host/token");
    expect(calls[0]!.headers["X-Exedev-Authorization"]).toBe("Bearer proxy-new");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${golden}`);
    expect(JSON.parse(calls[0]!.body)).toEqual({ token: "n".repeat(64) });
    expect(s.m.get("exe-vm-v1")).toBe("proxy-new");
    expect(s.m.get("exe-worker-v1")).toBe("n".repeat(64));
    expect(s.m.get("exe-worker-v1")).not.toBe(golden);
  });

  test("a retry reuses the VM token minted before: each mint adds a key to the account", async () => {
    let mints = 0;
    let up = false;
    const { s, deps } = setup(() => (up ? Response.json({ ok: true, message: "ok" }) : Promise.reject(new Error("not up yet"))));
    const d = { ...deps, vmToken: async () => (mints++, "proxy-new") };
    expect((await adoptVoyageVm("v1", "gold", d)).ok).toBe(false);
    up = true;
    expect((await adoptVoyageVm("v1", "gold", d)).ok).toBe(true);
    expect(mints).toBe(1);
    expect(s.m.get("exe-vm-v1")).toBe("proxy-new");
  });

  test("stores no worker token when the VM refuses", async () => {
    const { s, deps } = setup(() => Response.json({ ok: false, message: "no" }, { status: 401 }));
    const r = await adoptVoyageVm("v1", "gold", deps);
    expect(r.ok).toBe(false);
    expect(s.m.has("exe-worker-v1")).toBe(false);
  });

  test("stores no worker token when the VM is unreachable", async () => {
    const { s, deps } = setup(() => Promise.reject(new Error("ECONNREFUSED")));
    const r = await adoptVoyageVm("v1", "gold", deps);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("ECONNREFUSED");
    expect(s.m.has("exe-worker-v1")).toBe(false);
  });

  test("refuses without a golden token, and never reuses it", async () => {
    const { s, deps } = setup(() => Response.json({ ok: true }));
    expect((await adoptVoyageVm("v1", "other", deps)).ok).toBe(false);
    expect((await adoptVoyageVm("v1", "gold", { ...deps, random: () => golden })).ok).toBe(false);
    expect(s.m.has("exe-worker-v1")).toBe(false);
  });
});

describe("adoptVoyageVm and the VM's outbox", () => {
  const golden = "g".repeat(64);
  test("after the new worker token, the VM gets the node's ingest address and its own ingest token", async () => {
    process.env.FLEET_NODE_PUBLIC_URL = "https://hub.tail1234.ts.net:8786/";
    try {
      const s = store({ "exe-worker-gold": golden });
      const calls: Call[] = [];
      const deps = { vmToken: async () => "proxy-new", fetch: fakeFetch(() => Response.json({ ok: true, message: "ok" }), calls), read: s.read, write: s.write, random: () => "n".repeat(64) };
      expect((await adoptVoyageVm("v1", "gold", deps)).ok).toBe(true);
      expect(calls.map((c) => c.url)).toEqual(["https://v1.exe.xyz:8790/host/token", "https://v1.exe.xyz:8790/host/ingest-config"]);
      const ingest = calls[1]!;
      // Sent with the worker token it just got, through the VM's proxy token.
      expect(ingest.headers.Authorization).toBe(`Bearer ${"n".repeat(64)}`);
      expect(ingest.headers["X-Exedev-Authorization"]).toBe("Bearer proxy-new");
      const sent = JSON.parse(ingest.body) as { url: string; token: string; source: string };
      expect(sent).toMatchObject({ url: "https://hub.tail1234.ts.net:8786/v1/ingest", source: "v1" });
      expect(sent.token).toMatch(/^[0-9a-f]{64}$/);
      expect(s.m.get("ingest-v1")).toBe(sent.token);
      expect(sent.token).not.toBe(s.m.get("exe-worker-v1"));
    } finally {
      delete process.env.FLEET_NODE_PUBLIC_URL;
    }
  });
  test("a VM that does not take the ingest settings still sails", async () => {
    process.env.FLEET_NODE_PUBLIC_URL = "https://hub.tail1234.ts.net:8786";
    try {
      const s = store({ "exe-worker-gold": golden });
      let n = 0;
      const deps = { vmToken: async () => "proxy-new", fetch: fakeFetch(() => (n++ ? new Response("no", { status: 500 }) : Response.json({ ok: true }))), read: s.read, write: s.write };
      expect((await adoptVoyageVm("v1", "gold", deps)).ok).toBe(true);
    } finally {
      delete process.env.FLEET_NODE_PUBLIC_URL;
    }
  });
});

describe("ensureIngest", () => {
  const send = (log: unknown[], ok = true) => async (cfg: unknown) => (log.push(cfg), ok);
  test("makes the worker's token once, then sends the same one again", async () => {
    const s = store();
    const log: { url: string; token: string; source: string }[] = [];
    const deps = { read: s.read, write: s.write, url: "https://hub.ts.net:8786" };
    expect((await ensureIngest("laptop", send(log), deps)).ok).toBe(true);
    expect((await ensureIngest("laptop", send(log), deps)).ok).toBe(true);
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ url: "https://hub.ts.net:8786/v1/ingest", source: "laptop" });
    expect(log[0]!.token).toHaveLength(64);
    expect(log[1]!.token).toBe(log[0]!.token);
    expect(s.m.get("ingest-laptop")).toBe(log[0]!.token);
  });
  test("no node address, a name that is not a host, a worker that refuses, or a failing send: not ok, nothing thrown", async () => {
    const s = store();
    expect((await ensureIngest("laptop", send([]), { read: s.read, write: s.write, url: "" })).ok).toBe(false);
    expect((await ensureIngest("Bad Name", send([]), { read: s.read, write: s.write, url: "https://h" })).ok).toBe(false);
    expect((await ensureIngest("laptop", send([], false), { read: s.read, write: s.write, url: "https://h" })).ok).toBe(false);
    expect((await ensureIngest("laptop", async () => { throw new Error("down"); }, { read: s.read, write: s.write, url: "https://h" })).ok).toBe(false);
    expect((await ensureIngest("laptop", send([]), { read: store().read, write: async () => false, url: "https://h" }))).toMatchObject({ ok: false });
  });
});

describe("forgetVoyageVm", () => {
  test("deletes the VM's tokens, ingest token included", async () => {
    const s = store({ "exe-vm-v1": "a", "exe-worker-v1": "b", "ingest-v1": "i", "ingest-v2": "j", "exe-worker-v2": "c" });
    expect(await forgetVoyageVm("v1", { remove: s.remove })).toBe(true);
    expect([...s.m.keys()].sort()).toEqual(["exe-worker-v2", "ingest-v2"]);
  });
  test("deletes both tokens", async () => {
    const s = store({ "exe-vm-v1": "a", "exe-worker-v1": "b", "exe-worker-v2": "c" });
    expect(await forgetVoyageVm("v1", { remove: s.remove })).toBe(true);
    expect([...s.m.keys()]).toEqual(["exe-worker-v2"]);
  });
});
