import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeSlot, helperArgs, helperDefs, parseHelper, pickHelperHost, runHelperHere, shotUrls, takeShots, takeSlot, type HelperDef } from "./helpers.ts";

const def = (over: Partial<HelperDef> = {}): HelperDef => ({ name: "ui-check", description: "", model: "m", tools: ["read"], input: "shots", hosts: ["laptop", "local"], budgetUsd: 0.1, timeoutSecs: 30, prompt: "Look.", ...over });

/** A stand-in for pi: prints the given JSON lines (one per arg), optionally then sleeps. */
function fakePi(lines: object[], sleepSecs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-pi-"));
  const bin = join(dir, "pi");
  const out = lines.map((l) => `echo '${JSON.stringify(l)}'`).join("\n");
  writeFileSync(bin, `#!/bin/sh\n${out}\n${sleepSecs ? `sleep ${sleepSecs}` : ""}\n`);
  chmodSync(bin, 0o755);
  return bin;
}
const said = (text: string, cost: number) => ({ type: "message_end", message: { role: "assistant", model: "m", usage: { cost: { total: cost } }, content: [{ type: "text", text }] } });

describe("helpers (H2b)", () => {
  test("definitions: only files marked helper, with limits clamped", async () => {
    expect(parseHelper("x", "---\nname: x\n---\nno")).toBeNull();
    const d = parseHelper("ui-check", "---\nname: ui-check\nhelper: true\ninput: shots\nhosts: laptop, local\nbudget_usd: 99\ntools: read, grep\n---\nLook.")!;
    expect(d).toMatchObject({ input: "shots", hosts: ["laptop", "local"], budgetUsd: 5, timeoutSecs: 300, tools: ["read", "grep"], prompt: "Look." });
    const shipped = await helperDefs();
    expect(shipped.map((h) => h.name).sort()).toEqual(["test-runner", "ui-check"]);
  });

  test("the host is a rule: laptop while up, else the hub; a check goes where the repo is", () => {
    expect(pickHelperHost(def(), "auto", { laptopUp: true, voyageHost: "local" })).toEqual({ host: "laptop" });
    expect(pickHelperHost(def(), "auto", { laptopUp: false, voyageHost: "local" })).toEqual({ host: "local" });
    expect(pickHelperHost(def(), "laptop", { laptopUp: false, voyageHost: "local" })).toMatchObject({ error: expect.stringContaining("not up") });
    expect(pickHelperHost(def({ hosts: ["local"] }), "laptop", { laptopUp: true, voyageHost: "local" })).toMatchObject({ error: expect.stringContaining("does not run on the laptop") });
    const check = def({ input: "check" });
    expect(pickHelperHost(check, "auto", { laptopUp: true, voyageHost: "local" })).toEqual({ host: "local" });
    expect(pickHelperHost(check, "auto", { laptopUp: true, voyageHost: "laptop" })).toEqual({ host: "laptop" });
    expect(pickHelperHost(check, "hub", { laptopUp: true, voyageHost: "laptop" })).toMatchObject({ error: expect.stringContaining("voyage's repo") });
  });

  test("slots per host: the hub runs one helper at a time", () => {
    expect(takeSlot("local")).toBe(true);
    expect(takeSlot("local")).toBe(false);
    freeSlot("local");
    expect(takeSlot("local")).toBe(true);
    freeSlot("local");
  });

  test("off the hub a helper gets no tools; its files are attached", () => {
    const off = helperArgs(def(), "Is it there?", ["/t/page1-desktop.png"], "laptop");
    expect(off).toContain("--no-tools");
    expect(off).not.toContain("--tools");
    expect(off).toContain("--no-extensions");
    expect(off).toContain("@/t/page1-desktop.png");
    expect(off.at(-1)).toBe("Task: Is it there?");
    expect(helperArgs(def(), "t", [], "local")).toEqual(expect.arrayContaining(["--tools", "read"]));
  });

  test("runs once and returns the last answer and its cost", async () => {
    const bin = fakePi([said("first", 0.01), said("The button is visible top right.", 0.02)]);
    const r = await runHelperHere(def(), "t", { cwd: tmpdir(), files: [], host: "laptop", env: process.env, bin });
    expect(r).toMatchObject({ ok: true, text: "The button is visible top right.", cost: 0.03 });
  });

  test("stopped at its budget and at its time limit, with nothing left running", async () => {
    const pricey = fakePi([said("costly", 0.5)], 30);
    const b = await runHelperHere(def(), "t", { cwd: tmpdir(), files: [], host: "laptop", env: process.env, bin: pricey });
    expect(b).toMatchObject({ ok: false, stopped: "budget" });
    expect(b.ms).toBeLessThan(10_000);
    const slow = fakePi([], 60);
    const t = await runHelperHere(def({ timeoutSecs: 1 }), "t", { cwd: tmpdir(), files: [], host: "laptop", env: process.env, bin: slow });
    expect(t).toMatchObject({ ok: false, stopped: "time" });
    expect(t.ms).toBeLessThan(10_000);
  }, 20_000);

  test("screenshots: http(s) pages only, two at most, desktop and phone each", async () => {
    expect(shotUrls([])).toContain("Give the page");
    expect(shotUrls(["file:///etc/passwd"])).toContain("Not an http(s) URL");
    expect(shotUrls(["https://a", "https://b", "https://c"])).toContain("At most two");
    const seen: string[] = [];
    const files = await takeShots(["https://a.test"], mkdtempSync(join(tmpdir(), "shots-")), async (o) => {
      seen.push(`${o.width}:${o.mobile}`);
      return new Uint8Array([1]);
    });
    expect(seen).toEqual(["1440:false", "390:true"]);
    expect(files.map((f) => f.split("/").pop())).toEqual(["page1-desktop.png", "page1-phone.png"]);
  });
});
