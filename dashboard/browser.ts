/**
 * The shared browser: one headless Chrome per host for every agent's
 * screenshots (vault fleet-architecture-options, S2). Each fleet-shot used to
 * start a full Chrome (300-600 MB) and kill it; three crewmates checking a page
 * at once ran three. Now:
 *
 * - Chrome starts on the first request and stops after IDLE_MS without one.
 * - Each job runs in its own browser context (like a private window: no shared
 *   cookies or storage between jobs or ships), closed when the job ends.
 * - At most MAX_JOBS run at once; the rest wait their turn.
 *
 *   POST /shot {url, width, height, mobile, wait} → image/png
 *   GET  /health → {chrome: "running" | "stopped", jobs, queued}
 *
 * Listens on 127.0.0.1 only (FLEET_BROWSER_PORT, default 8789). bin/fleet-shot
 * calls it and falls back to its own Chrome when it is not running.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.FLEET_BROWSER_PORT) || 8789;
export const IDLE_MS = 5 * 60_000;
export const MAX_JOBS = 3;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

export function chromeBin(): string | null {
  const candidates = [
    process.env.CHROME_PATH ?? "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

/** A tiny counting semaphore: MAX_JOBS at once, the rest in order. */
export class Gate {
  private running = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  get active() {
    return this.running;
  }
  get queued() {
    return this.waiters.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }
}

type Browser = { proc: ReturnType<typeof Bun.spawn>; ws: WebSocket; profile: string; send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>; on: Map<string, (m: any) => void> };

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function startChrome(): Promise<Browser> {
  const bin = chromeBin();
  if (!bin) throw new Error("no Chrome or Chromium found (set CHROME_PATH)");
  const profile = mkdtempSync(join(tmpdir(), "fleet-browser-"));
  const proc = Bun.spawn([bin, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let port = "";
  for (const deadline = Date.now() + 20_000; !port && Date.now() < deadline; ) {
    try {
      port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!.trim();
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!port) {
    proc.kill("SIGKILL");
    throw new Error("Chrome did not open its DevTools port");
  }
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
  let id = 0;
  const waiting = new Map<number, (m: any) => void>();
  const on = new Map<string, (m: any) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)!(m);
      waiting.delete(m.id);
    } else if (m.method && m.sessionId) on.get(`${m.sessionId}:${m.method}`)?.(m);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((r) => {
      waiting.set(++id, r);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  void proc.exited.then(() => {
    if (browser?.proc === proc) browser = null;
    rmSync(profile, { recursive: true, force: true });
  });
  return { proc, ws, profile, send, on };
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  starting ??= startChrome().finally(() => (starting = null));
  browser = await starting;
  return browser;
}

function touchIdle(gate: Gate): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (gate.active || gate.queued || !browser) return;
    browser.ws.close();
    browser.proc.kill("SIGTERM");
    browser = null;
  }, IDLE_MS);
}

/** One screenshot in its own browser context. */
async function shot(o: { url: string; width: number; height: number; mobile: boolean; wait: number }): Promise<Uint8Array> {
  const b = await getBrowser();
  const { result: ctx } = await b.send("Target.createBrowserContext", { disposeOnDetach: true });
  const contextId = ctx.browserContextId as string;
  try {
    const { result: t } = await b.send("Target.createTarget", { url: "about:blank", browserContextId: contextId });
    const { result: a } = await b.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    const s = a.sessionId as string;
    const loaded = new Promise<void>((r) => b.on.set(`${s}:Page.loadEventFired`, () => r()));
    await b.send("Page.enable", {}, s);
    await b.send("Emulation.setDeviceMetricsOverride", { width: o.width, height: o.height, deviceScaleFactor: o.mobile ? 2 : 1, mobile: o.mobile }, s);
    if (o.mobile) await b.send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA }, s);
    const nav = await b.send("Page.navigate", { url: o.url }, s);
    if (nav.result?.errorText) throw new Error(`the page did not load: ${nav.result.errorText}`);
    await Promise.race([loaded, Bun.sleep(20_000)]);
    await Bun.sleep(o.wait);
    const cap = await Promise.race([b.send("Page.captureScreenshot", { format: "png" }, s), Bun.sleep(20_000).then(() => null)]);
    b.on.delete(`${s}:Page.loadEventFired`);
    await b.send("Target.closeTarget", { targetId: t.targetId });
    if (!cap?.result?.data) throw new Error("the capture timed out");
    return Buffer.from(cap.result.data, "base64");
  } finally {
    await b.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => {});
  }
}

if (import.meta.main) {
  const gate = new Gate(MAX_JOBS);
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return Response.json({ chrome: browser ? "running" : "stopped", jobs: gate.active, queued: gate.queued });
      if (path === "/shot" && req.method === "POST") {
        const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const url = String(b.url ?? "");
        if (!/^https?:\/\//.test(url)) return Response.json({ ok: false, message: "an http(s) url" }, { status: 400 });
        const o = {
          url,
          width: Math.min(3000, Math.max(200, Number(b.width) || 1440)),
          height: Math.min(8000, Math.max(300, Number(b.height) || 1000)),
          mobile: Boolean(b.mobile),
          wait: Math.min(30_000, Math.max(0, Number(b.wait) || 0)),
        };
        try {
          const png = await gate.run(() => shot(o));
          touchIdle(gate);
          return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
        } catch (e) {
          touchIdle(gate);
          return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`shared browser http://127.0.0.1:${PORT}`);
}
