import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashUse, bashUseRows, firstWord } from "./bash-use.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const line = (ts: string, calls: { name: string; command?: string }[], role = "assistant") =>
  JSON.stringify({ type: "message", timestamp: ts, message: { role, content: [{ type: "text", text: "ok" }, ...calls.map((c) => ({ type: "toolCall", id: "t", name: c.name, arguments: c.command === undefined ? {} : { command: c.command } }))] } });

function inbox(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "bash-use-"));
  for (const [rel, lines] of Object.entries(files)) {
    const dir = join(root, rel.split("/")[0]!, "sessions");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, rel.split("/")[1]!);
    writeFileSync(f, `${lines.join("\n")}\n`);
    const t = new Date(NOW - 3_600_000);
    utimesSync(f, t, t);
  }
  return root;
}

describe("firstWord", () => {
  test("the program, past env prefixes, cd, and paths", () => {
    expect(firstWord("git status")).toBe("git");
    expect(firstWord("FOO=1 BAR='a b' bun -e 'x'")).toBe("bun");
    expect(firstWord("cd /work/ship && git diff main")).toBe("git");
    expect(firstWord("/usr/bin/rg foo")).toBe("rg");
    expect(firstWord("  ")).toBe("(empty)");
  });
});

describe("bashUse", () => {
  const root = inbox({
    "kin-lead/a.jsonl": [
      line("2026-10-29T10:00:00Z", [{ name: "bash", command: "git status" }, { name: "read" }]),
      line("2026-10-29T10:01:00Z", [{ name: "bash", command: "cd /w && git log --oneline -5" }, { name: "bash", command: "ls src" }]),
      line("2026-10-29T10:02:00Z", [{ name: "bash", command: "cat x" }], "user"),
      line("2026-10-01T10:02:00Z", [{ name: "bash", command: "old call" }]),
      "not json with \"toolCall\"",
      JSON.stringify({ type: "message", timestamp: "2026-10-29T10:03:00Z", message: { role: "assistant", content: [{ type: "text", text: "no tools" }] } }),
    ],
    "kin-helmsman/b.jsonl": [line("2026-10-30T09:00:00Z", [{ name: "grep" }])],
    "pochteca-lead/c.jsonl": [line("2026-10-30T09:00:00Z", [{ name: "bash", command: "npm view x" }])],
    "alice/d.jsonl": [line("2026-10-30T09:00:00Z", [{ name: "bash", command: "bun -e 1" }])],
  });

  test("counts bash calls by first word inside the window, assistant lines only", async () => {
    const rows = await bashUse({ days: 7, inbox: root, now: NOW });
    const kin = rows.find((r) => r.agent === "kin-lead")!;
    expect(kin.bashCalls).toBe(3);
    expect(kin.toolCalls).toBe(4);
    expect(kin.commands).toEqual({ git: 2, ls: 1 });
    expect(kin.last).toBe("2026-10-29T10:01:00Z");
    expect(rows.find((r) => r.agent === "kin-helmsman")).toMatchObject({ bashCalls: 0, toolCalls: 1 });
  });

  test("a role filter covers every ship's; an id covers one", async () => {
    expect((await bashUse({ days: 7, inbox: root, now: NOW, agent: "lead" })).map((r) => r.agent)).toEqual(["kin-lead", "pochteca-lead"]);
    expect((await bashUse({ days: 7, inbox: root, now: NOW, agent: "alice" })).map((r) => r.agent)).toEqual(["alice"]);
    expect(await bashUse({ days: 7, inbox: root, now: NOW, agent: "nobody" })).toEqual([]);
  });

  test("files untouched since the window opened are skipped", async () => {
    expect((await bashUse({ days: 1, inbox: root, now: NOW + 5 * 86_400_000 })).every((r) => r.bashCalls === 0)).toBe(true);
  });

  test("rows are busiest first with the top commands", async () => {
    const rows = bashUseRows(await bashUse({ days: 7, inbox: root, now: NOW }));
    expect(rows[0]).toMatchObject({ agent: "kin-lead", bash: 3, commands: "git 2, ls 1" });
    expect(rows.at(-1)).toMatchObject({ bash: 0, commands: "" });
  });
});
