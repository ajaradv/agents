import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { parseShipYaml, type ShipRow } from "./fleet-layers.ts";

const inbox = mkdtempSync(join(tmpdir(), "helm-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const h = await import("./helm.ts");
const m = await import("./metrics.ts");
afterAll(() => {
  m._closeMetrics();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const repo = mkdtempSync(join(tmpdir(), "helm-repo-"));
writeFileSync(join(repo, "pyproject.toml"), "");
writeFileSync(join(repo, "Cargo.toml"), "");
writeFileSync(join(repo, "justfile"), "set dotenv-load := true\n\npytest *args:\n    docker compose run pytest\n\nlint:\n    pre-commit run -a\n\ncargo-test: build\n    cargo test\n");

const YAML = `id: hs
path: ${repo}
# the captain's comment stays
crew:
  - lead
  - helmsman
isolation: vm
checks:
  pytest: just pytest
  lint: just lint
gates:
  task:
    - pytest
maneuvers:
  old:
    checks: [lint]
`;
const ship: ShipRow = { ...parseShipYaml(YAML, "hs"), adws: [] };

describe("the helm", () => {
  test("repo signals: build files and justfile recipes", () => {
    expect(h.repoSignals(repo)).toEqual({ manifests: ["pyproject.toml", "Cargo.toml", "justfile"], recipes: ["pytest", "lint", "cargo-test"] });
  });

  test("the digest carries the process, the repo, and the record", () => {
    for (const v of ["a", "b"]) {
      m.recordVoyageStart({ id: v, ship: "hs", goal: v, to: "hs-lead", started: new Date().toISOString() });
      m.recordRun({ ship: "hs", agent: "hs-lead", kind: "check", name: "lint", ok: true, ms: 1000 });
      m.recordRun({ ship: "hs", agent: "hs-lead", kind: "check", name: "pytest", ok: v === "b", ms: 3000 });
      m.recordVoyageDock(v, {});
    }
    const d = h.helmDigest(ship, "the voyage docked", "## Ledger\n\n5m from set sail to dock.");
    expect(d).toContain("Helm review for hs: the voyage docked");
    expect(d).toContain("Checks: pytest (`just pytest`); lint (`just lint`)");
    expect(d).toContain("Build files at the root: pyproject.toml, Cargo.toml, justfile");
    expect(d).toContain("justfile recipes: pytest, lint, cargo-test");
    expect(d).toContain("check pytest 1/2 passed");
    expect(d).toContain("[lint pytest] in 2 voyages");
    expect(d).toContain("Declared maneuvers never run: old");
    expect(d).toContain("## The voyage that just docked\n\n5m from set sail to dock.");
  });

  test("proposals are validated against the ship", () => {
    const v = (b: Record<string, unknown>, open: never[] = []) => h.validateProposal(ship, b, open);
    expect(v({ kind: "check", name: "cargo", command: "just cargo-test", why: "Cargo.toml at the root, no check covers Rust" })).toMatchObject({ kind: "check", name: "cargo" });
    expect(v({ kind: "check", name: "pytest", command: "x", why: "already there, surely" })).toContain("already has a check");
    expect(v({ kind: "check", name: "x", command: "a\nb", why: "two lines is not allowed" })).toContain("one line");
    expect(v({ kind: "gate", stage: "dock", check: "lint", why: "lint keeps failing in CI later" })).toMatchObject({ stage: "dock", check: "lint" });
    expect(v({ kind: "gate", stage: "dock", check: "cargo", why: "rust should gate docking" })).toContain("propose the check first");
    expect(v({ kind: "maneuver", name: "verify", checks: ["lint", "pytest"], roles: ["lead", "scout"], why: "ran together in 2 voyages" })).toMatchObject({ checks: ["lint", "pytest"], roles: ["lead", "scout"] });
    expect(v({ kind: "retire_maneuver", name: "old", why: "never run in 30 days" })).toMatchObject({ name: "old" });
    expect(v({ kind: "allow_host", host: "api.github.com", why: "blocked 4 times reading releases" })).toMatchObject({ host: "api.github.com" });
    expect(v({ kind: "allow_host", host: "github.com", why: "already in the default list" })).toContain("already allowed");
    expect(v({ kind: "check", name: "y", command: "z", why: "short" })).toContain("Say why");
  });

  test("applying changes only what the proposal names, and keeps comments", () => {
    const doc = parseDocument(YAML);
    const p = (x: Partial<import("./helm.ts").Proposal>) => ({ id: "aaaaaa", ts: "", by: "hs-helmsman", why: "", status: "open" as const, ...x }) as import("./helm.ts").Proposal;
    h.applyToDoc(doc, p({ kind: "check", name: "cargo", command: "just cargo-test" }), ship);
    h.applyToDoc(doc, p({ kind: "gate", stage: "dock", check: "cargo" }), ship);
    h.applyToDoc(doc, p({ kind: "gate", stage: "task", check: "lint" }), ship);
    h.applyToDoc(doc, p({ kind: "maneuver", name: "verify", checks: ["lint", "pytest"], roles: ["lead", "scout"] }), ship);
    h.applyToDoc(doc, p({ kind: "retire_maneuver", name: "old" }), ship);
    h.applyToDoc(doc, p({ kind: "allow_host", host: "api.github.com" }), ship);
    const text = doc.toString();
    expect(text).toContain("# the captain's comment stays");
    const after = parseShipYaml(text, "hs");
    expect(after.checks).toEqual({ pytest: "just pytest", lint: "just lint", cargo: "just cargo-test" });
    expect(after.gates).toEqual({ task: ["pytest", "lint"], dock: ["cargo"] });
    expect(after.maneuvers.map((x) => [x.name, x.checks, x.by])).toEqual([["verify", ["lint", "pytest"], ["lead", "scout"]]]);
    expect(after.vmAllow).toContain("api.github.com");
    expect(after.vmAllow).toContain("pypi.org");
    expect(after.crew).toEqual(["lead", "helmsman"]);
  });
});

describe("proposal writes", () => {
  test("one at a time per ship, so parallel proposals are all kept", async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => h.withLock("hs", async () => {
      order.push(`${tag} start`);
      await Bun.sleep(ms);
      order.push(`${tag} end`);
    });
    await Promise.all([slow("a", 20), slow("b", 1)]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });
});
