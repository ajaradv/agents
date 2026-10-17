import { describe, expect, test } from "bun:test";
import { allowedHosts, guestEnv, hostAllowed } from "../../extensions/gondolin/policy.ts";
import { DEFAULT_VM_ALLOW, parseShipYaml } from "./fleet-layers.ts";
import { tail } from "./ship-checks.ts";

describe("crew VM policy", () => {
  test("commands get a fixed environment: no keys, no fleet tokens, no host PATH", () => {
    const env = guestEnv("pochteca-scout");
    expect(Object.keys(env).sort()).toEqual(["CI", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_NAME", "HOME", "LANG", "TERM"]);
    expect(env.GIT_AUTHOR_NAME).toBe("pochteca-scout");
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
