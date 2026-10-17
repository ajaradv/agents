import { agentKeyEnv } from "./fleet-env.ts";
import { metricsDb } from "./metrics.ts";

/**
 * Free model lanes (vault research note free-model-lanes): OpenRouter's
 * zero-price models and Google AI Studio's free tier, for throwaway work.
 *
 * - **Registry**: once a day the node lists the free models, their endpoint
 *   uptime and latency, and runs a tiny capability check (a synthetic JSON
 *   task) on each; results go to the metrics database (free_models).
 * - **Quota**: OpenRouter reports today's free requests (used of 1000) on
 *   /api/v1/key; Gemini reports nothing, so every call is counted here
 *   (free_calls), per model per day, and a lane near its limit is skipped.
 * - **freeComplete**: a call for non-sensitive text only. It tries the best
 *   free models that fit (OpenRouter with `data_collection: deny`, so only
 *   providers that do not keep prompts), then falls back to a paid model.
 *   Never send repo code, vault notes, chats, or secrets: free tiers may train
 *   on prompts or show them to human reviewers.
 */

const OR = "https://openrouter.ai/api/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
/** Paid fallback through OpenRouter (the scout's backup model). */
export const PAID_FALLBACK = process.env.FLEET_FREE_FALLBACK ?? "deepseek/deepseek-v4-flash";
/** Gemini free-tier requests per model per day we allow ourselves (AI Studio shows the real limits; stay under them). */
const GEMINI_DAILY_CAP = Number(process.env.FLEET_GEMINI_DAILY_CAP) || 200;
const TIMEOUT_MS = 45_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS free_models (
  provider TEXT NOT NULL, model TEXT NOT NULL, ctx INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0, uptime REAL, latency_ms INTEGER, check_ok INTEGER, check_ms INTEGER,
  note TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL, PRIMARY KEY (provider, model)
);
CREATE TABLE IF NOT EXISTS free_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL, ms INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS free_calls_day ON free_calls(provider, model, ts);
`;
function db() {
  const d = metricsDb();
  d.exec(SCHEMA);
  return d;
}

export type FreeModel = { provider: "openrouter" | "google"; model: string; ctx: number; tools: boolean; images: boolean; uptime: number | null; latencyMs: number | null; checkOk: boolean | null; checkMs: number | null; note: string; checkedAt: string };

async function getJson(url: string, headers: Record<string, string> = {}, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(url, { ...init, headers: { Accept: "application/json", ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(timeoutMs) });
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      /* not JSON */
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: { error: { message: e instanceof Error ? e.message : String(e) } } };
  }
}

// ---------------------------------------------------------------- quota

export function recordFreeCall(c: { provider: string; model: string; purpose: string; ok: boolean; ms: number; error?: string }): void {
  try {
    db().query("INSERT INTO free_calls (ts, provider, model, purpose, ok, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)").run(new Date().toISOString(), c.provider, c.model, c.purpose, c.ok ? 1 : 0, Math.round(c.ms), (c.error ?? "").slice(0, 300));
  } catch {
    /* metrics never break the work */
  }
}

/** Gemini's day starts at midnight Pacific; OpenRouter's at midnight UTC. */
export function quotaDayStart(provider: string, now = new Date()): string {
  if (provider !== "google") return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const offset = now.getTime() - pacific.getTime();
  pacific.setHours(0, 0, 0, 0);
  return new Date(pacific.getTime() + offset).toISOString();
}

export function callsToday(provider: string, model?: string): number {
  try {
    const since = quotaDayStart(provider);
    const r = model
      ? db().query("SELECT COUNT(*) AS n FROM free_calls WHERE provider = ? AND model = ? AND ts >= ?").get(provider, model, since)
      : db().query("SELECT COUNT(*) AS n FROM free_calls WHERE provider = ? AND ts >= ?").get(provider, since);
    return (r as { n: number }).n;
  } catch {
    return 0;
  }
}

let orQuota: { used: number; limit: number; remaining: number; at: number } | null = null;

/** OpenRouter's own count of today's free requests (cached 5 minutes). */
export async function openRouterFreeQuota(): Promise<{ used: number; limit: number; remaining: number } | null> {
  if (orQuota && Date.now() - orQuota.at < 300_000) return orQuota;
  const key = (await agentKeyEnv()).OPENROUTER_API_KEY;
  if (!key) return null;
  const r = await getJson(`${OR}/key`, { Authorization: `Bearer ${key}` });
  const q = r.body?.data?.free_model_daily_requests;
  if (!q || typeof q.limit !== "number") return null;
  orQuota = { used: Number(q.used) || 0, limit: q.limit, remaining: Number(q.remaining) || 0, at: Date.now() };
  return orQuota;
}

// ---------------------------------------------------------------- registry

/** The capability check: a synthetic task with one right answer, scored by code. */
const CHECK_PROMPT = 'Return only this JSON, nothing else: {"city": "Lisbon", "items": 3}. The city is Lisbon and there are 3 items.';
export function checkPassed(text: string): boolean {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return false;
  try {
    const j = JSON.parse(m[0]);
    return j.city === "Lisbon" && Number(j.items) === 3;
  } catch {
    return false;
  }
}

/** Zero-price text models on OpenRouter, from its public catalog. */
export function freeFromCatalog(models: any[]): Omit<FreeModel, "uptime" | "latencyMs" | "checkOk" | "checkMs" | "note" | "checkedAt">[] {
  return models
    .filter((m) => m?.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
    // Text in and out only (music and image generators list text too, but answer in audio or images).
    .filter((m) => {
      const out: string[] = m.architecture?.output_modalities ?? ["text"];
      return out.includes("text") && !out.includes("audio") && !out.includes("image") && m.id !== "openrouter/free";
    })
    .map((m) => ({
      provider: "openrouter" as const,
      model: String(m.id),
      ctx: Number(m.context_length) || 0,
      tools: (m.supported_parameters ?? []).includes("tools"),
      images: (m.architecture?.input_modalities ?? []).includes("image"),
    }));
}

/** Gemini models worth checking on the free tier: flash and flash-lite text models and Gemma (Pro is not free). */
export function geminiCandidates(models: any[]): string[] {
  return models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => String(m.name ?? "").replace(/^models\//, ""))
    .filter((n) => /^(gemini-[\d.]+-flash(-lite)?|gemini-flash(-lite)?-latest|gemma-[\w.-]+)$/.test(n));
}

async function checkOpenRouter(key: string, model: string): Promise<{ ok: boolean; ms: number; note: string }> {
  const t = Date.now();
  const r = await getJson(`${OR}/chat/completions`, { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, {
    method: "POST",
    body: JSON.stringify({ model, messages: [{ role: "user", content: CHECK_PROMPT }], max_tokens: 400, provider: { data_collection: "deny" } }),
  });
  const ms = Date.now() - t;
  const text = String(r.body?.choices?.[0]?.message?.content ?? "");
  const ok = r.status === 200 && checkPassed(text);
  recordFreeCall({ provider: "openrouter", model, purpose: "registry check", ok, ms, error: ok ? "" : String(r.body?.error?.message ?? `HTTP ${r.status}`) });
  const err = String(r.body?.error?.message ?? "");
  const note = ok ? "" : /data policy|no endpoints/i.test(err) ? "no endpoint that keeps prompts private" : r.status === 200 ? "wrong answer" : err.slice(0, 120) || `HTTP ${r.status}`;
  return { ok, ms, note };
}

async function checkGemini(key: string, model: string): Promise<{ ok: boolean; ms: number; note: string }> {
  const t = Date.now();
  const r = await getJson(`${GEMINI}/models/${model}:generateContent`, { "x-goog-api-key": key, "Content-Type": "application/json" }, {
    method: "POST",
    body: JSON.stringify({ contents: [{ parts: [{ text: CHECK_PROMPT }] }], generationConfig: { maxOutputTokens: 400 } }),
  });
  const ms = Date.now() - t;
  const text = String((r.body?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
  const ok = r.status === 200 && checkPassed(text);
  recordFreeCall({ provider: "google", model, purpose: "registry check", ok, ms, error: ok ? "" : String(r.body?.error?.status ?? `HTTP ${r.status}`) });
  return { ok, ms, note: ok ? "" : r.status === 429 ? "not on the free tier (429)" : r.status === 200 ? "wrong answer" : String(r.body?.error?.status ?? `HTTP ${r.status}`) };
}

let refreshing = false;

/** Refresh the registry: catalog, endpoint health, and one capability check per model. */
export async function refreshFreeModels(): Promise<{ openrouter: number; google: number } | null> {
  if (refreshing) return null;
  refreshing = true;
  try {
    // agentKeyEnv retries once: the .env is a 1Password pipe that can read empty for a moment.
    const keys = await agentKeyEnv();
    const orKey = keys.OPENROUTER_API_KEY ?? "";
    const gKey = keys.GEMINI_API_KEY ?? "";
    const now = new Date().toISOString();
    const rows: FreeModel[] = [];
    const catalog = await getJson(`${OR}/models`);
    for (const m of freeFromCatalog(catalog.body?.data ?? [])) {
      const ep = await getJson(`${OR}/models/${m.model}/endpoints`);
      const eps: any[] = ep.body?.data?.endpoints ?? [];
      const best = eps.sort((a, b) => (Number(b.uptime_last_1d) || 0) - (Number(a.uptime_last_1d) || 0))[0];
      const check = orKey ? await checkOpenRouter(orKey, m.model) : { ok: false, ms: 0, note: "no OpenRouter key" };
      rows.push({ ...m, uptime: best?.uptime_last_1d ?? null, latencyMs: best?.latency_last_30m != null ? Math.round(Number(best.latency_last_30m)) : null, checkOk: check.ok, checkMs: check.ms, note: check.note, checkedAt: now });
    }
    if (gKey) {
      const list = await getJson(`${GEMINI}/models?pageSize=1000`, { "x-goog-api-key": gKey });
      const meta = new Map<string, any>((list.body?.models ?? []).map((m: any) => [String(m.name).replace(/^models\//, ""), m]));
      for (const model of geminiCandidates(list.body?.models ?? [])) {
        const check = await checkGemini(gKey, model);
        rows.push({ provider: "google", model, ctx: Number(meta.get(model)?.inputTokenLimit) || 0, tools: true, images: true, uptime: null, latencyMs: null, checkOk: check.ok, checkMs: check.ms, note: check.note, checkedAt: now });
      }
    }
    const d = db();
    const ins = d.query(`INSERT INTO free_models (provider, model, ctx, tools, images, uptime, latency_ms, check_ok, check_ms, note, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, model) DO UPDATE SET ctx = excluded.ctx, tools = excluded.tools, images = excluded.images, uptime = excluded.uptime, latency_ms = excluded.latency_ms, check_ok = excluded.check_ok, check_ms = excluded.check_ms, note = excluded.note, checked_at = excluded.checked_at`);
    for (const r of rows) ins.run(r.provider, r.model, r.ctx, r.tools ? 1 : 0, r.images ? 1 : 0, r.uptime, r.latencyMs, r.checkOk === null ? null : r.checkOk ? 1 : 0, r.checkMs, r.note, r.checkedAt);
    // Models that left the catalog are gone, not merely failing.
    const seen = new Set(rows.map((r) => `${r.provider}\u0000${r.model}`));
    for (const old of d.query("SELECT provider, model FROM free_models").all() as { provider: string; model: string }[]) {
      if (!seen.has(`${old.provider}\u0000${old.model}`) && (old.provider === "openrouter" || gKey)) d.query("DELETE FROM free_models WHERE provider = ? AND model = ?").run(old.provider, old.model);
    }
    return { openrouter: rows.filter((r) => r.provider === "openrouter").length, google: rows.filter((r) => r.provider === "google").length };
  } finally {
    refreshing = false;
  }
}

export function listFreeModels(): FreeModel[] {
  try {
    return (db().query("SELECT * FROM free_models ORDER BY check_ok DESC, provider, model").all() as any[]).map((r) => ({
      provider: r.provider,
      model: r.model,
      ctx: r.ctx,
      tools: r.tools === 1,
      images: r.images === 1,
      uptime: r.uptime,
      latencyMs: r.latency_ms,
      checkOk: r.check_ok === null ? null : r.check_ok === 1,
      checkMs: r.check_ms,
      note: r.note,
      checkedAt: r.checked_at,
    }));
  } catch {
    return [];
  }
}

/** When the registry was last refreshed (ISO), or "" when never. */
export function freeRegistryAge(): string {
  try {
    return ((db().query("SELECT MAX(checked_at) AS t FROM free_models").get() as { t: string | null }).t ?? "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- calls

export type Needs = { tools?: boolean; images?: boolean; minCtx?: number };

/**
 * Free models that fit, best first: passed today's check, enough context and
 * the needed capabilities, quota left; OpenRouter by uptime then speed.
 */
export function pickFreeModels(all: FreeModel[], needs: Needs, quota: { openrouterRemaining: number | null; googleUsed: (model: string) => number }): FreeModel[] {
  return all
    .filter((m) => m.checkOk && (!needs.tools || m.tools) && (!needs.images || m.images) && m.ctx >= (needs.minCtx ?? 0))
    .filter((m) => (m.provider === "openrouter" ? quota.openrouterRemaining === null || quota.openrouterRemaining > 5 : quota.googleUsed(m.model) < GEMINI_DAILY_CAP))
    .sort((a, b) => {
      // Gemini reports no uptime and its free tier may train on prompts, so it counts as 90%:
      // a reliable OpenRouter model that keeps prompts private comes first.
      const score = (m: FreeModel) => (m.uptime ?? 90) / 100 - (m.checkMs ?? 10_000) / 60_000;
      return score(b) - score(a);
    });
}

export type FreeResult = { ok: boolean; text: string; model: string; free: boolean; tried: string[]; cost: number; ms: number; error?: string };

/**
 * One completion for NON-SENSITIVE text: up to three free models in order,
 * then the paid fallback. Every call is counted.
 */
export async function freeComplete(
  prompt: string,
  opts: { purpose: string; system?: string; needs?: Needs; maxTokens?: number; paidFallback?: string | null; attempts?: number; attemptMs?: number } = { purpose: "" },
): Promise<FreeResult> {
  const started = Date.now();
  const keys = await agentKeyEnv();
  const orKey = keys.OPENROUTER_API_KEY ?? "";
  const gKey = keys.GEMINI_API_KEY ?? "";
  if (!orKey && !gKey) return { ok: false, text: "", model: "", free: true, tried: [], cost: 0, ms: Date.now() - started, error: "no OpenRouter or Gemini key could be read (fleet/home/.env)" };
  const quota = await openRouterFreeQuota().catch(() => null);
  const candidates = pickFreeModels(listFreeModels(), opts.needs ?? {}, { openrouterRemaining: quota?.remaining ?? null, googleUsed: (m) => callsToday("google", m) }).slice(0, opts.attempts ?? 3);
  const wait = opts.attemptMs ?? TIMEOUT_MS;
  const messages = [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: prompt }];
  const tried: string[] = [];
  for (const m of candidates) {
    tried.push(`${m.provider}/${m.model}`);
    const t = Date.now();
    let text = "";
    let error = "";
    if (m.provider === "openrouter" && orKey) {
      const r = await getJson(`${OR}/chat/completions`, { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" }, {
        method: "POST",
        body: JSON.stringify({ model: m.model, messages, max_tokens: opts.maxTokens ?? 800, provider: { data_collection: "deny" } }),
      }, wait);
      text = String(r.body?.choices?.[0]?.message?.content ?? "");
      if (r.status !== 200 || !text.trim()) error = String(r.body?.error?.message ?? `HTTP ${r.status}`);
    } else if (m.provider === "google" && gKey) {
      const r = await getJson(`${GEMINI}/models/${m.model}:generateContent`, { "x-goog-api-key": gKey, "Content-Type": "application/json" }, {
        method: "POST",
        body: JSON.stringify({ ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}), contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: opts.maxTokens ?? 800 } }),
      }, wait);
      text = String((r.body?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
      if (r.status !== 200 || !text.trim()) error = String(r.body?.error?.status ?? `HTTP ${r.status}`);
    } else continue;
    recordFreeCall({ provider: m.provider, model: m.model, purpose: opts.purpose, ok: !error, ms: Date.now() - t, error });
    if (!error) return { ok: true, text, model: `${m.provider}/${m.model}`, free: true, tried, cost: 0, ms: Date.now() - started };
  }
  const paid = opts.paidFallback === undefined ? PAID_FALLBACK : opts.paidFallback;
  if (!paid || !orKey) return { ok: false, text: "", model: "", free: true, tried, cost: 0, ms: Date.now() - started, error: !paid ? "no free model answered and there is no paid fallback" : "no free model answered, and the paid fallback needs the OpenRouter key" };
  tried.push(`openrouter/${paid}`);
  const r = await getJson(`${OR}/chat/completions`, { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" }, {
    method: "POST",
    body: JSON.stringify({ model: paid, messages, max_tokens: opts.maxTokens ?? 800, usage: { include: true } }),
  }, wait);
  const text = String(r.body?.choices?.[0]?.message?.content ?? "");
  const ok = r.status === 200 && Boolean(text.trim());
  return { ok, text, model: `openrouter/${paid}`, free: false, tried, cost: Number(r.body?.usage?.cost) || 0, ms: Date.now() - started, ...(ok ? {} : { error: String(r.body?.error?.message ?? `HTTP ${r.status}`) }) };
}

// ---------------------------------------------------------------- view

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ctxLabel = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** Health → Usage: the free lanes, today's quota, and which free models work right now. */
export async function freeModelsHtml(): Promise<string> {
  const all = listFreeModels();
  const age = freeRegistryAge();
  if (!all.length && !age) return "";
  const quota = await openRouterFreeQuota().catch(() => null);
  const ok = all.filter((m) => m.checkOk);
  const bad = all.filter((m) => !m.checkOk);
  const row = (m: FreeModel) => `<tr>
      <td>${m.provider === "google" ? "Gemini" : "OpenRouter"}</td>
      <td><code>${esc(m.model)}</code></td>
      <td class="num">${ctxLabel(m.ctx)}</td>
      <td>${m.tools ? "tools" : ""}${m.images ? `${m.tools ? " · " : ""}images` : ""}</td>
      <td class="num">${m.uptime === null ? "–" : `${Math.round(m.uptime)}%`}</td>
      <td class="num">${m.checkMs === null ? "–" : `${(m.checkMs / 1000).toFixed(1)}s`}</td>
    </tr>`;
  const refreshed = age ? new Date(age).toLocaleString() : "never";
  return `<div class="stack free-models">
      <div class="between"><h3>Free models</h3><span class="muted">checked ${esc(refreshed)} · daily</span></div>
      <p class="muted">OpenRouter free requests today: ${quota ? `${quota.used} of ${quota.limit}` : "unknown"} (resets midnight UTC) · Gemini free-tier calls today: ${callsToday("google")} (resets midnight Pacific; limits in AI Studio). Non-sensitive text only: free tiers may train on prompts. OpenRouter calls ask for providers that keep prompts private.</p>
      ${ok.length ? `<div class="overflow-x-auto metric-table"><table class="d-table d-table-zebra d-table-sm bg-base-100"><thead><tr><th>Lane</th><th>Model</th><th class="num">Context</th><th>Can</th><th class="num" title="OpenRouter endpoint uptime, last day">Uptime</th><th class="num" title="Time for the daily capability check">Check</th></tr></thead><tbody>${ok.map(row).join("")}</tbody></table></div>` : `<p class="muted">No free model passed today's check.</p>`}
      ${bad.length ? `<details class="d-collapse d-collapse-arrow d-collapse-border bg-base-100"><summary class="d-collapse-title">${bad.length} free models not usable today</summary><ul class="d-collapse-content meter-list">${bad.map((m) => `<li><span><code>${esc(m.model)}</code></span><span class="muted">${esc(m.note || "failed the check")}</span></li>`).join("")}</ul></details>` : ""}
    </div>`;
}
