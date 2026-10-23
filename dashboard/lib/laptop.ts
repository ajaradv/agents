import { readSecret } from "./secret-store.ts";

/**
 * The captain's laptop as an occasional worker for the always-on hub
 * (vault plan fleet/plans/ops/exe-dev-hub-setup.md). The hub runs the fleet;
 * when the laptop is awake it lends what only it has: Kokoro voices (fast on
 * the M2 Max), Firstmate's TUI, and memory for heavy tools (screenshots). Asleep or offline, the hub carries on
 * without it (the browser's voice; Firstmate wakes wait).
 *
 * The laptop side is dashboard/worker.ts, reachable only on the tailnet
 * (Tailscale Serve) and only with the shared token (secret "laptop-worker-token").
 * FLEET_LAPTOP_URL names it on the hub; unset (the laptop itself) means no worker.
 */

const URL_ENV = () => (process.env.FLEET_LAPTOP_URL ?? "").replace(/\/+$/, "");
const HEALTH_TTL_MS = 30_000;

export type LaptopStatus = { configured: boolean; up: boolean; capabilities: string[]; ms: number; error?: string; checkedAt: number };

let cached: LaptopStatus | null = null;
let fetchImpl: typeof fetch = fetch;
/** Test seam. */
export function _setLaptopFetchForTest(f: typeof fetch | null): void {
  fetchImpl = f ?? fetch;
  cached = null;
}

async function headers(): Promise<Record<string, string>> {
  const token = await readSecret("laptop-worker-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The worker token (secret "laptop-worker-token"). */
export const laptopToken = () => readSecret("laptop-worker-token");

/** A request to the laptop worker with its token (lib/laptop-host.ts). Throws when it is not configured. */
export async function laptopFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!URL_ENV()) throw new Error("no laptop worker (FLEET_LAPTOP_URL)");
  const r = await fetchImpl(`${URL_ENV()}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(await headers()) } });
  if (r.status >= 500 || r.status === 401) cached = null;
  return r;
}

/** Is the laptop worker up, and what can it do? Cached for 30 seconds; never throws. */
export async function laptopStatus(force = false): Promise<LaptopStatus> {
  const base = URL_ENV();
  if (!base) return { configured: false, up: false, capabilities: [], ms: 0, checkedAt: Date.now() };
  if (!force && cached && Date.now() - cached.checkedAt < HEALTH_TTL_MS) return cached;
  const t0 = Date.now();
  try {
    const r = await fetchImpl(`${base}/health`, { headers: await headers(), signal: AbortSignal.timeout(3000) });
    const j = (await r.json().catch(() => ({}))) as { capabilities?: string[] };
    cached = r.ok
      ? { configured: true, up: true, capabilities: j.capabilities ?? [], ms: Date.now() - t0, checkedAt: Date.now() }
      : { configured: true, up: false, capabilities: [], ms: Date.now() - t0, error: `HTTP ${r.status}`, checkedAt: Date.now() };
  } catch (e) {
    cached = { configured: true, up: false, capabilities: [], ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() };
  }
  return cached;
}

export async function laptopCan(capability: string): Promise<boolean> {
  const s = await laptopStatus();
  return s.up && s.capabilities.includes(capability);
}

/** Kokoro on the laptop: WAV bytes, or an error when it is not available. */
export async function laptopTts(text: string, voice: string, speed = 1.0): Promise<Uint8Array> {
  if (!(await laptopCan("tts"))) throw new Error("Local voice is on the laptop, and the laptop is not available.");
  const r = await fetchImpl(`${URL_ENV()}/tts`, {
    method: "POST",
    headers: { ...(await headers()), "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed }),
    signal: AbortSignal.timeout(65_000),
  });
  if (!r.ok) {
    cached = null;
    throw new Error(`laptop voice failed (HTTP ${r.status})`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

/** Type a line into Firstmate's TUI on the laptop. */
export async function laptopFirstmateSend(text: string): Promise<{ ok: boolean; detail: string }> {
  if (!(await laptopCan("firstmate"))) return { ok: false, detail: "Firstmate runs on the laptop, and the laptop is not available" };
  try {
    const r = await fetchImpl(`${URL_ENV()}/firstmate`, {
      method: "POST",
      headers: { ...(await headers()), "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
    return { ok: r.ok && j.ok === true, detail: `laptop: ${j.detail ?? `HTTP ${r.status}`}` };
  } catch (e) {
    cached = null;
    return { ok: false, detail: `laptop: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * A screenshot taken by the laptop's Chrome (bin/fleet-shot --on laptop|auto):
 * PNG bytes, or why not. The page must be reachable from the laptop.
 */
export async function laptopShot(o: { url: string; width: number; height: number; mobile: boolean; wait: number }): Promise<{ ok: true; png: Uint8Array } | { ok: false; message: string }> {
  if (!(await laptopCan("browser"))) return { ok: false, message: "the laptop is not available for screenshots" };
  try {
    const r = await fetchImpl(`${URL_ENV()}/shot`, {
      method: "POST",
      headers: { ...(await headers()), "Content-Type": "application/json" },
      body: JSON.stringify(o),
      signal: AbortSignal.timeout(o.wait + 90_000),
    });
    if (!r.ok) return { ok: false, message: `laptop: ${((await r.json().catch(() => ({}))) as { message?: string }).message ?? `HTTP ${r.status}`}` };
    return { ok: true, png: new Uint8Array(await r.arrayBuffer()) };
  } catch (e) {
    cached = null;
    return { ok: false, message: `laptop: ${e instanceof Error ? e.message : String(e)}` };
  }
}
