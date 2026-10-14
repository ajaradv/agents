import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { envKeyValue, loadFleetDotenv } from "./fleet-env.ts";

export type ApiLaneUsage = {
  provider: string;
  ok: boolean;
  stale?: boolean;
  headline?: string;
  detail?: string;
  error?: string;
  at: string;
};

const FETCH_MS = 5000;

let usageCache: Record<string, ApiLaneUsage> = {};
let usageRunning = false;

export function getApiLaneUsageCache(): Record<string, ApiLaneUsage> {
  return usageCache;
}

async function fetchJson(
  url: string,
  apiKey: string,
): Promise<{ status: number; body: unknown; timedOut: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body, timedOut: false };
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "AbortError";
    return { status: 0, body: null, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function authError(status: number): string | null {
  if (status === 401 || status === 403) return "key rejected";
  return null;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function fetchDeepSeek(apiKey: string): Promise<ApiLaneUsage> {
  const at = new Date().toISOString();
  const prev = usageCache.deepseek;
  const { status, body, timedOut } = await fetchJson(
    "https://api.deepseek.com/user/balance",
    apiKey,
  );
  if (timedOut) {
    if (prev?.ok) {
      return { ...prev, stale: true, error: "usage stale (timed out)", at };
    }
    return { provider: "deepseek", ok: false, error: "timed out", at };
  }
  const auth = authError(status);
  if (auth) return { provider: "deepseek", ok: false, error: auth, at };
  if (status < 200 || status >= 300 || !body || typeof body !== "object") {
    return { provider: "deepseek", ok: false, error: `HTTP ${status || "error"}`, at };
  }
  const o = body as {
    is_available?: boolean;
    balance_infos?: Array<{
      currency?: string;
      total_balance?: string;
    }>;
  };
  const infos = Array.isArray(o.balance_infos) ? o.balance_infos : [];
  const usd = infos.find((i) => i.currency === "USD") ?? infos[0];
  if (!usd?.total_balance) {
    return { provider: "deepseek", ok: false, error: "no balance in response", at };
  }
  const currency = usd.currency ?? "";
  return {
    provider: "deepseek",
    ok: true,
    at,
    headline:
      currency === "USD"
        ? formatUsd(Number(usd.total_balance))
        : `${usd.total_balance} ${currency}`.trim(),
    detail: o.is_available === false ? "Balance not sufficient for API calls" : "Available balance",
  };
}

async function fetchOpenRouter(apiKey: string): Promise<ApiLaneUsage> {
  const at = new Date().toISOString();
  const prev = usageCache.openrouter;
  const { status, body, timedOut } = await fetchJson(
    "https://openrouter.ai/api/v1/key",
    apiKey,
  );
  if (timedOut) {
    if (prev?.ok) {
      return { ...prev, stale: true, error: "usage stale (timed out)", at };
    }
    return { provider: "openrouter", ok: false, error: "timed out", at };
  }
  const auth = authError(status);
  if (auth) return { provider: "openrouter", ok: false, error: auth, at };
  if (status < 200 || status >= 300 || !body || typeof body !== "object") {
    return { provider: "openrouter", ok: false, error: `HTTP ${status || "error"}`, at };
  }
  const data = (body as { data?: Record<string, unknown> }).data ?? {};
  const monthly = Number(data.usage_monthly ?? data.usage ?? 0);
  const remaining = data.limit_remaining;
  const limit = data.limit;
  const spend = Number.isFinite(monthly) ? formatUsd(monthly) : "—";
  if (limit === null || limit === undefined) {
    return {
      provider: "openrouter",
      ok: true,
      at,
      headline: `${spend} this month`,
      detail: "No key cap",
    };
  }
  // The key's limit is a spending cap, not money: the account's credits are
  // what runs out (a 402 "can only afford N tokens" means they are low).
  const credits = await fetchJson("https://openrouter.ai/api/v1/credits", apiKey);
  const c = (credits.body as { data?: { total_credits?: number; total_usage?: number } } | null)?.data;
  const creditsLeft =
    c && Number.isFinite(Number(c.total_credits)) ? Number(c.total_credits) - Number(c.total_usage ?? 0) : null;
  const cap =
    remaining === null || remaining === undefined ? "" : ` · key cap ${formatUsd(Number(remaining))} left`;
  return {
    provider: "openrouter",
    ok: true,
    at,
    headline: creditsLeft === null ? `${spend} this month` : `${formatUsd(creditsLeft)} credits left`,
    detail: `${spend} this month${cap}`,
  };
}

/** Pi's Junie sign-in (pi-jetbrains-junie-bridge); Pi refreshes it while a Junie model runs. */
async function junieToken(): Promise<{ access: string; expires: number } | null> {
  try {
    const auth = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as {
      junie?: { access?: string; expires?: number };
    };
    return auth.junie?.access ? { access: auth.junie.access, expires: Number(auth.junie.expires ?? 0) } : null;
  } catch {
    return null;
  }
}

export async function junieSignedIn(): Promise<boolean> {
  return Boolean(await junieToken());
}

/** Grazie reports credits, 100,000 to the dollar (as the bridge shows them). */
const JUNIE_CREDITS_PER_USD = 100_000;

async function fetchJunie(): Promise<ApiLaneUsage> {
  const at = new Date().toISOString();
  const prev = usageCache.junie;
  const tok = await junieToken();
  if (!tok) return { provider: "junie", ok: false, error: "not signed in (pi /login → JetBrains Junie)", at };
  if (tok.expires && tok.expires < Date.now()) {
    if (prev?.ok) return { ...prev, stale: true, error: "sign-in refreshes when a Junie agent runs", at };
    return { provider: "junie", ok: false, error: "sign-in expired; it refreshes when a Junie agent runs", at };
  }
  const { status, body, timedOut } = await fetchJson("https://ingrazzio-cloud-prod.labs.jb.gg/auth/test", tok.access);
  if (timedOut) return prev?.ok ? { ...prev, stale: true, at } : { provider: "junie", ok: false, error: "timed out", at };
  const auth = authError(status);
  if (auth) return { provider: "junie", ok: false, error: auth, at };
  const o = (body ?? {}) as { balanceLeft?: number; balanceUnit?: string; licenseType?: string; active?: boolean };
  if (typeof o.balanceLeft !== "number") return { provider: "junie", ok: false, error: `HTTP ${status || "error"}`, at };
  const usd = o.balanceUnit === "CREDITS" ? o.balanceLeft / JUNIE_CREDITS_PER_USD : o.balanceLeft;
  return {
    provider: "junie",
    ok: true,
    at,
    headline: `${formatUsd(usd)} credits left`,
    detail: `${o.licenseType ?? "Junie"} licence${o.active === false ? " (inactive)" : ""} · use before it expires`,
  };
}

export async function refreshApiLaneUsage(): Promise<Record<string, ApiLaneUsage>> {
  if (usageRunning) return usageCache;
  usageRunning = true;
  try {
    const dotenv = await loadFleetDotenv();
    const dsKey = envKeyValue("DEEPSEEK_API_KEY", dotenv);
    const orKey = envKeyValue("OPENROUTER_API_KEY", dotenv);
    const next = { ...usageCache };
    const jobs: Promise<void>[] = [];
    if (dsKey) {
      jobs.push(
        fetchDeepSeek(dsKey).then((u) => {
          next.deepseek = u;
        }),
      );
    } else {
      next.deepseek = {
        provider: "deepseek",
        ok: false,
        error: "key not set",
        at: new Date().toISOString(),
      };
    }
    if (orKey) {
      jobs.push(
        fetchOpenRouter(orKey).then((u) => {
          next.openrouter = u;
        }),
      );
    } else {
      next.openrouter = {
        provider: "openrouter",
        ok: false,
        error: "key not set",
        at: new Date().toISOString(),
      };
    }
    jobs.push(
      fetchJunie().then((u) => {
        next.junie = u;
      }),
    );
    await Promise.all(jobs);
    usageCache = next;
  } finally {
    usageRunning = false;
  }
  return usageCache;
}
