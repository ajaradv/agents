import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShipRow } from "./fleet-layers.ts";

const inbox = mkdtempSync(join(tmpdir(), "rigging-inbox-"));
const overlay = mkdtempSync(join(tmpdir(), "rigging-overlay-"));
const prev = { inbox: process.env.FLEET_INBOX, overlay: process.env.FLEET_SHIP_OVERLAY_DIR };
process.env.FLEET_INBOX = inbox;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
const { parseRig, rigChecks } = await import("./rig.ts");
const g = await import("./rigging.ts");
const { voyageWorktree } = await import("./voyage-worktree.ts");
afterAll(() => {
  for (const [k, v] of [["FLEET_INBOX", prev.inbox], ["FLEET_SHIP_OVERLAY_DIR", prev.overlay]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(inbox, { recursive: true, force: true });
  rmSync(overlay, { recursive: true, force: true });
});

const rig = parseRig({ up: ["docker compose up -d"], ready: "http://localhost:${FLEET_RIG_PORT}/", down: "docker compose down -v" })!;
const ship = (id: string) => ({ id, path: "/x", crew: ["lead"], orchestrator: "lead", rig, checks: rigChecks(rig) }) as unknown as ShipRow;
const openVoyage = (id: string, host = "local") => {
  const wt = join(inbox, "wt", id);
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(inbox, "ships", id), { recursive: true });
  writeFileSync(join(inbox, "ships", id, "worktree.json"), JSON.stringify({ ship: id, path: wt, leaseId: "l", branch: "b", base: "main", gitDir: "", primaryBranch: "main", started: "", host }));
};

describe("rigging a voyage", () => {
  test("Set sail plans a project and the lowest free port on that host; the next voyage takes the next port", () => {
    openVoyage("alpha");
    openVoyage("beta");
    const a = g.planRig(ship("alpha"), "Five variants", "local");
    const b = g.planRig(ship("beta"), "x", "local");
    expect(a).toMatchObject({ project: "alpha-five-variants", port: 4100, preview: "http://localhost:4100/", state: "pending" });
    expect(b).toMatchObject({ port: 4101 });
    expect(g.planRig({ id: "none", rig: null }, "x", "local")).toBeNull();
  });

  test("ready: the held brief goes out once, with the preview; a second rig sends nothing", async () => {
    const sent: [string, string][] = [];
    const ran: string[] = [];
    const deps = { runCheck: (async (_s: string, _by: string, name: string) => (ran.push(name), { ok: true, message: "ok" })) as never, notify: (() => ({})) as never };
    const { updateVoyageRig } = await import("./voyage-worktree.ts");
    updateVoyageRig("alpha", { brief: { to: "alpha-lead", text: "New voyage for alpha" } });
    const r = await g.rigVoyage(ship("alpha"), async (to, text) => void sent.push([to, text]), "helm", deps);
    expect(r.ok).toBe(true);
    expect(ran).toEqual(["rig"]);
    expect(sent.length).toBe(1);
    expect(sent[0]![0]).toBe("alpha-lead");
    expect(sent[0]![1]).toContain("New voyage for alpha");
    expect(sent[0]![1]).toContain("http://localhost:4100/");
    expect(voyageWorktree("alpha")!.rig).toMatchObject({ state: "ready" });
    expect(voyageWorktree("alpha")!.rig!.brief).toBeUndefined();
    await g.rigVoyage(ship("alpha"), async (to, text) => void sent.push([to, text]), "helm", deps);
    expect(sent.length).toBe(1);
  });

  test("failed: the brief is held, the captain gets a blocked notice, and the record says what failed", async () => {
    const notices: { kind: string; summary: string }[] = [];
    const sent: string[] = [];
    const { updateVoyageRig } = await import("./voyage-worktree.ts");
    updateVoyageRig("beta", { brief: { to: "beta-lead", text: "brief" } });
    const deps = { runCheck: (async () => ({ ok: false, message: "Check rig failed\n\nerror: relation search_policyupdate does not exist" })) as never, notify: ((n: { kind: string; summary: string }) => (notices.push(n), {})) as never };
    const r = await g.rigVoyage(ship("beta"), async (to) => void sent.push(to), "helm", deps);
    expect(r.ok).toBe(false);
    expect(sent).toEqual([]);
    expect(notices[0]!.kind).toBe("blocked");
    expect(notices[0]!.summary).toContain("could not be rigged");
    expect(voyageWorktree("beta")!.rig).toMatchObject({ state: "failed", brief: { to: "beta-lead" } });
    expect(voyageWorktree("beta")!.rig!.message).toContain("search_policyupdate");
  });

  test("env files missing from the store fail before any step runs", async () => {
    openVoyage("gamma");
    const withEnv = { ...ship("gamma"), rig: { ...rig, env: [".envs"] } } as ShipRow;
    g.planRig(withEnv, "x", "local");
    const ran: string[] = [];
    const deps = { runCheck: (async (_s: string, _b: string, n: string) => (ran.push(n), { ok: true, message: "" })) as never, notify: (() => ({})) as never };
    const r = await g.rigVoyage(withEnv, null, "helm", deps);
    expect(r.message).toContain("env files");
    expect(ran).toEqual([]);
  });

  test("dock takes the stack down with rig-down; a ship without a rig is left alone", async () => {
    const ran: string[] = [];
    await g.unrigVoyage(ship("alpha"), { runCheck: (async (_s: string, _b: string, n: string) => (ran.push(n), { ok: true, message: "" })) as never });
    await g.unrigVoyage({ ...ship("alpha"), checks: {} } as ShipRow, { runCheck: (async () => (ran.push("x"), { ok: true, message: "" })) as never });
    expect(ran).toEqual(["rig-down"]);
    expect(JSON.parse(readFileSync(join(inbox, "ships", "alpha", "worktree.json"), "utf8")).rig.port).toBe(4100);
  });
});
