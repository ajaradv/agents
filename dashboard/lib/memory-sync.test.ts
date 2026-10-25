import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShipRow } from "./fleet-layers.ts";
import type { ShipHost } from "./ship-host.ts";

const inbox = mkdtempSync(join(tmpdir(), "memsync-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const m = await import("./memory-sync.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
  rmSync(inbox, { recursive: true, force: true });
});

const ship = (id: string, orchestrator = "lead") => ({ id, orchestrator, crew: ["lead", "builder"] }) as unknown as ShipRow;
const remote = (files: Record<string, string> | Error, seen: string[][] = []): ShipHost =>
  ({
    kind: "laptop",
    label: "the laptop",
    getMemory: async (s: string, agents: string[]) => {
      seen.push([s, ...agents]);
      if (files instanceof Error) throw files;
      return files;
    },
  }) as unknown as ShipHost;
const local = { kind: "local", label: "this machine" } as unknown as ShipHost;

describe("live crew memory for remote voyages (S3d)", () => {
  test("a remote voyage's changed files are mirrored; unchanged ones are not rewritten; bad paths are refused", async () => {
    mkdirSync(join(inbox, "p-lead", "memory"), { recursive: true });
    writeFileSync(join(inbox, "p-lead", "memory", "notes.md"), "same");
    const seen: string[][] = [];
    const files = { "p-lead/memory/state.md": "working on task 2", "p-lead/memory/notes.md": "same", "ships/p/memory/voyage.md": "# Voyage", "../etc/memory/x.md": "no", "p-lead/sessions/current": "dashboard-x" };
    const changed = await m.syncRemoteMemory([ship("p"), ship("q", "firstmate")], (id) => (id === "p" ? remote(files, seen) : local));
    expect(changed).toEqual(["p"]);
    expect(seen).toEqual([["p", "p-lead", "p-builder"]]);
    expect(readFileSync(join(inbox, "p-lead", "memory", "state.md"), "utf8")).toBe("working on task 2");
    expect(existsSync(join(inbox, "p-lead", "sessions", "current"))).toBe(false);
    const sync = m.readMemorySync("p")!;
    expect([sync.host, sync.changed, sync.synced === sync.tried]).toEqual(["the laptop", 2, true]);
    // The next pass finds nothing new: no ship to refresh.
    expect(await m.syncRemoteMemory([ship("p")], () => remote(files))).toEqual([]);
  });

  test("a host that does not answer keeps the last good sync time and says why", async () => {
    await m.syncRemoteMemory([ship("r")], () => remote({ "r-lead/memory/state.md": "a" }));
    const good = m.readMemorySync("r")!.synced;
    expect(await m.syncRemoteMemory([ship("r")], () => remote(new Error("laptop: asleep")))).toEqual([]);
    const s = m.readMemorySync("r")!;
    expect([s.synced, s.message]).toEqual([good, "laptop: asleep"]);
  });

  test("local voyages are not pulled; the deck's notes are the scratchpad, then each crewmate's state and plan", async () => {
    expect(await m.syncRemoteMemory([ship("s")], () => local)).toEqual([]);
    expect(m.readMemorySync("s")).toBeNull();
    mkdirSync(join(inbox, "ships", "s", "memory"), { recursive: true });
    mkdirSync(join(inbox, "s-builder", "memory"), { recursive: true });
    writeFileSync(join(inbox, "ships", "s", "memory", "voyage.md"), "# Voyage: x\n");
    writeFileSync(join(inbox, "s-builder", "memory", "state.md"), "halfway\n");
    writeFileSync(join(inbox, "s-builder", "memory", "plan.md"), "  \n");
    expect(m.voyageMemoryNotes("s", ["lead", "builder"]).map((n) => [n.label, n.text])).toEqual([
      ["Voyage scratchpad", "# Voyage: x"],
      ["builder: state", "halfway"],
    ]);
  });
});
