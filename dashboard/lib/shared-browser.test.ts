import { describe, expect, test } from "bun:test";
import { Gate, MAX_JOBS } from "../browser.ts";

describe("the shared browser's job gate", () => {
  test("at most MAX_JOBS run at once; the rest wait in order and all finish", async () => {
    const gate = new Gate(MAX_JOBS);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const job = (n: number) =>
      gate.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(15);
        running--;
        order.push(n);
        return n;
      });
    const results = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(job));
    expect(results).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(MAX_JOBS);
    expect(order.slice(MAX_JOBS)).toEqual([4, 5, 6, 7]);
    expect(gate.active).toBe(0);
  });
  test("a failing job frees its place", async () => {
    const gate = new Gate(1);
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await gate.run(async () => "next")).toBe("next");
  });
});
