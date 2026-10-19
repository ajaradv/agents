import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inbox = mkdtempSync(join(tmpdir(), "crewmem-inbox-"));
const prev = process.env.FLEET_INBOX;
process.env.FLEET_INBOX = inbox;
const c = await import("./crew-memory.ts");
afterAll(() => {
  if (prev === undefined) delete process.env.FLEET_INBOX;
  else process.env.FLEET_INBOX = prev;
});

describe("tiered crew memory", () => {
  test("set sail: project memory kept, a fresh voyage scratchpad, transient files cleared, fresh sessions", async () => {
    const mem = join(inbox, "p-lead", "memory");
    mkdirSync(mem, { recursive: true });
    for (const f of ["plan.md", "state.md", "notes.md"]) writeFileSync(join(mem, f), `old ${f}`);
    mkdirSync(c.shipMemoryDir("p"), { recursive: true });
    writeFileSync(join(c.shipMemoryDir("p"), "project.md"), "# p\n- tests: just pytest\n");
    await c.startVoyageMemory("p", { goal: "Upgrade Tailwind", branch: "chore/tailwind", record: "/v.md" }, ["p-lead"]);
    expect(readFileSync(join(c.shipMemoryDir("p"), "project.md"), "utf8")).toContain("just pytest");
    expect(readFileSync(join(c.shipMemoryDir("p"), "voyage.md"), "utf8")).toContain("# Voyage: Upgrade Tailwind");
    expect(existsSync(join(mem, "plan.md"))).toBe(false);
    expect(existsSync(join(mem, "state.md"))).toBe(false);
    expect(readFileSync(join(mem, "notes.md"), "utf8")).toBe("old notes.md");
    expect(readFileSync(join(inbox, "p-lead", "sessions", "current"), "utf8")).toMatch(/^dashboard-p-lead-\d{8}-\d{6}\n$/);
  });
  test("dock: the scratchpad comes back for the record, then voyage memory is gone", async () => {
    writeFileSync(join(c.shipMemoryDir("p"), "voyage.md"), readFileSync(join(c.shipMemoryDir("p"), "voyage.md"), "utf8") + "- frontend check needs -f docker-compose.local.yml\n");
    writeFileSync(join(inbox, "p-lead", "memory", "plan.md"), "plan");
    const scratch = await c.endVoyageMemory("p", ["p-lead"]);
    expect(scratch).toBe("- frontend check needs -f docker-compose.local.yml");
    expect(existsSync(join(c.shipMemoryDir("p"), "voyage.md"))).toBe(false);
    expect(existsSync(join(inbox, "p-lead", "memory", "plan.md"))).toBe(false);
    expect(existsSync(join(c.shipMemoryDir("p"), "project.md"))).toBe(true);
  });
  test("a new project gets a project memory file with its header", async () => {
    await c.startVoyageMemory("q", { goal: "x", record: "/q.md" }, []);
    expect(readFileSync(join(c.shipMemoryDir("q"), "project.md"), "utf8")).toStartWith("# q: project memory");
  });
});
