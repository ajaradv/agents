import { describe, expect, test } from "bun:test";
import { goldenProject, keepImages, warmGolden, warmPlan, type WarmDeps } from "../golden-warm.ts";
import type { RigDecl } from "./rig.ts";

const rig: RigDecl = { env: ["kinwork/.envs"], vars: {}, up: ["docker compose up -d", "make seed"], ready: "http://localhost:${FLEET_RIG_PORT}/", down: "docker compose down -v --rmi local" };

function deps(o: { failOn?: string; notReady?: boolean; envOk?: boolean } = {}) {
  const calls: string[] = [];
  const d: WarmDeps = {
    run: async (s) => (calls.push(`run ${s}`), o.failOn && s.includes(o.failOn) ? { ok: false, tail: "bad tail" } : { ok: true, tail: "" }),
    ready: async (u) => (calls.push(`ready ${u}`), o.notReady ? { ok: false, tail: "no 200" } : { ok: true, tail: "" }),
    copyEnv: async () => (calls.push("copy"), { ok: o.envOk !== false, message: "1 env entry copied" }),
    removeEnv: async () => void calls.push("remove"),
    log: () => {},
    now: (() => { let t = 0; return () => (t += 1000); })(),
  };
  return { calls, d };
}

describe("golden warm planning", () => {
  test("project: ship id with _ as -, then -golden", () => {
    expect(goldenProject("lineage_atria")).toBe("lineage-atria-golden");
    expect(goldenProject("kinwork")).toBe("kinwork-golden");
  });
  test("down keeps images: --rmi local|all removed in either spelling, other flags stay", () => {
    expect(keepImages("docker compose down -v --rmi local")).toBe("docker compose down -v");
    expect(keepImages("docker compose down --rmi=all --remove-orphans")).toBe("docker compose down --remove-orphans");
    expect(keepImages("docker compose down")).toBe("docker compose down");
  });
  test("ready URL gets port 4100 and the golden slug", () => {
    expect(warmPlan("kinwork", rig).ready).toBe("http://localhost:4100/");
    expect(warmPlan("lineage_atria", { ...rig, ready: "http://${FLEET_RIG_SLUG}.localhost:${FLEET_RIG_PORT}/" }).ready).toBe("http://golden.localhost:4100/");
    expect(warmPlan("x", { ...rig, ready: "" }).ready).toBe("");
  });
});

describe("warmGolden", () => {
  test("env, each up step in its own subshell, ready, down without --rmi, then env removed", async () => {
    const { calls, d } = deps();
    const r = await warmGolden("kinwork", rig, d);
    expect(r).toMatchObject({ ok: true, seconds: 1 });
    expect(calls).toEqual(["copy", "run ( docker compose up -d )", "run ( make seed )", "ready http://localhost:4100/", "run docker compose down -v", "remove"]);
  });
  test("a failing up step stops the rest, prints its tail, and still tears down", async () => {
    const { calls, d } = deps({ failOn: "up -d" });
    const r = await warmGolden("kinwork", rig, d);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("bad tail");
    expect(calls).toEqual(["copy", "run ( docker compose up -d )", "run docker compose down -v", "remove"]);
  });
  test("not ready fails but tears down", async () => {
    const { calls, d } = deps({ notReady: true });
    expect((await warmGolden("kinwork", rig, d)).ok).toBe(false);
    expect(calls.at(-2)).toBe("run docker compose down -v");
  });
  test("missing env files fail before anything runs, and the leftovers are removed", async () => {
    const { calls, d } = deps({ envOk: false });
    const r = await warmGolden("kinwork", rig, d);
    expect(r.ok).toBe(false);
    expect(calls.filter((c) => c.startsWith("run ("))).toEqual([]);
    expect(calls.at(-1)).toBe("remove");
  });
});
