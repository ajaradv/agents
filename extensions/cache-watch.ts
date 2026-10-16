/**
 * cache-watch: make prompt caching measurable, and stop the loops that burn it.
 *
 * Prefix caching only pays if the start of every request is byte-identical:
 * the system prompt, then the tool definitions, then the history. Pi keeps its
 * system prompt static (no date; a changed section is appended later, not
 * rewritten in place), so the remaining risks are ours: a tool set that
 * changes, an extension that edits earlier messages, a provider that does not
 * cache. This extension
 *
 * 1. hashes the static prefix (system prompt + the active tools' names,
 *    descriptions, and schemas, sorted and serialized with sorted keys) at
 *    every model reply, and warns when it changes mid-session;
 * 2. reads the provider's usage on every reply and warns when the prefix hash
 *    is unchanged, the previous reply was recent enough to still be cached
 *    (FLEET_CACHE_TTL_SECS, default 300), the request was big enough to cache,
 *    and the provider still reported no cache reads: a cache bug;
 * 3. blocks the third identical read (same read-style tool, same arguments)
 *    with nothing changed in between, and tells the agent the result is
 *    already in its context. A designer once re-read the same screenshots in a
 *    loop until its credits ran out. Any edit, write, or shell command resets
 *    the count (the world may have changed), so re-reading after a change and
 *    re-running tests stay allowed.
 *
 * Warnings go out as notices, which the fleet node writes to the ship's log.
 * Providers that never cache (Cursor replays sessions) are skipped for (2).
 * bin/launch loads this for every assistant.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const TTL_MS = Math.max(30, Number(process.env.FLEET_CACHE_TTL_SECS) || 300) * 1000;
/** Below this many prompt tokens providers do not cache at all. */
const MIN_CACHEABLE = 2048;
const REPEAT_LIMIT = Math.max(2, Number(process.env.FLEET_REPEAT_LIMIT) || 2);
const NO_CACHE_PROVIDERS = new Set(["cursor"]);

/** Tools that only look: the same call twice with nothing changed in between returns the same thing. */
export function isReadTool(name: string): boolean {
  return /^(read|grep|find|ls|glob|view_image)$/.test(name) || /^obsidian_(read|search|list)/.test(name) || /_(read|status|log|tasks|maneuvers)$/.test(name);
}

/** JSON with sorted object keys and no whitespace, so the same value always serializes the same way. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Hash of the static prefix: system prompt, then the active tools sorted by name. */
export function prefixHash(systemPrompt: string, tools: { name: string; description?: string; parameters?: unknown }[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? null }));
  return createHash("sha256").update(systemPrompt).update("\u0000").update(stableJson(sorted)).digest("hex").slice(0, 16);
}

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };

/** Is this reply a cache bug? Same prefix, recent previous reply, big request, zero cache reads. */
export function cacheMiss(
  prev: { hash: string; at: number } | null,
  cur: { hash: string; at: number; provider: string; usage: Usage; caches: boolean },
  ttlMs = TTL_MS,
): boolean {
  // Only a model that caches can miss: its price list has a cache rate, or it read from cache earlier.
  if (!prev || !cur.caches || NO_CACHE_PROVIDERS.has(cur.provider)) return false;
  if (prev.hash !== cur.hash || cur.at - prev.at > ttlMs) return false;
  const u = cur.usage;
  const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return prompt >= MIN_CACHEABLE && (u.cacheRead ?? 0) === 0;
}

export default function (pi: ExtensionAPI) {
  let last: { hash: string; at: number } | null = null;
  /** Caching seen working in this session (some reply read from cache). */
  let cacheSeen = false;
  const calls = new Map<string, number>();

  const currentHash = (ctx: ExtensionContext): string | null => {
    try {
      const active = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter((t) => active.has(t.name));
      return prefixHash(ctx.getSystemPrompt(), tools);
    } catch {
      return null;
    }
  };

  pi.on("agent_start", async () => {
    calls.clear();
  });

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as { role?: string; provider?: string; usage?: Usage };
    if (msg?.role !== "assistant" || !msg.usage) return;
    const hash = currentHash(ctx);
    if (!hash) return;
    const now = Date.now();
    const provider = String(msg.provider ?? ctx.model?.provider ?? "");
    if (last && last.hash !== hash && ctx.hasUI) {
      ctx.ui.notify("Prompt prefix changed (system prompt or tools): the next request pays full price once.", "warning");
    }
    const priced = Number((ctx.model as { cost?: { cacheRead?: number } } | undefined)?.cost?.cacheRead ?? 0) > 0;
    if (cacheMiss(last, { hash, at: now, provider, usage: msg.usage, caches: priced || cacheSeen }) && ctx.hasUI) {
      const tokens = (msg.usage.input ?? 0) + (msg.usage.cacheWrite ?? 0);
      ctx.ui.notify(`Cache miss: same prompt prefix as ${Math.round((now - last!.at) / 1000)}s ago, but ${provider} read nothing from cache (${tokens} tokens at full price). Treat as a bug.`, "warning");
    }
    if ((msg.usage.cacheRead ?? 0) > 0) cacheSeen = true;
    last = { hash, at: now };
  });

  pi.on("tool_call", async (event) => {
    const e = event as { toolName?: string; input?: unknown; parentToolCallId?: string };
    if (!e.toolName || e.parentToolCallId) return;
    if (!isReadTool(e.toolName)) {
      calls.clear(); // something may have changed: earlier reads are not repeats any more
      return;
    }
    const key = `${e.toolName}\u0000${stableJson(e.input ?? {})}`;
    const n = (calls.get(key) ?? 0) + 1;
    calls.set(key, n);
    if (n > REPEAT_LIMIT) {
      return {
        block: true,
        reason: `You already called ${e.toolName} with these exact arguments ${n - 1} times in this run; the result is in your context above. Use it instead of calling again. If you truly need fresh data, change the arguments or say why.`,
      };
    }
  });
}
