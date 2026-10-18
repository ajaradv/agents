import { describe, expect, test } from "bun:test";
import { ORDER_TOOLS } from "./order-note.ts";
import { MAX_ROWS, toolText, VIEWS } from "./tool-out.ts";

/**
 * The fleet tool standard (docs/tool-standards.md), checked rather than asked
 * for: every read tool answers through an AXI view, views stay bounded however
 * big the data, and tool definitions stay short (they ride every turn).
 */

const MAX_DESCRIPTION = 600;
const MAX_PARAM_DESCRIPTION = 200;

type Registered = { name: string; description: string; parameters: { properties?: Record<string, { description?: string }> } };

/** Load an extension with a stub pi and collect the tools it registers. */
async function toolsOf(path: string, env: Record<string, string> = {}): Promise<Registered[]> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const mod = await import(`${path}?${Math.random()}`);
    const tools: Registered[] = [];
    const pi = { registerTool: (t: Registered) => tools.push(t), registerCommand() {}, on() {}, registerShortcut() {}, registerFlag() {}, getFlag() {}, sendMessage() {}, appendEntry() {} };
    mod.default(pi);
    return tools;
  } finally {
    process.env = saved;
  }
}

const EXT = new URL("../../extensions/", import.meta.url).pathname;

describe("tool standard", () => {
  test("every read tool an order may name has an AXI view", () => {
    const reads = Object.entries(ORDER_TOOLS).filter(([, t]) => t.read).map(([name]) => name);
    expect(reads.filter((name) => !VIEWS[name])).toEqual([]);
    expect(VIEWS.voyage_status).toBeDefined();
  });

  test("views stay bounded: rows capped, every row line short, whatever the data", () => {
    const huge = "x".repeat(5000);
    for (const [name, view] of Object.entries(VIEWS)) {
      for (const [list, fields] of Object.entries(view.rows ?? {})) {
        const rows = Array.from({ length: MAX_ROWS + 40 }, (_, i) => Object.fromEntries(fields.map((f) => [f, f === "id" ? i : huge])));
        const out = toolText({ ok: true, message: "big", [list]: rows } as never, view);
        const lines = out.split("\n").filter((l) => l.startsWith("  "));
        expect({ name, list, rows: lines.length <= MAX_ROWS }).toEqual({ name, list, rows: true });
        const longest = Math.max(...lines.map((l) => l.length));
        expect({ name, list, rowShort: longest < 1_600 }).toEqual({ name, list, rowShort: true });
        expect(out).toContain("40 more");
      }
    }
  });

  test("tool definitions stay short", async () => {
    const base = { FLEET_DASHBOARD_URL: "http://127.0.0.1:1", FLEET_CREW_TOKEN: "t" };
    const all = [
      ...(await toolsOf(`${EXT}fleet.ts`, { ...base, FLEET_AGENT_ID: "alice" })),
      ...(await toolsOf(`${EXT}crew.ts`, { ...base, FLEET_SHIP: "demo", FLEET_AGENT_ID: "demo-lead", FLEET_SHIP_CHECKS: "pytest", FLEET_SHIP_MANEUVERS: "verify" })),
      ...(await toolsOf(`${EXT}crew.ts`, { ...base, FLEET_SHIP: "demo", FLEET_AGENT_ID: "demo-helmsman" })),
      ...(await toolsOf(`${EXT}canvas.ts`, base)),
      ...(await toolsOf(`${EXT}ask-captain.ts`, base)),
    ];
    expect(all.length).toBeGreaterThan(15);
    const long = all.filter((t) => t.description.length > MAX_DESCRIPTION).map((t) => `${t.name}: ${t.description.length}`);
    expect(long).toEqual([]);
    const longParams = all.flatMap((t) =>
      Object.entries(t.parameters?.properties ?? {})
        .filter(([, p]) => (p.description ?? "").length > MAX_PARAM_DESCRIPTION)
        .map(([k, p]) => `${t.name}.${k}: ${(p.description ?? "").length}`),
    );
    expect(longParams).toEqual([]);
  });
});
