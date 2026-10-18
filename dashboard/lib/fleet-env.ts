import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.ts";

const FLEET_ENV_PATH = join(ROOT, "fleet", "home", ".env");
const READ_TIMEOUT_MS = 2000;

/** Parse KEY=value lines; never log values. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let body = line.startsWith("export ") ? line.slice(7).trim() : line;
    if (!body.includes("=")) continue;
    const key = body.slice(0, body.indexOf("=")).trim();
    let val = body.slice(body.indexOf("=") + 1).trim();
    if (val.length >= 2 && val[0] === val.at(-1) && (val[0] === '"' || val[0] === "'")) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

async function readFifoEnv(timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["cat", FLEET_ENV_PATH], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return stdout;
  } catch {
    proc.kill();
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Load fleet/home/.env with FIFO timeout; merge into a copy of process.env keys only. */
export async function loadFleetDotenv(): Promise<Record<string, string>> {
  try {
    const st = await stat(FLEET_ENV_PATH);
    let text = "";
    if (st.isFIFO?.() || st.isSocket?.()) {
      text = await readFifoEnv(READ_TIMEOUT_MS);
    } else if (st.isFile?.()) {
      text = await readFile(FLEET_ENV_PATH, "utf8");
    } else {
      return {};
    }
    const parsed = parseEnvLines(text);
    // The secrets manager's pipe serves one reader at a time and can come back
    // empty; fall back to the last read that had keys.
    if (Object.keys(parsed).length) lastGood = parsed;
    return { ...(Object.keys(parsed).length ? parsed : lastGood) };
  } catch {
    return { ...lastGood };
  }
}

let lastGood: Record<string, string> = {};

/** Keys bin/launch exports to agents (its ENV_ALLOWLIST). */
const AGENT_KEYS = [
  "TYPESAFE_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "HF_API_KEY",
  "HF_TOKEN",
  "CURSOR_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
];

/**
 * Provider keys to hand an agent process directly, so a launch never depends on
 * the pipe answering in that moment (bin/launch keeps keys already in its env).
 * Retries an empty read once before giving up.
 */
/** Provider of a model id → its key (keep in step with PROVIDER_KEYS in bin/launch). */
const PROVIDER_KEYS: Record<string, string> = { cursor: "CURSOR_API_KEY", deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GEMINI_API_KEY" };

/** Only the keys these models need (R4c), e.g. a helper on deepseek/... gets DEEPSEEK_API_KEY alone. */
export function keysForModels(all: Record<string, string>, models: string[]): Record<string, string> {
  const need = new Set(models.map((m) => PROVIDER_KEYS[m.split("/")[0] ?? ""]).filter(Boolean));
  return Object.fromEntries(Object.entries(all).filter(([k]) => need.has(k)));
}

/** Every secret the fleet hands out; stripped from a child's inherited environment before adding what it needs. */
export function withoutSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !AGENT_KEYS.includes(k)));
}

let saCache: { at: number; keys: Record<string, string> } | null = null;

/** Keys read with the 1Password service account (bin/fleet-secrets); cached 10 minutes. Empty when not set up. */
export async function serviceAccountEnv(): Promise<Record<string, string>> {
  if (saCache && Date.now() - saCache.at < 10 * 60_000) return { ...saCache.keys };
  try {
    const proc = Bun.spawn([join(ROOT, "bin", "fleet-secrets")], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    const keys = Object.fromEntries(Object.entries(parseEnvLines(text)).filter(([, v]) => v && !v.startsWith("op://")));
    if (Object.keys(keys).length) saCache = { at: Date.now(), keys };
    return keys;
  } catch {
    return {};
  }
}

export async function agentKeyEnv(): Promise<Record<string, string>> {
  // The service account first (works while 1Password is locked), the fleet/home/.env mount for the rest.
  const sa = await serviceAccountEnv();
  let dotenv: Record<string, string> = {};
  if (!AGENT_KEYS.filter((k) => k !== "HF_TOKEN" && k !== "ANTHROPIC_API_KEY").every((k) => sa[k] || process.env[k])) {
    dotenv = await loadFleetDotenv();
    if (!Object.keys(dotenv).length && !Object.keys(sa).length) {
      await Bun.sleep(500);
      dotenv = await loadFleetDotenv();
    }
  }
  dotenv = { ...dotenv, ...sa };
  applyHfKeyAlias(dotenv);
  const out: Record<string, string> = {};
  for (const k of AGENT_KEYS) {
    const v = (process.env[k] ?? dotenv[k] ?? "").trim();
    if (v) out[k] = v;
  }
  return out;
}

export function applyHfKeyAlias(dotenv: Record<string, string>): void {
  const fromApi = dotenv.HF_API_KEY || process.env.HF_API_KEY;
  const fromToken = dotenv.HF_TOKEN || process.env.HF_TOKEN;
  if (fromApi && !fromToken) dotenv.HF_TOKEN = fromApi;
  if (fromToken && !fromApi) dotenv.HF_API_KEY = fromToken;
}

export function envKeyValue(key: string, dotenv: Record<string, string>): string {
  applyHfKeyAlias(dotenv);
  const v = process.env[key] ?? dotenv[key] ?? "";
  return v.trim();
}

export function envKeyPresent(key: string, dotenv: Record<string, string>): boolean {
  return envKeyValue(key, dotenv).length > 0;
}

/** Hugging Face: prefer HF_API_KEY for display; either name counts as set. */
export function huggingFaceKeyPresent(dotenv: Record<string, string>): boolean {
  applyHfKeyAlias(dotenv);
  return envKeyPresent("HF_API_KEY", dotenv) || envKeyPresent("HF_TOKEN", dotenv);
}
