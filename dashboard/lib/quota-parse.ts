export type QuotaWindowRow = {
  id: string;
  label: string;
  percentRemaining: number;
  resetsAt?: string;
};

export type QuotaScopeRow = {
  scope: string;
  percentRemaining: number;
  boundedBy: string[];
  runway?: string;
};

export type ProviderCard = {
  provider: string;
  plan?: string;
  headlinePercent: number;
  headlineScope?: string;
  runway?: string;
  windows: QuotaWindowRow[];
  scopes: QuotaScopeRow[];
  notes: string[];
};

export type AttentionRow = {
  provider: string;
  scope: string;
  kind: string;
  detail: string;
  remedy: string;
};

export type UnsignedProvider = {
  provider: string;
  reason: string;
};

export type ParsedQuota = {
  generatedAt?: string;
  providers: ProviderCard[];
  attention: AttentionRow[];
  unsignedProviders: UnsignedProvider[];
  help: string[];
  parseError?: string;
};

/** @deprecated legacy flat row; used only while parsing TOON tables */
export type QuotaRow = {
  provider: string;
  scope: string;
  effectivePercentRemaining: number;
  spendPriority: string;
  runway: string;
  confidence: string;
  limitedBy: string;
  resetsAt: string;
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function runwayFromUnknown(runway: unknown): string {
  if (typeof runway === "string") return runway;
  if (runway && typeof runway === "object" && "status" in runway) {
    return String((runway as { status: string }).status);
  }
  return "";
}

function isSubscribedProvider(p: Record<string, unknown>): boolean {
  if (p.notSetUp === true) return false;
  const semantics = p.quotaSemantics as
    | { status?: string; effectiveAvailability?: unknown[] }
    | undefined;
  const windows = p.windows;
  const eff = semantics?.effectiveAvailability ?? [];
  if (Array.isArray(eff) && eff.length > 0) return true;
  if (Array.isArray(windows) && windows.length > 0) return true;
  if (semantics?.status === "known") return true;
  const state = p.state as { status?: string } | undefined;
  if (state?.status === "fresh" && Array.isArray(windows) && windows.length > 0) {
    return true;
  }
  return false;
}

function providerCardFromJsonEntry(p: Record<string, unknown>): ProviderCard {
  const provider = String(p.provider ?? "unknown");
  const plan = typeof p.plan === "string" ? p.plan : undefined;
  const notes: string[] = [];
  const state = p.state as { status?: string; error?: string } | undefined;
  if (state?.status === "auth_required" && state.error) {
    notes.push(state.error);
  }

  const windows: QuotaWindowRow[] = [];
  if (Array.isArray(p.windows)) {
    for (const w of p.windows) {
      if (!w || typeof w !== "object") continue;
      const o = w as Record<string, unknown>;
      windows.push({
        id: String(o.id ?? ""),
        label: String(o.label ?? o.id ?? ""),
        percentRemaining: num(o.percentRemaining),
        resetsAt: typeof o.resetsAt === "string" ? o.resetsAt : undefined,
      });
    }
  }

  const scopes: QuotaScopeRow[] = [];
  const semantics = p.quotaSemantics as
    | { effectiveAvailability?: unknown[] }
    | undefined;
  if (Array.isArray(semantics?.effectiveAvailability)) {
    for (const s of semantics.effectiveAvailability) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      const boundedBy = Array.isArray(o.boundedBy)
        ? o.boundedBy.map(String)
        : [];
      scopes.push({
        scope: String(o.scope ?? "all_models"),
        percentRemaining: num(o.effectivePercentRemaining),
        boundedBy,
        runway: runwayFromUnknown(o.runway),
      });
    }
  }

  let headlinePercent = 100;
  let headlineScope: string | undefined;
  let runway: string | undefined;

  const allModel = scopes.find((s) => s.scope === "all_models") ?? scopes[0];
  if (allModel) {
    headlinePercent = allModel.percentRemaining;
    headlineScope = allModel.scope;
    runway = allModel.runway;
  } else if (windows.length > 0) {
    headlinePercent = Math.min(...windows.map((w) => w.percentRemaining));
    headlineScope = windows.find((w) => w.percentRemaining === headlinePercent)?.id;
  }

  if (scopes.length > 1) {
    const worst = scopes.reduce((a, b) =>
      a.percentRemaining <= b.percentRemaining ? a : b,
    );
    if (worst.percentRemaining < headlinePercent) {
      headlinePercent = worst.percentRemaining;
      headlineScope = worst.scope;
      runway = worst.runway ?? runway;
    }
  }

  return {
    provider,
    plan,
    headlinePercent,
    headlineScope,
    runway,
    windows,
    scopes,
    notes,
  };
}

function unsignedReason(p: Record<string, unknown>): string {
  const state = p.state as { status?: string } | undefined;
  if (state?.status === "auth_required") return "sign-in required";
  if (p.notSetUp === true) return "no account";
  return "not subscribed";
}

function attentionFromProvider(p: Record<string, unknown>): AttentionRow[] {
  const provider = String(p.provider ?? "");
  const state = p.state as { status?: string; error?: string } | undefined;
  if (state?.status === "auth_required" && state.error) {
    return [
      {
        provider,
        scope: "",
        kind: "auth_required",
        detail: state.error,
        remedy: "none",
      },
    ];
  }
  return [];
}

export function parseQuotaFromJson(raw: string): ParsedQuota | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== "object") return null;

    const help: string[] = [];
    if (Array.isArray(j.help)) {
      for (const h of j.help) {
        if (typeof h === "string") help.push(h);
      }
    }

    const attention: AttentionRow[] = [];
    const unsignedProviders: UnsignedProvider[] = [];
    const providers: ProviderCard[] = [];
    let rawProviderCount = 0;
    let hadMeasurableWindows = false;

    if (Array.isArray(j.providers)) {
      rawProviderCount = j.providers.length;
      for (const item of j.providers) {
        if (!item || typeof item !== "object") continue;
        const p = item as Record<string, unknown>;
        if (Array.isArray(p.windows) && p.windows.length > 0) {
          hadMeasurableWindows = true;
        }
        if (!isSubscribedProvider(p)) {
          attention.push(...attentionFromProvider(p));
          unsignedProviders.push({
            provider: String(p.provider ?? "unknown"),
            reason: unsignedReason(p),
          });
          continue;
        }
        providers.push(providerCardFromJsonEntry(p));
      }
    }

    if (Array.isArray(j.attention)) {
      for (const a of j.attention) {
        if (!a || typeof a !== "object") continue;
        const o = a as Record<string, unknown>;
        attention.push({
          provider: String(o.provider ?? ""),
          scope: String(o.scope ?? ""),
          kind: String(o.kind ?? ""),
          detail: String(o.detail ?? ""),
          remedy: String(o.remedy ?? ""),
        });
      }
    }

    let parseError: string | undefined;
    if (providers.length === 0 && hadMeasurableWindows && rawProviderCount > 0) {
      parseError =
        "Could not map subscribed providers from quota JSON (membership empty).";
    }

    return {
      generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : undefined,
      providers,
      attention,
      unsignedProviders,
      help,
      parseError,
    };
  } catch {
    return null;
  }
}

/** Split a CSV row respecting double-quoted fields. */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (c === "," && !inQuote) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseTableBlock(
  lines: string[],
  startIdx: number,
  headerMatch: RegExpMatchArray,
): { rows: string[][]; nextIdx: number } {
  const cols = headerMatch[3]!.split(",").map((c) => c.trim());
  const count = Number(headerMatch[2]);
  const rows: string[][] = [];
  let i = startIdx + 1;
  while (i < lines.length && rows.length < count) {
    const line = lines[i]!.trim();
    if (!line) {
      i++;
      continue;
    }
    if (/^\w+\[\d+\]\{/.test(line)) break;
    rows.push(splitCsvRow(line));
    i++;
  }
  void cols;
  return { rows, nextIdx: i };
}

function providerCardsFromToonRows(quotaRows: QuotaRow[]): ProviderCard[] {
  const byProvider = new Map<string, QuotaRow[]>();
  for (const r of quotaRows) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  const cards: ProviderCard[] = [];
  for (const [provider, rows] of byProvider) {
    const scopes: QuotaScopeRow[] = rows.map((r) => ({
      scope: r.scope,
      percentRemaining: r.effectivePercentRemaining,
      boundedBy: r.limitedBy
        .split("+")
        .map((s) => s.trim())
        .filter(Boolean),
      runway: r.runway,
    }));
    const headline = scopes.reduce((a, b) =>
      a.percentRemaining <= b.percentRemaining ? a : b,
    );
    cards.push({
      provider,
      headlinePercent: headline.percentRemaining,
      headlineScope: headline.scope,
      runway: headline.runway,
      windows: [],
      scopes,
      notes: [],
    });
  }
  return cards;
}

export function parseQuotaToon(raw: string): ParsedQuota {
  const quotaRows: QuotaRow[] = [];
  const result: ParsedQuota = {
    providers: [],
    attention: [],
    unsignedProviders: [],
    help: [],
  };
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("generatedAt:")) {
      result.generatedAt = line
        .split(":")
        .slice(1)
        .join(":")
        .trim()
        .replace(/^["']|["']$/g, "");
      continue;
    }
    const helpOnly = line.match(/^help\[(\d+)\]:$/);
    if (helpOnly) {
      const count = Number(helpOnly[1]);
      let n = 0;
      for (let j = i + 1; j < lines.length && n < count; j++) {
        const hl = lines[j]!.trim();
        if (!hl) continue;
        if (/^\w+\[\d+\]/.test(hl)) break;
        result.help.push(hl);
        n++;
        i = j;
      }
      continue;
    }
    const m = line.match(/^(\w+)\[(\d+)\]\{([^}]+)\}:$/);
    if (!m) continue;
    const name = m[1];
    const { rows, nextIdx } = parseTableBlock(lines, i, m);
    i = nextIdx - 1;
    if (name === "quota") {
      for (const r of rows) {
        if (r.length < 8) continue;
        quotaRows.push({
          provider: r[0]!,
          scope: r[1]!,
          effectivePercentRemaining: Number(r[2]),
          spendPriority: r[3]!,
          runway: r[4]!,
          confidence: r[5]!,
          limitedBy: r[6]!,
          resetsAt: r[7]!.replace(/^["']|["']$/g, ""),
        });
      }
    } else if (name === "attention") {
      for (const r of rows) {
        if (r.length < 5) continue;
        result.attention.push({
          provider: r[0]!,
          scope: r[1]!,
          kind: r[2]!,
          detail: r[3]!,
          remedy: r[4]!,
        });
      }
    } else if (name === "help") {
      for (const r of rows) {
        if (r[0]) result.help.push(r[0]);
      }
    }
  }
  result.providers = providerCardsFromToonRows(quotaRows);
  return result;
}
