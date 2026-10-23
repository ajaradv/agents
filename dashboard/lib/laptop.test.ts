import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "laptop-"));
const saved = { url: process.env.FLEET_LAPTOP_URL, dir: process.env.FLEET_SECRETS_DIR, backend: process.env.FLEET_SECRET_BACKEND };
process.env.FLEET_SECRETS_DIR = dir;
process.env.FLEET_SECRET_BACKEND = "file";
const { writeSecret } = await import("./secret-store.ts");
const { _setLaptopFetchForTest, laptopFirstmateSend, laptopShot, laptopStatus, laptopTts } = await import("./laptop.ts");
const { authorized } = await import("../worker.ts");
await writeSecret("laptop-worker-token", "tok-123");
afterAll(() => {
  for (const [k, v] of [["FLEET_LAPTOP_URL", saved.url], ["FLEET_SECRETS_DIR", saved.dir], ["FLEET_SECRET_BACKEND", saved.backend]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _setLaptopFetchForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("the laptop as a worker for the hub", () => {
  test("the worker lets in only the shared token", () => {
    expect(authorized("Bearer tok-123", "tok-123")).toBe(true);
    expect(authorized("Bearer tok-124", "tok-123")).toBe(false);
    expect(authorized("Bearer tok-123", "")).toBe(false);
    expect(authorized(null, "tok-123")).toBe(false);
  });
  test("no FLEET_LAPTOP_URL: no worker, nothing is fetched", async () => {
    delete process.env.FLEET_LAPTOP_URL;
    let calls = 0;
    _setLaptopFetchForTest((async () => (calls++, new Response("{}"))) as unknown as typeof fetch);
    expect(await laptopStatus()).toMatchObject({ configured: false, up: false });
    expect(calls).toBe(0);
  });
  test("awake: speech and Firstmate go to the laptop with the token; the health check is cached", async () => {
    process.env.FLEET_LAPTOP_URL = "https://laptop.example.ts.net:8790/";
    const seen: string[] = [];
    _setLaptopFetchForTest((async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${url} ${(init?.headers as Record<string, string>)?.Authorization}`);
      if (url.endsWith("/health")) return Response.json({ ok: true, capabilities: ["tts", "firstmate"] });
      if (url.endsWith("/tts")) return new Response(new Uint8Array([82, 73, 70, 70]));
      return Response.json({ ok: true, detail: "fm-send" });
    }) as unknown as typeof fetch);
    expect(await laptopTts("Aye, Captain.", "bf_isabella")).toEqual(new Uint8Array([82, 73, 70, 70]));
    expect(await laptopFirstmateSend("Bus: plan-draft")).toEqual({ ok: true, detail: "laptop: fm-send" });
    expect(seen.filter((s) => s.includes("/health")).length).toBe(1);
    expect(seen.every((s) => s.endsWith("Bearer tok-123"))).toBe(true);
    expect(seen[1]).toStartWith("POST https://laptop.example.ts.net:8790/tts");
  });
  test("asleep: speech fails fast (the page uses the browser's voice) and Firstmate waits", async () => {
    process.env.FLEET_LAPTOP_URL = "https://laptop.example.ts.net:8790";
    _setLaptopFetchForTest((async () => {
      throw new Error("connect timeout");
    }) as unknown as typeof fetch);
    await expect(laptopTts("hello", "bf_isabella")).rejects.toThrow("laptop is not available");
    expect((await laptopFirstmateSend("x")).ok).toBe(false);
    expect(await laptopStatus()).toMatchObject({ configured: true, up: false, error: "connect timeout" });
  });
  test("screenshots borrow the laptop's Chrome while it is up", async () => {
    process.env.FLEET_LAPTOP_URL = "https://laptop.example.ts.net:8790";
    const shot = { url: "https://fleet-hub.example.ts.net/harbor", width: 1440, height: 1000, mobile: false, wait: 0 };
    _setLaptopFetchForTest((async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) return Response.json({ ok: true, capabilities: ["browser"] });
      expect(JSON.parse(String(init?.body))).toEqual(shot);
      return new Response(new Uint8Array([137, 80, 78, 71]));
    }) as unknown as typeof fetch);
    expect(await laptopShot(shot)).toEqual({ ok: true, png: new Uint8Array([137, 80, 78, 71]) });
    _setLaptopFetchForTest((async () => Response.json({ ok: true, capabilities: ["tts"] })) as unknown as typeof fetch);
    expect(await laptopShot(shot)).toEqual({ ok: false, message: "the laptop is not available for screenshots" });
  });
});
