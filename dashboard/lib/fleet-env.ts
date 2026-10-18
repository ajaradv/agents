import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { readServiceAccountKeys } from "./op-sdk.ts";
import { ROOT } from "./paths.ts";

const FLEET_ENV_PATH = join(ROOT, "fleet", "home", ".env");
const READ_TIMEOUT_MS = 2000;

/**
 * The service account is the fleet's key path once fleet/home/.env.op exists:
 * reading the fleet/home/.env mount asks the 1Password app, which prompts the
 * captain. The mount is read only without a service account, or with
 * FLEET_ENV_MOUNT=1.
 */
export function mountAllowed(): boolean {
  return process.env.FLEET_ENV_MOUNT === "1" || !existsSync(process.env.FLEET_OP_ENV_FILE || join(ROOT, "fleet", "home", ".env.op"));
}

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

/** The fleet's keys: the service account when set up, else fleet/home/.env (FIFO, with a timeout). */
export async function loadFleetDotenv(): Promise<Record<string, string>> {
  if (!mountAllowed()) return serviceAccountEnv();
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

/** Keys only the node uses (never handed to an agent): the free Gemini account for the free lanes. */
const NODE_KEYS = ["GEMINI_FREE_API_KEY"];

/** Every secret the fleet holds; stripped from a child's inherited environment before adding what it needs. */
export function withoutSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !AGENT_KEYS.includes(k) && !NODE_KEYS.includes(k)));
}

/** A key only the node uses (NODE_KEYS), from the service account; "" when not set. */
export async function nodeKey(name: (typeof NODE_KEYS)[number]): Promise<string> {
  return (process.env[name] ?? (await serviceAccountEnv())[name] ?? "").trim();
}

let saCache: { at: number; keys: Record<string, string> } | null = null;

/** Keys read with the 1Password service account (the SDK, lib/op-sdk.ts); cached 10 minutes. Empty when not set up. */
export async function serviceAccountEnv(): Promise<Record<string, string>> {
  if (saCache && Date.now() - saCache.at < 10 * 60_000) return { ...saCache.keys };
  // One read at a time: callers arriving together share it.
  saPending ??= readServiceAccount().finally(() => (saPending = null));
  return { ...(await saPending) };
}

let saPending: Promise<Record<string, string>> | null = null;

async function readServiceAccount(): Promise<Record<string, string>> {
  // Tests never read real keys: only a test's own secrets command (FLEET_SECRETS_CMD).
  if (process.env.NODE_ENV === "test") return process.env.FLEET_SECRETS_CMD ? readSecretsCommand(process.env.FLEET_SECRETS_CMD) : {};
  let keys: Record<string, string> = {};
  try {
    keys = await readServiceAccountKeys();
  } catch {
    /* kept below */
  }
  if (Object.keys(keys).length) saCache = { at: Date.now(), keys };
  // A failed read keeps the last good keys rather than falling back to the mount.
  return Object.keys(keys).length ? keys : { ...(saCache?.keys ?? {}) };
}

async function readSecretsCommand(cmd: string): Promise<Record<string, string>> {
  const proc = Bun.spawn([cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const keys = parseEnvLines(await new Response(proc.stdout).text());
  if (Object.keys(keys).length) saCache = { at: Date.now(), keys };
  return keys;
}

export function _resetServiceAccountForTests(): void {
  saCache = null;
  saPending = null;
}

export async function agentKeyEnv(): Promise<Record<string, string>> {
  // The service account (no 1Password prompt); the fleet/home/.env mount only where mountAllowed().
  const sa = await serviceAccountEnv();
  let dotenv: Record<string, string> = {};
  if (mountAllowed() && !AGENT_KEYS.filter((k) => k !== "HF_TOKEN" && k !== "ANTHROPIC_API_KEY").every((k) => sa[k] || process.env[k])) {
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
