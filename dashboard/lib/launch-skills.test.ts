import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("bin/launch: which global skills an agent gets (discover_skills)", () => {
  test("unset: pi discovers them all; false: none; a list: only those, a missing one warned", () => {
    const home = mkdtempSync(join(tmpdir(), "launch-skills-"));
    for (const [dir, name] of [[".agents/skills", "impeccable"], [".agents/skills", "aws-cdk"], [".pi/agent/skills", "graphify"]]) {
      mkdirSync(join(home, dir, name), { recursive: true });
      writeFileSync(join(home, dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const py = `import importlib.util, importlib.machinery, json, sys
l = importlib.machinery.SourceFileLoader("launch", sys.argv[1]); s = importlib.util.spec_from_loader("launch", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
names = lambda r: None if r is None else [p.name for p in r]
print(json.dumps({
  "unset": names(m.global_skills({})),
  "off": names(m.global_skills({"discover_skills": "false"})),
  "list": names(m.global_skills({"discover_skills": ["impeccable", "graphify", "nope"]})),
  "vm": [p.split("/")[-1] for p in m.vm_skill_dirs({"discover_skills": ["impeccable"]})],
}))`;
    const r = Bun.spawnSync(["/usr/bin/python3", "-B", "-c", py, join(import.meta.dir, "..", "..", "bin", "launch")], { env: { ...process.env, HOME: home } });
    const out = JSON.parse(r.stdout.toString()) as Record<string, string[] | null>;
    expect(out.unset).toBeNull();
    expect(out.off).toEqual([]);
    expect(out.list).toEqual(["impeccable", "graphify"]);
    expect(out.vm).toEqual(["impeccable"]);
    expect(r.stderr.toString()).toContain("discover_skills names nope");
    rmSync(home, { recursive: true, force: true });
  });
});
