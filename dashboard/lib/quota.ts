import {
  parseQuotaFromJson,
  parseQuotaToon,
  type ParsedQuota,
  type ProviderCard,
} from "./quota-parse.ts";
import { apiLaneCardHtml, readConfiguredApiLanes } from "./api-lanes.ts";
import { getApiLaneUsageCache, refreshApiLaneUsage } from "./api-lane-usage.ts";
import { dashLog } from "./log.ts";
import { spawnTimed } from "./proc.ts";

export type QuotaCache = {
  at: string;
  ok: boolean;
  raw: string;
  parsed: ParsedQuota | null;
  error?: string;
  loading: boolean;
  stale?: boolean;
};

let cache: QuotaCache = {
  at: "",
  ok: false,
  raw: "",
  parsed: null,
  error: "not loaded",
  loading: true,
};

let quotaRunning = false;
let pauseUntil = 0;

export function getQuotaCache(): QuotaCache {
  return cache;
}

export function pauseQuotaUntil(msFromNow: number): void {
  pauseUntil = Date.now() + msFromNow;
}

async function commandOnPath(name: string): Promise<boolean> {
  const r = await spawnTimed(["sh", "-c", `command -v ${name}`], { timeoutMs: 2000 });
  return r.exitCode === 0 && r.stdout.length > 0;
}

async function runQuotaAxi(): Promise<QuotaCache> {
  if (!(await commandOnPath("quota-axi"))) {
    return {
      at: new Date().toISOString(),
      ok: false,
      raw: "",
      parsed: null,
      error: "quota-axi not on PATH",
      loading: false,
    };
  }

  const run = await spawnTimed(
    ["quota-axi", "--json", "--max-age", "15m"],
    { timeoutMs: 20_000, env: process.env },
  );
  await dashLog(
    "quota",
    `${run.ms}ms exit=${run.exitCode} timedOut=${run.timedOut}`,
  );

  if (run.timedOut) {
    return {
      at: cache.at || new Date().toISOString(),
      ok: cache.ok,
      raw: cache.raw,
      parsed: cache.parsed,
      error: cache.ok ? "usage stale (quota-axi timed out)" : "quota-axi timed out",
      loading: false,
      stale: true,
    };
  }

  const raw = run.stdout || run.stderr;
  const parsed = parseQuotaFromJson(raw);
  return {
    at: new Date().toISOString(),
    ok: run.exitCode === 0 && raw.length > 0,
    raw,
    parsed,
    error: run.exitCode === 0 ? undefined : `exit ${run.exitCode}`,
    loading: false,
    stale: false,
  };
}

export async function refreshQuotaAsync(): Promise<QuotaCache> {
  if (quotaRunning) return cache;
  if (Date.now() < pauseUntil) return cache;
  quotaRunning = true;
  cache = { ...cache, loading: !cache.ok };
  try {
    const next = await runQuotaAxi();
    if (next.stale && cache.parsed) {
      cache = { ...next, parsed: cache.parsed, raw: cache.raw, ok: cache.ok };
    } else {
      cache = next;
    }
    await refreshApiLaneUsage();
  } catch (e) {
    cache = {
      at: new Date().toISOString(),
      ok: false,
      raw: cache.raw,
      parsed: cache.parsed,
      error: e instanceof Error ? e.message : "quota refresh failed",
      loading: false,
      stale: true,
    };
  } finally {
    quotaRunning = false;
  }
  return cache;
}

export function scheduleQuotaLoop(onDone: () => void): void {
  const tick = async () => {
    try {
      await refreshQuotaAsync();
      onDone();
    } catch (e) {
      console.error("[dashboard] quota refresh:", e);
    }
    setTimeout(tick, 10 * 60_000);
  };
  void tick();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runwayLabel(runway: string | undefined): string {
  if (!runway) return "";
  const map: Record<string, string> = {
    through_reset: "Through reset",
    exhausted_now: "Exhausted",
    unknown: "Unknown",
  };
  return map[runway] ?? runway.replace(/_/g, " ");
}

function formatReset(iso: string | undefined): string {
  if (!iso || iso === "unknown") return "";
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso;
  return new Date(d).toLocaleString();
}

function percentBadgeClass(n: number): string {
  if (n <= 0) return "meter-hot";
  if (n <= 20) return "meter-mid";
  return "meter-ok";
}

/** Ten Zelda-style hearts; last heart may be partial. */
export function heartsMeterHtml(percentRemaining: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(percentRemaining)));
  const full = Math.floor(pct / 10);
  const partial = pct % 10;
  const bits: string[] = [];
  for (let i = 0; i < 10; i++) {
    if (i < full) bits.push('<span class="heart heart-full"></span>');
    else if (i === full && partial > 0) {
      bits.push(`<span class="heart heart-part" style="--fill:${partial * 10}%"></span>`);
    } else bits.push('<span class="heart heart-empty"></span>');
  }
  return `<span class="hearts" role="img" aria-label="${pct} percent remaining">${bits.join("")}</span>`;
}

function providerCardHtml(card: ProviderCard): string {
  const pct = Number.isFinite(card.headlinePercent) ? card.headlinePercent : 0;
  const planBadge = card.plan ? `<span class="muted">${escapeHtml(card.plan)}</span>` : "";
  const runwayLine = card.runway
    ? `<p class="muted">${escapeHtml(runwayLabel(card.runway))}</p>`
    : "";

  const windowRows = card.windows
    .map((w) => {
      return `<li>
        <span>${escapeHtml(w.label || w.id)}</span>
        ${heartsMeterHtml(w.percentRemaining)}
      </li>`;
    })
    .join("");

  const scopeRows = card.scopes
    .filter((s) => s.scope !== "all_models" || card.windows.length === 0)
    .map((s) => {
      const bounded =
        s.boundedBy.length > 0 ? ` (${escapeHtml(s.boundedBy.join(", "))})` : "";
      return `<li>
        <span>${escapeHtml(s.scope)}${bounded}</span>
        ${heartsMeterHtml(s.percentRemaining)}
      </li>`;
    })
    .join("");

  const subList = windowRows || scopeRows ? `<ul class="meter-list">${windowRows}${scopeRows}</ul>` : "";
  const notes = card.notes.map((n) => `<p class="warn">${escapeHtml(n)}</p>`).join("");
  const headlineScope =
    card.headlineScope && card.headlineScope !== "all_models"
      ? ` <span class="muted">${escapeHtml(card.headlineScope)}</span>`
      : "";

  return `<article class="sheet">
      <div class="between">
        <h3 class="sheet-title">${escapeHtml(card.provider)} ${planBadge}${headlineScope}</h3>
        ${heartsMeterHtml(pct)}
      </div>
      ${runwayLine}
      ${subList}
      ${notes}
    </article>`;
}

async function apiLanesHtml(quotaIds: Set<string>): Promise<string> {
  const apiLanes = await readConfiguredApiLanes(quotaIds, getApiLaneUsageCache());
  const apiCards = apiLanes.map(apiLaneCardHtml).join("");
  if (!apiCards) return "";
  return `<div class="stack">
      <h3>Configured API lanes</h3>
      <div class="grid-3">${apiCards}</div>
    </div>`;
}

export async function usagePartialHtml(): Promise<string> {
  const q = getQuotaCache();
  const parsed: ParsedQuota =
    q.parsed ??
    (q.raw
      ? parseQuotaToon(q.raw)
      : { providers: [], attention: [], unsignedProviders: [], help: [] });
  const quotaIds = new Set(parsed.providers.map((p) => p.provider.toLowerCase()));
  const lanes = await apiLanesHtml(quotaIds);

  if (q.loading && !q.ok) {
    return `<div class="stack">
      <p class="muted">Loading subscription usage…</p>
      ${lanes}
    </div>`;
  }

  if (!q.ok && !parsed.providers.length) {
    return `<div class="stack">
      <details class="fold">
        <summary>${escapeHtml(q.error ?? "usage unavailable")}</summary>
        <pre>${escapeHtml(q.raw.slice(0, 4000))}</pre>
      </details>
      ${lanes}
    </div>`;
  }

  const cards = parsed.providers.map(providerCardHtml).join("");

  const unsignedMap = new Map<string, string>();
  for (const u of parsed.unsignedProviders ?? []) {
    if (!unsignedMap.has(u.provider)) unsignedMap.set(u.provider, u.reason);
  }
  for (const a of parsed.attention) {
    if (a.remedy && a.remedy !== "none") continue;
    if (!a.provider) continue;
    if (unsignedMap.has(a.provider)) continue;
    const reason =
      a.kind === "auth_required" ? "sign-in required" : a.detail || a.kind || "attention";
    unsignedMap.set(a.provider, reason);
  }
  const unsignedEntries = [...unsignedMap.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const unsignedCollapse =
    unsignedEntries.length > 0
      ? `<details class="fold">
      <summary>${unsignedEntries.length} provider${unsignedEntries.length === 1 ? "" : "s"} without an account</summary>
      <ul class="meter-list">${unsignedEntries
        .map(
          ([name, reason]) =>
            `<li><span class="sheet-title">${escapeHtml(name)}</span><span class="muted">${escapeHtml(reason)}</span></li>`,
        )
        .join("")}</ul>
    </details>`
      : "";

  const help = parsed.help.map((h) => `<p class="muted">${escapeHtml(h)}</p>`).join("");

  const staleNote = q.stale
    ? `<p class="warn">Usage may be stale. Last successful read kept.</p>`
    : "";

  const emptyMsg =
    !cards && parsed.parseError
      ? `<p class="warn">${escapeHtml(parsed.parseError)}</p>`
      : !cards
        ? `<p class="muted">No subscribed providers in quota output.</p>`
        : "";

  return `<div class="stack">
    <div class="between">
      <h3>Subscription usage</h3>
      <span class="muted">Updated ${escapeHtml(q.at ? new Date(q.at).toLocaleString() : "—")}</span>
    </div>
    ${staleNote}
    ${emptyMsg}
    <div class="grid-3">${cards}</div>
    ${lanes}
    ${unsignedCollapse}
    ${help}
    ${parsed.parseError && cards ? `<p class="warn">${escapeHtml(parsed.parseError)}</p>` : ""}
    <details class="fold"><summary>Raw output</summary><pre>${escapeHtml(q.raw.slice(0, 6000))}</pre></details>
  </div>`;
}
