import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import type { ApiLaneUsage } from "./api-lane-usage.ts";
import { huggingFaceKeyPresent, loadFleetDotenv, envKeyPresent } from "./fleet-env.ts";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ApiLane = {
  provider: string;
  label: string;
  keyEnv: string;
  keySet: boolean;
  note?: string;
  usage?: ApiLaneUsage;
};

const LANE_META: Record<
  string,
  { label: string; keyEnv: string; configFiles?: string[] }
> = {
  deepseek: {
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    configFiles: ["fleet/config/pi-deepseek-provider.json"],
  },
  huggingface: {
    label: "Hugging Face",
    keyEnv: "HF_API_KEY",
    configFiles: ["fleet/config/pi-huggingface-provider.json"],
  },
  openrouter: {
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
  },
};

function collectProvidersFromDispatch(j: Record<string, unknown>): Set<string> {
  const found = new Set<string>();
  const scan = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const item of entries) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.provider === "string") found.add(o.provider.toLowerCase());
      if (Array.isArray(o.use)) scan(o.use);
    }
  };
  if (Array.isArray(j.rules)) {
    for (const rule of j.rules) {
      if (rule && typeof rule === "object") scan((rule as { use?: unknown }).use);
    }
  }
  scan(j.default);
  return found;
}

async function providerInPiCatalog(provider: string): Promise<boolean> {
  const meta = LANE_META[provider];
  if (!meta?.configFiles?.length) return false;
  for (const rel of meta.configFiles) {
    try {
      const raw = await readFile(join(ROOT, rel), "utf8");
      const j = JSON.parse(raw) as { providers?: Record<string, unknown> };
      if (j.providers && provider in j.providers) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function readConfiguredApiLanes(
  quotaProviderIds: Set<string>,
  usageByProvider: Record<string, ApiLaneUsage> = {},
): Promise<ApiLane[]> {
  const dotenv = await loadFleetDotenv();
  let dispatchProviders = new Set<string>();
  try {
    const raw = await readFile(join(ROOT, "fleet", "config", "crew-dispatch.json"), "utf8");
    dispatchProviders = collectProvidersFromDispatch(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    /* no dispatch */
  }

  const lanes: ApiLane[] = [];
  for (const provider of ["deepseek", "huggingface", "openrouter"] as const) {
    if (quotaProviderIds.has(provider)) continue;
    const meta = LANE_META[provider]!;
    const inDispatch = dispatchProviders.has(provider);
    const inCatalog =
      provider === "openrouter" ? inDispatch : await providerInPiCatalog(provider);
    if (!inDispatch && !inCatalog) continue;
    const keySet =
      provider === "huggingface"
        ? huggingFaceKeyPresent(dotenv)
        : envKeyPresent(meta.keyEnv, dotenv);
    const usage = usageByProvider[provider];
    const note =
      provider === "huggingface"
        ? "Configured API lane — no personal remaining-credits API"
        : usage?.ok
          ? undefined
          : usage?.error
            ? usage.error
            : "Configured API lane — fetching vendor usage";
    lanes.push({
      provider,
      label: meta.label,
      keyEnv: meta.keyEnv,
      keySet,
      note,
      usage,
    });
  }
  return lanes;
}

export function apiLaneCardHtml(lane: ApiLane): string {
  const keyBadge = lane.keySet
    ? `<span class="detent detent-ok">key set</span>`
    : `<span class="detent detent-warn">key not set</span>`;
  const usage = lane.usage;
  const headline = usage?.ok && usage.headline ? `<p>${escapeHtml(usage.headline)}</p>` : "";
  const detail = usage?.ok && usage.detail ? `<p class="muted">${escapeHtml(usage.detail)}</p>` : "";
  const stale = usage?.stale ? `<p class="warn">Usage may be stale</p>` : "";
  const note = lane.note ? `<p class="muted">${escapeHtml(lane.note)}</p>` : "";
  return `<article class="sheet">
      <div class="between">
        <h3>${escapeHtml(lane.label)}</h3>
        ${keyBadge}
      </div>
      ${headline}
      ${detail}
      ${stale}
      ${note}
      <p class="muted">${escapeHtml(lane.keyEnv)}</p>
    </article>`;
}
