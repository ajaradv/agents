import { describe, expect, test } from "bun:test";
import { allowedHosts, browserNote, guestEnv, guestToHost, hostAllowed, readonlyMounts, vmSize } from "../../extensions/gondolin/policy.ts";
import { DEFAULT_VM_ALLOW, parseShipYaml } from "./fleet-layers.ts";
import { tail } from "./ship-checks.ts";

describe("crew VM policy", () => {
  test("commands get a fixed environment: no keys, no fleet tokens, no host PATH", () => {
    const env = guestEnv("pochteca-scout", false);
    expect(Object.keys(env).sort()).toEqual(["CI", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "HOME", "LANG", "TERM"]);
    expect(env.GIT_AUTHOR_NAME).toBe("pochteca-scout");
  });
  test("with a cache folder, pre-commit keeps its hook environments there", () => {
    expect(guestEnv("pochteca-scout", true).PRE_COMMIT_HOME).toBe("/cache/pre-commit");
  });
  test("browser image (R4e): more memory and a prompt line about shot, only when switched on", () => {
    expect(vmSize("2G")).toEqual({ memory: "2G" });
    expect(vmSize("")).toEqual({});
    expect(vmSize("2G; rm -rf /")).toEqual({});
    expect(browserNote(true)).toContain("shot <url-or-file>");
    expect(browserNote(true)).toContain("cdt open <url>");
    expect(browserNote(false)).toBe("");
  });
  test("guest paths map to host folders for the canvas; others and .. escapes stay as given", () => {
    const m = { workspace: "/h/repo", memory: "/h/inbox/p-designer/memory", shipMemory: "/h/inbox/ships/p/memory", cache: "/h/inbox/p-designer/cache" };
    expect(guestToHost("/cache/shots/home-desktop.png", m)).toBe("/h/inbox/p-designer/cache/shots/home-desktop.png");
    expect(guestToHost("/workspace/docs/a.png", m)).toBe("/h/repo/docs/a.png");
    expect(guestToHost("/workspace", m)).toBe("/h/repo");
    expect(guestToHost("/ship-memory/x.md", m)).toBe("/h/inbox/ships/p/memory/x.md");
    expect(guestToHost("/memory/x.md", m)).toBe("/h/inbox/p-designer/memory/x.md");
    expect(guestToHost("/cache/../../etc/passwd", m)).toBe("/cache/../../etc/passwd");
    expect(guestToHost("/workspacefoo/a", m)).toBe("/workspacefoo/a");
    expect(guestToHost("/tmp/a.png", { workspace: "/h/repo" })).toBe("/tmp/a.png");
  });
  test("read-only skill mounts: absolute paths only, no .., no root, deduplicated", () => {
    expect(readonlyMounts("/a/skills:/b/x/:relative:/:/c/../etc:/a/skills")).toEqual(["/a/skills", "/b/x"]);
    expect(readonlyMounts("")).toEqual([]);
  });
  test("the allowlist parses hostnames and wildcards, and matches only those", () => {
    const allow = allowedHosts("pypi.org, *.github.com,bad host,http://x.com");
    expect(allow).toEqual(["pypi.org", "*.github.com"]);
    expect(hostAllowed("pypi.org:443", allow)).toBe(true);
    expect(hostAllowed("codeload.github.com", allow)).toBe(true);
    expect(hostAllowed("github.com.evil.io", allow)).toBe(false);
    expect(hostAllowed("api.anthropic.com", allow)).toBe(false);
    expect(allowedHosts("")).toEqual([]);
  });
  test("ship files: isolation, allowlist (default when absent, none when empty), checks by name", () => {
    const s = parseShipYaml("id: p\npath: /p\nisolation: vm\nchecks:\n  pytest: just pytest\n  Bad Name: rm -rf /\n", "p");
    expect(s.isolation).toBe("vm");
    expect(s.vmAllow).toEqual(DEFAULT_VM_ALLOW);
    expect(s.checks).toEqual({ pytest: "just pytest" });
    expect(parseShipYaml("id: q\nvm_allow: []\n", "q").vmAllow).toEqual([]);
    expect(parseShipYaml("id: r\n", "r").isolation).toBe("host");
  });
  test("long check output keeps its end", () => {
    expect(tail("x".repeat(20), 5)).toBe("[… 15 earlier characters cut …]\nxxxxx");
  });
});

import { keysForModels, withoutSecrets } from "./fleet-env.ts";

describe("per-agent keys (R4c)", () => {
  const all = { DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o", CURSOR_API_KEY: "c", TYPESAFE_API_KEY: "t", HF_TOKEN: "h" };
  test("a helper on DeepSeek gets only DeepSeek's key", () => {
    expect(keysForModels(all, ["deepseek/deepseek-flash"])).toEqual({ DEEPSEEK_API_KEY: "d" });
    expect(keysForModels(all, ["openrouter/anthropic/claude-sonnet-5.5", "deepseek/deepseek-flash"])).toEqual({ DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o" });
  });
  test("inherited secrets are stripped before the needed ones are added", () => {
    expect(withoutSecrets({ PATH: "/bin", CURSOR_API_KEY: "c", TYPESAFE_API_KEY: "t" })).toEqual({ PATH: "/bin" });
  });
});
