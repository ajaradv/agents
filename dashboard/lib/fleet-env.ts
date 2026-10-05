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
    return parseEnvLines(text);
  } catch {
    return {};
  }
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
