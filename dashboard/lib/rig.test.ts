import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseShipConfig } from "./fleet-layers.ts";
import { loopbackRequest, stylesheetHrefs } from "./rig-ready.ts";

const overlay = mkdtempSync(join(tmpdir(), "rig-overlay-"));
const prev = process.env.FLEET_SHIP_OVERLAY_DIR;
process.env.FLEET_SHIP_OVERLAY_DIR = overlay;
const r = await import("./rig.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_SHIP_OVERLAY_DIR;
  else process.env.FLEET_SHIP_OVERLAY_DIR = prev;
  rmSync(overlay, { recursive: true, force: true });
});

const decl = { env: ["kinwork/.envs"], vars: { COMPOSE_FILE: "a.yml:b.yml", PATH: "/evil", "bad-key": "x" }, up: ["cd kinwork && docker compose up -d", "cd kinwork && docker compose run --rm django python manage.py migrate"], ready: "http://localhost:${FLEET_RIG_PORT}/search/", down: "cd kinwork && docker compose down -v" };

describe("the rig contract", () => {
  test("a rig needs up steps; ready is optional but a URL; fleet variables and unsafe env paths are dropped", () => {
    const rig = r.parseRig({ ...decl, env: ["kinwork/.envs", "../secrets", "/etc/passwd"] })!;
    expect(rig.env).toEqual(["kinwork/.envs"]);
    expect(rig.vars).toEqual({ COMPOSE_FILE: "a.yml:b.yml" });
    expect(r.parseRig({ up: [] })).toBeNull();
    expect(r.parseRig({ up: ["make"], ready: "localhost:3000" })).toBeNull();
    expect(r.parseRig({ up: ["cargo build"] })).toMatchObject({ up: ["cargo build"], ready: "", down: "" });
  });

  test("rigging becomes the rig and rig-down checks; each step runs in its own subshell, then the ready probe", () => {
    const checks = r.rigChecks(r.parseRig(decl));
    expect(checks.rig).toBe('( cd kinwork && docker compose up -d ) && ( cd kinwork && docker compose run --rm django python manage.py migrate ) && "$FLEET_AGENTS/bin/rig-ready" "http://localhost:${FLEET_RIG_PORT}/search/"');
    expect(checks["rig-down"]).toBe("cd kinwork && docker compose down -v");
    expect(r.rigChecks(r.parseRig({ up: ["cargo build"] }))).toEqual({ rig: "( cargo build )" });
    expect(r.rigChecks(null)).toEqual({});
  });

  test("a rigged ship gets the checks and a standard rig maneuver, unless it declares its own", () => {
    const row = parseShipConfig({ id: "k", rig: decl, checks: { lint: "ruff" }, maneuvers: { tidy: { checks: ["lint"] } } }, "k");
    expect(Object.keys(row.checks)).toEqual(["lint", "rig", "rig-down"]);
    expect(row.maneuvers.map((m) => [m.name, m.checks, m.by])).toEqual([
      ["tidy", ["lint"], ["lead"]],
      ["rig", ["rig"], ["lead", "builder", "designer"]],
    ]);
    const own = parseShipConfig({ id: "k", rig: decl, maneuvers: { rig: { checks: ["rig"], by: ["lead"] } } }, "k");
    expect(own.maneuvers.filter((m) => m.name === "rig").map((m) => m.by)).toEqual([["lead"]]);
    expect(parseShipConfig({ id: "k" }, "k").rig).toBeNull();
  });

  test("each voyage gets a project and a free port; previews and records are checked", () => {
    expect(r.rigProject("kinwork", "Design five variants!")).toBe("kinwork-design-five-variants");
    expect(r.freePort([4100, 4101, 4103])).toBe(4102);
    expect(r.freePort(Array.from({ length: 100 }, (_, i) => 4100 + i))).toBeNull();
    expect(r.previewUrl(decl.ready, 4102)).toBe("http://localhost:4102/search/");
    expect(r.validRig({ project: "kinwork-x", port: 4102, slug: "x" })).toEqual({ project: "kinwork-x", port: 4102, slug: "x" });
    expect(r.validRig({ project: "kinwork-x; rm -rf /", port: 4102 })).toBeNull();
    expect(r.validRig({ project: "kinwork-x", port: 22 })).toBeNull();
  });

  test("environment: the voyage's project and port; outside a voyage the ship's vars in a checks project of its own", () => {
    const rig = r.parseRig(decl);
    expect(r.rigEnv(rig, { project: "kinwork-x", port: 4102, slug: "x" })).toEqual({ COMPOSE_FILE: "a.yml:b.yml", COMPOSE_PROJECT_NAME: "kinwork-x", FLEET_RIG_PORT: "4102", FLEET_RIG_SLUG: "x", FLEET_RIG_PREVIEW: "http://localhost:4102/search/" });
    expect(r.rigEnv(rig, null, "kinwork")).toEqual({ COMPOSE_FILE: "a.yml:b.yml", COMPOSE_PROJECT_NAME: "kinwork-checks" });
    expect(r.rigEnv(null, { project: "p", port: 4100, slug: "p" })).toEqual({});
  });

  test("env files come from this host's store into the worktree; a missing entry is named", async () => {
    const rig = r.parseRig(decl)!;
    const wt = mkdtempSync(join(tmpdir(), "rig-wt-"));
    expect((await r.copyRigEnv("kinwork", rig, wt)).message).toContain("kinwork/.envs");
    mkdirSync(join(r.rigStore("kinwork"), "kinwork", ".envs", ".local"), { recursive: true });
    writeFileSync(join(r.rigStore("kinwork"), "kinwork", ".envs", ".local", ".django"), "DJANGO_SECRET_KEY=test");
    expect((await r.copyRigEnv("kinwork", rig, wt)).ok).toBe(true);
    expect(readFileSync(join(wt, "kinwork", ".envs", ".local", ".django"), "utf8")).toBe("DJANGO_SECRET_KEY=test");
    rmSync(wt, { recursive: true, force: true });
    expect(existsSync(wt)).toBe(false);
  });
});

describe("the ready probe's stylesheets", () => {
  test("links with rel=stylesheet, made absolute; print and disabled ones skipped", () => {
    const html = `<link rel="stylesheet" href="/static/a.css"><link href='b.css' rel='preload stylesheet'><link rel=stylesheet href=/c.css media=print><link rel="stylesheet" href="/d.css" disabled><link rel="icon" href="/x.ico">`;
    expect(stylesheetHrefs(html, "http://localhost:4100/search/")).toEqual(["http://localhost:4100/static/a.css", "http://localhost:4100/search/b.css"]);
  });
});

describe("bin/launch sees a rigged ship as the node does", () => {
  test("the rig and rig-down checks and the rig maneuver for the builder", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-rig-"));
    const file = join(dir, "ship.yaml");
    writeFileSync(file, "id: x\ncrew:\n  - lead\n  - builder\nrig:\n  env: [.envs]\n  up:\n    - docker compose up -d\n  ready: http://localhost:${FLEET_RIG_PORT}/\n  down: docker compose down -v\nchecks:\n  lint: ruff\nmode: m\n");
    const py = `import importlib.util, importlib.machinery, json, pathlib, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
d = m.with_rig(m.parse_simple_yaml(pathlib.Path(sys.argv[2])))
print(json.dumps({"checks": sorted(d["checks"]), "builder": m.launchable_maneuvers(d, "builder", pathlib.Path(sys.argv[3])), "mode": d["mode"]}))`;
    const out = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", py, join(import.meta.dir, "..", "..", "bin", "launch"), file, dir]);
    expect(JSON.parse(out.stdout.toString())).toEqual({ checks: ["lint", "rig", "rig-down"], builder: ["rig"], mode: "m" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("short names and previews", () => {
  test("a voyage slug is words and hyphens, a letter first, at most 32 characters", () => {
    expect(r.rigSlug("2026 Design five variants of the search page, each one")).toBe("design-five-variants-of-the-sear");
    expect(r.rigSlug("---")).toBe("voyage");
    expect(r.rigSlug("Fix: login!")).toBe("fix-login");
  });
  test("previews fill in the port and the slug; *.localhost goes through 127.0.0.1 with its Host", () => {
    expect(r.previewUrl("http://${FLEET_RIG_SLUG}.localhost/", 4100, "search")).toBe("http://search.localhost/");
    expect(loopbackRequest("http://search.localhost/a?b=1")).toEqual({ url: "http://127.0.0.1/a?b=1", headers: { Host: "search.localhost" } });
    expect(loopbackRequest("http://localhost:4100/")).toEqual({ url: "http://localhost:4100/", headers: {} });
  });
});
