import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Crash tests (N7): a child process is SIGKILLed in the middle of work, then a
 * fresh process picks up the same state. Side effects must not repeat.
 */

const root = mkdtempSync(join(tmpdir(), "fleet-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function env(dir: string): Record<string, string> {
  return { ...(process.env as Record<string, string>), NODE_ENV: "test", FLEET_INBOX: join(dir, "inbox"), ALICE_VAULT: join(dir, "vault"), FLEET_SHIPS_DIR: join(dir, "ships"), FLEET_SHIP_OVERLAY_DIR: join(dir, "overlay") };
}

/** Run a script in a child bun process that is expected to kill itself; returns its exit signal. */
async function crashChild(dir: string, script: string): Promise<string | null> {
  const file = join(dir, "child.ts");
  writeFileSync(file, script);
  const p = Bun.spawn(["bun", file], { cwd: import.meta.dir, env: env(dir), stdout: "pipe", stderr: "pipe" });
  await p.exited;
  return p.signalCode;
}

describe("crash mid-routine", () => {
  test("an agent routine cut off by a crash is recorded as interrupted and never sent twice", async () => {
    const dir = join(root, "routine");
    for (const d of ["inbox/.node", "vault", "ships", "overlay"]) mkdirSync(join(dir, d), { recursive: true });
    const yaml = join(dir, "routines.yaml");
    writeFileSync(yaml, "routines:\n  - { id: report, every: daily 08:00, agent: alice, prompt: Report. }\n");
    const sends = join(dir, "sends.log");
    const lib = join(import.meta.dir, "routines.ts");
    const signal = await crashChild(dir, `
      import { appendFileSync } from "node:fs";
      const r = await import(${JSON.stringify(lib)});
      const deps = { jobs: {}, agentExists: () => true, runAgent: async () => { appendFileSync(${JSON.stringify(sends)}, "sent\\n"); process.kill(process.pid, "SIGKILL"); } };
      await r.tickRoutines(new Date(2026, 10, 3, 7, 0), deps, ${JSON.stringify(yaml)});
      await r.tickRoutines(new Date(2026, 10, 3, 8, 1), deps, ${JSON.stringify(yaml)});
    `);
    expect(signal).toBe("SIGKILL");
    expect(readFileSync(sends, "utf8")).toBe("sent\n");
    // The restarted node, in the same minute: nothing is sent again, and the interruption is recorded.
    const saved = { ...process.env };
    Object.assign(process.env, env(dir));
    const r = await import("./routines.ts");
    let again = 0;
    await r.tickRoutines(new Date(2026, 10, 3, 8, 2), { jobs: {}, agentExists: () => true, runAgent: async () => void again++ }, yaml);
    const state = JSON.parse(readFileSync(join(dir, "inbox", ".node", "routines.json"), "utf8"));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    expect(again).toBe(0);
    expect(state.report.status).toBe("error");
    expect(state.report.note).toContain("interrupted");
  });
});

describe("crash mid-order", () => {
  test("an order killed during an acting step pauses for the captain on restart instead of repeating it", async () => {
    const dir = join(root, "order");
    for (const d of ["inbox/.node", "vault/fleet/orders", "ships", "overlay"]) mkdirSync(join(dir, d), { recursive: true });
    const body = ["## Steps", "", "1. `ship_tasks` ship=kinwork", "   expect: the voyage, if any", '2. `fleet_chat` to=kinwork-designer text="Status, please."', "   expect: it lands", ""].join("\n");
    const notesLib = join(import.meta.dir, "order-note.ts");
    const ordersLib = join(import.meta.dir, "orders.ts");
    const signal = await crashChild(dir, `
      const notes = await import(${JSON.stringify(notesLib)});
      const orders = await import(${JSON.stringify(ordersLib)});
      orders._setExpectCheckForTest(async () => null);
      const { slug } = await notes.createOrder({ title: "Crash check", ship: "kinwork", by: "captain", body: ${JSON.stringify(body)}, status: "approved" });
      await orders.kickOrders();
      await orders.checkOrderCall("ship_tasks", { ship: "kinwork" }, true, { order: slug, step: 1 });
      orders.recordOrderCall(1, "ship_tasks", { ship: "kinwork" }, "no voyage");
      await orders.orderStep(slug, 1, true, "no voyage", "ship_tasks");
      // Step 2 acts: the call is checkpointed as started, then the process dies before it reports back.
      await orders.checkOrderCall("fleet_chat", { to: "kinwork-designer", text: "Status, please." }, false, { order: slug, step: 2 });
      process.kill(process.pid, "SIGKILL");
    `);
    expect(signal).toBe("SIGKILL");
    const saved = { ...process.env };
    Object.assign(process.env, env(dir));
    try {
      const notes = await import("./order-note.ts");
      const orders = await import("./orders.ts");
      orders._resetOrdersForTest();
      orders._setExpectCheckForTest(async () => null);
      await orders.kickOrders();
      const [o] = (await notes.listOrders()).filter((x) => x.meta?.title === "Crash check");
      expect(o!.meta!.status).toBe("needs-captain");
      expect(o!.meta!.reason).toContain("step 2's fleet_chat was running");
      expect(o!.meta!.resume).toBe(2);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
