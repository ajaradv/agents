import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fleetInboxRoot } from "./paths.ts";

const MAX_LINE = 400;

export async function dashLog(event: string, detail = ""): Promise<void> {
  const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail.slice(0, MAX_LINE)}` : ""}\n`;
  try {
    const dir = fleetInboxRoot();
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "dashboard.log"), line, "utf8");
  } catch {
    /* ignore */
  }
  console.error(`[dashboard] ${event}${detail ? ` ${detail}` : ""}`);
}
