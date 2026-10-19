import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { agentKeyEnv } from "./fleet-env.ts";

/**
 * Crew eyes (vault task fleet-subagent-browser-helpers): a vision model looks
 * at screenshots and answers a question about them, so a crewmate whose own
 * model cannot see (DeepSeek) can still check its UI work. Used by the crew
 * `look` tool (through the node, which holds the keys) and bin/fleet-look.
 *
 * Model: Claude Haiku 5.5 through OpenRouter (cheap, good at UI judgment;
 * prompts are not used for training), FLEET_LOOK_MODEL to change it.
 */

export const LOOK_MODEL = process.env.FLEET_LOOK_MODEL ?? "anthropic/claude-haiku-5.5";
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const MAX_BYTES = 8 * 1024 * 1024;

export type LookResult = { ok: boolean; answer: string; model: string; cost: number; ms: number; error?: string };

/** Images a caller may show: PNG, JPEG, or WebP files under one of `roots`, at most 8 MB, up to 4. */
export function checkImages(paths: string[], roots: string[]): { ok: true; files: { path: string; type: string }[] } | { ok: false; message: string } {
  if (!paths.length) return { ok: false, message: "Give at least one image path (a screenshot from bin/fleet-shot)." };
  if (paths.length > 4) return { ok: false, message: "At most 4 images per look." };
  const allowed = roots.filter((r) => existsSync(r)).map((r) => realpathSync(r));
  const files: { path: string; type: string }[] = [];
  for (const p of paths) {
    const type = TYPES[extname(p).toLowerCase()];
    if (!type) return { ok: false, message: `${p} is not a PNG, JPEG, or WebP image.` };
    if (!existsSync(p)) return { ok: false, message: `${p} does not exist.` };
    const real = realpathSync(resolve(p));
    if (allowed.length && !allowed.some((r) => real === r || real.startsWith(`${r}/`))) return { ok: false, message: `${p} is outside the folders a look may read (${roots.join(", ")}).` };
    if (statSync(real).size > MAX_BYTES) return { ok: false, message: `${p} is over 8 MB.` };
    files.push({ path: real, type });
  }
  return { ok: true, files };
}

/** Ask the vision model `question` about the images. */
export async function lookAt(files: { path: string; type: string }[], question: string, fetchImpl: typeof fetch = fetch): Promise<LookResult> {
  const started = Date.now();
  if (process.env.NODE_ENV === "test" && fetchImpl === fetch) return { ok: false, answer: "", model: LOOK_MODEL, cost: 0, ms: 0, error: "no real model calls in tests" };
  const key = (await agentKeyEnv()).OPENROUTER_API_KEY;
  if (!key) return { ok: false, answer: "", model: LOOK_MODEL, cost: 0, ms: 0, error: "no OpenRouter key from the service account" };
  const content = [
    { type: "text", text: `${question.trim()}\n\nAnswer plainly and specifically about what is visible: name elements, their text, colours, and positions; say when something you were asked about is not visible. Do not guess beyond the image.` },
    ...files.map((f) => ({ type: "image_url", image_url: { url: `data:${f.type};base64,${readFileSync(f.path).toString("base64")}` } })),
  ];
  try {
    const r = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: LOOK_MODEL, messages: [{ role: "user", content }], max_tokens: 1600, usage: { include: true }, provider: { data_collection: "deny" } }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await r.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number }; error?: { message?: string } } | null;
    const answer = String(body?.choices?.[0]?.message?.content ?? "").trim();
    if (!r.ok || !answer) return { ok: false, answer: "", model: LOOK_MODEL, cost: Number(body?.usage?.cost) || 0, ms: Date.now() - started, error: body?.error?.message ?? `HTTP ${r.status}` };
    return { ok: true, answer, model: LOOK_MODEL, cost: Number(body?.usage?.cost) || 0, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, answer: "", model: LOOK_MODEL, cost: 0, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}
