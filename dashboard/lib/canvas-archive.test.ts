import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "canvas-archive-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const a = await import("./canvas-archive.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

const item = (agent: string, id: string) => {
  mkdirSync(join(inbox, agent, "canvas", id), { recursive: true });
  writeFileSync(join(inbox, agent, "canvas", id, "item.json"), JSON.stringify({ id }));
};

describe("canvas archive", () => {
  test("items move out of every named agent's canvas into one folder outside the inbox's agents", async () => {
    item("k-designer", "search-shots");
    item("k-designer", "home-shots");
    item("k-lead", "plan");
    writeFileSync(join(inbox, "k-designer", "canvas", "stray.txt"), "x");
    const r = await a.archiveCanvas(["k-designer", "k-lead", "k-nobody"], "2026-10-25-Five variants!", new Date("2026-10-25T05:00:00Z"));
    expect(r).toEqual({ items: 3, dir: join(".archive", "canvas", "20261025T050000-2026-10-25-five-variants") });
    expect(readdirSync(join(inbox, "k-designer", "canvas"))).toEqual(["stray.txt"]);
    expect(readdirSync(join(inbox, r.dir!, "k-designer")).sort()).toEqual(["home-shots", "search-shots"]);
    expect(existsSync(join(inbox, r.dir!, "k-lead", "plan", "item.json"))).toBe(true);
    expect(await a.archiveCanvas(["k-lead"], "again")).toEqual({ items: 0, dir: null });
  });
  test("folders older than the keep window are pruned", () => {
    const root = join(inbox, ".archive", "canvas");
    const [only] = readdirSync(root);
    const old = (Date.now() - 40 * 86_400_000) / 1000;
    utimesSync(join(root, only!), old, old);
    mkdirSync(join(root, "fresh"), { recursive: true });
    expect(a.pruneCanvasArchive()).toBe(1);
    expect(readdirSync(root)).toEqual(["fresh"]);
  });
});
