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
  const left =
    remaining === null || remaining === undefined
      ? "unknown remaining"
      : `${formatUsd(Number(remaining))} remaining`;
  return {
    provider: "openrouter",
    ok: true,
    at,
    headline: `${spend} this month`,
    detail: left,
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
    await Promise.all(jobs);
    usageCache = next;
  } finally {
    usageRunning = false;
  }
  return usageCache;
}
