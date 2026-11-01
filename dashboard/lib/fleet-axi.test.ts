import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const inbox = tmp("axi-inbox-");
const vault = tmp("axi-vault-");
// Fake ssh and gh that fail at once: no test here reaches the hub or GitHub.
const fakeBin = tmp("axi-bin-");
for (const name of ["ssh", "gh"]) {
  writeFileSync(join(fakeBin, name), "#!/bin/sh\necho 'offline' >&2\nexit 255\n");
  chmodSync(join(fakeBin, name), 0o755);
}
mkdirSync(join(inbox, ".node"), { recursive: true });

async function axi(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn([join(ROOT, "bin", "fleet-axi"), ...args], {
    cwd: ROOT,
    env: { ...process.env, FLEET_INBOX: inbox, ALICE_VAULT: vault, PATH: `${fakeBin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { out, code };
}

describe("fleet-axi flags", () => {
  test("--engineer and --hub-part are valid flags; an unknown one still fails", async () => {
    const bad = await axi("--brief", "--nope");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("--engineer");
    expect(bad.out).toContain("--hub-part");
  });

  test("--brief --hub-part prints the Hub and Fleet sections", async () => {
    const r = await axi("--brief", "--hub-part");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^## Hub\n[\s\S]*\n## Fleet\n- /);
  });

  test("--brief --engineer prints the brief and exits 0 even when the hub and GitHub are down", async () => {
    const r = await axi("--brief", "--engineer");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^# Engineer brief \d{4}-\d{2}-\d{2}/);
    expect(r.out).toContain("## Repo");
    expect(r.out).toContain("- hub unreachable (offline)");
    expect(r.out).toContain("## PRs\n- unavailable: offline");
  });

  test("plain --brief is unchanged: the toon summary, not the engineer's markdown", async () => {
    const r = await axi("--brief");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^fleet: /);
    expect(r.out).not.toContain("Engineer brief");
    expect(r.out).toContain("bin/fleet-axi --help");
  });
});

describe("setup hooks", () => {
  test("does nothing when .claude/settings.json already has the fleet-axi hook", async () => {
    const r = await axi("setup", "hooks");
    expect(r.code).toBe(0);
    expect(r.out).toContain("already set up (no change)");
    expect(r.out).toContain(join(".claude", "settings.json"));
  });
});

describe(".claude/settings.json", () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8"));

  test("one SessionStart hook runs the engineer brief, with the matcher and a 20 s timeout", () => {
    expect(cfg.hooks.SessionStart).toHaveLength(1);
    const entry = cfg.hooks.SessionStart[0];
    expect(entry.matcher).toBe("startup|resume|clear|compact");
    expect(entry.hooks).toEqual([{ type: "command", command: "${CLAUDE_PROJECT_DIR}/bin/fleet-axi --brief --engineer", timeout: 20 }]);
  });
});
