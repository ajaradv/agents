import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prev = process.env.FLEET_INBOX;
const j = await import("./journal.ts");
const f = await import("./facts.ts");
const { remember } = await import("./remember.ts");
afterAll(() => {
  j._closeJournal();
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

const PROFILE = `---
title: Captain profile
---

Standing preferences.

## Voice

- Address the captain as "Captain".
- Spoken replies give the gist.

## Interruptions

- Interrupt only for: done, blocked.
- Quiet hours are a toggle.

## Ways of working

- Plans live in the vault.
`;

let vault = "";
const file = () => join(vault, "fleet", "captain.md");
const read = () => readFileSync(file(), "utf8");
beforeEach(() => {
  j._closeJournal();
  process.env.FLEET_INBOX = mkdtempSync(join(tmpdir(), "remember-inbox-"));
  vault = mkdtempSync(join(tmpdir(), "remember-vault-"));
  mkdirSync(join(vault, "fleet"));
  writeFileSync(file(), PROFILE);
});
const rem = (a: Parameters<typeof remember>[0]) => remember(a, vault);

describe("remember", () => {
  test("adds a bullet after the last one in the section; everything else is byte for byte", () => {
    const r = rem({ section: "interruptions", line: "Nothing at night." });
    expect(r.ok).toBe(true);
    expect(read()).toBe(PROFILE.replace("- Quiet hours are a toggle.\n", "- Quiet hours are a toggle.\n- Nothing at night.\n"));
  });

  test("the last section, and a file with no trailing newline", () => {
    rem({ section: "Ways of working", line: "New one." });
    expect(read()).toBe(`${PROFILE}- New one.\n`);
    writeFileSync(file(), PROFILE.trimEnd());
    rem({ section: "Voice", line: "Brief." });
    expect(read().endsWith("Plans live in the vault.")).toBe(true);
    expect(read()).toContain('- Spoken replies give the gist.\n- Brief.\n');
  });

  test("an exact duplicate changes nothing", () => {
    const r = rem({ section: "Voice", line: "- Spoken replies give the gist." });
    expect(r.message).toContain("already there");
    expect(read()).toBe(PROFILE);
  });

  test("replaces swaps the one bullet it matches, in place", () => {
    const r = rem({ section: "Voice", line: "Say Captain once a reply.", replaces: "address the captain" });
    expect(r.ok).toBe(true);
    expect(read()).toBe(PROFILE.replace('- Address the captain as "Captain".', "- Say Captain once a reply."));
  });

  test("replaces with no match or several lists the candidates and writes nothing", () => {
    const none = rem({ section: "Voice", line: "x", replaces: "zebra" });
    expect(none.ok).toBe(false);
    expect(none.message).toContain("Spoken replies give the gist");
    const many = rem({ section: "Interruptions", line: "x", replaces: "o" });
    expect(many.ok).toBe(false);
    expect(many.message).toContain("2 bullets");
    expect(read()).toBe(PROFILE);
  });

  test("a missing section lists the headings; create=true adds it at the end", () => {
    const miss = rem({ section: "Money", line: "Value first." });
    expect(miss.ok).toBe(false);
    expect(miss.message).toContain("Voice; Interruptions; Ways of working");
    expect(read()).toBe(PROFILE);
    expect(rem({ section: "Money", line: "Value first.", create: true }).ok).toBe(true);
    expect(read()).toBe(`${PROFILE}\n## Money\n\n- Value first.\n`);
  });

  test("an empty section gets its first bullet after the heading", () => {
    writeFileSync(file(), "## A\n\n## B\n\n- b\n");
    rem({ section: "A", line: "first" });
    expect(read()).toBe("## A\n\n- first\n\n## B\n\n- b\n");
  });

  test("bad lines are refused", () => {
    expect(rem({ section: "Voice", line: "" }).ok).toBe(false);
    expect(rem({ section: "Voice", line: "a\nb" }).ok).toBe(false);
    expect(rem({ section: "Voice", line: "x".repeat(301) }).message).toContain("limit is 300");
    expect(read()).toBe(PROFILE);
  });

  test("the file stays under 4 KB: a growing edit is refused, a shrinking one is not", () => {
    let i = 0;
    while (Buffer.byteLength(read()) < 3900) rem({ section: "Voice", line: `filler ${i++} ${"x".repeat(250)}` });
    const before = read();
    const r = rem({ section: "Voice", line: "y".repeat(290) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Tighten an existing line");
    expect(read()).toBe(before);
    expect(rem({ section: "Voice", line: "short", replaces: "filler 0 " }).ok).toBe(true);
  });

  test("an observation is promoted by a successful remember, not by a refused one", () => {
    const o = f.logObservation({ text: "captain dislikes long replies", by: "alice" }).id as number;
    expect(rem({ section: "Nope", line: "x", observation: o }).ok).toBe(false);
    expect((f.listObservations().observations as unknown[]).length).toBe(1);
    expect(rem({ section: "Voice", line: "Keep replies short.", observation: o }).message).toContain("promoted");
    expect((f.listObservations().observations as unknown[]).length).toBe(0);
    expect(rem({ section: "Voice", line: "x", observation: 999 }).ok).toBe(false);
  });

  test("the profile cannot be a symlink out of the vault", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "remember-out-")), "captain.md");
    writeFileSync(outside, "## Voice\n\n- a\n");
    mkdirSync(join(vault, "other"));
    writeFileSync(file(), "");
    const v2 = mkdtempSync(join(tmpdir(), "remember-vault2-"));
    mkdirSync(join(v2, "fleet"));
    symlinkSync(outside, join(v2, "fleet", "captain.md"));
    const r = remember({ section: "Voice", line: "b" }, v2);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("outside the vault");
    expect(readFileSync(outside, "utf8")).toBe("## Voice\n\n- a\n");
  });
});
